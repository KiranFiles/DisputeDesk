import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AiError, triageDispute } from "./agent.js";
import { basicAuth } from "./auth.js";
import { config } from "./config.js";
import { PayPalError, type PayPalGateway } from "./gateway.js";
import { mockPayPal } from "./mock.js";
import { livePayPal } from "./paypal.js";

const pp: PayPalGateway = config.mockPayPal ? mockPayPal : livePayPal;
const MAX_AUDIT = 500;
const audit: { time: string; disputeId: string; action: string; detail: string }[] = [];
const inFlight = new Set<string>();

const log = (level: "info" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

const DisputeId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid dispute id");
const idOf = (req: Request) => DisputeId.parse(req.params.id);

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ACCEPT_CLAIM"),
    note: z.string().trim().min(1).max(2000),
    reason: z.enum(["REASON_NOT_SET", "NOT_ABLE_TO_WIN", "COMPANY_POLICY", "DID_NOT_SHIP_ITEM", "LOST_IN_MAIL"]).default("REASON_NOT_SET"),
  }),
  z.object({ action: z.literal("SEND_MESSAGE"), message: z.string().trim().min(1).max(2000) }),
  z.object({
    action: z.literal("PROVIDE_EVIDENCE"),
    notes: z.string().trim().min(1).max(2000),
    carrier: z.string().trim().max(100).nullish(),
    trackingNumber: z.string().trim().max(100).nullish(),
  }),
]);

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." },
  });

const route =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path === "/healthz") return;
    log("info", "request", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, id: randomUUID() });
  });
  next();
});
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { "upgrade-insecure-requests": null } } }));

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

if (config.authUser && config.authPassword) app.use(basicAuth(config.authUser, config.authPassword));

app.use("/api", limiter(120), express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    mockPayPal: config.mockPayPal,
    aiConfigured: Boolean(config.aiKey),
    provider: config.aiProvider,
    model: config.aiModel,
    maxAcceptAmount: config.maxAcceptAmount,
  });
});

app.get("/api/disputes", route(async (_req, res) => res.json(await pp.listDisputes())));

app.get("/api/disputes/:id", route(async (req, res) => res.json(await pp.getDispute(idOf(req)))));

app.post("/api/disputes/:id/triage", limiter(10), route(async (req, res) => res.json(await triageDispute(idOf(req), pp))));

app.post(
  "/api/disputes/:id/actions",
  limiter(20),
  route(async (req, res) => {
    const id = idOf(req);
    const body = ActionSchema.parse(req.body);

    if (inFlight.has(id)) throw new PayPalError(409, "Another action on this dispute is still in progress");
    inFlight.add(id);
    try {
      const dispute = await pp.getDispute(id);
      if (dispute.status === "RESOLVED") throw new PayPalError(409, "Dispute is already resolved");

      if (body.action === "ACCEPT_CLAIM" && Number(dispute.dispute_amount?.value ?? 0) > config.maxAcceptAmount) {
        throw new PayPalError(403, `Guardrail: accepting claims above ${config.maxAcceptAmount} must be done in the PayPal Resolution Center`);
      }

      let result;
      let detail: string;
      if (body.action === "ACCEPT_CLAIM") {
        result = await pp.acceptClaim(id, body.note, body.reason);
        detail = body.note;
      } else if (body.action === "SEND_MESSAGE") {
        result = await pp.sendMessage(id, body.message);
        detail = body.message;
      } else {
        const tracking = body.carrier && body.trackingNumber ? { carrier: body.carrier, trackingNumber: body.trackingNumber } : undefined;
        result = await pp.provideEvidence(id, body.notes, tracking);
        detail = body.notes;
      }

      const entry = { time: new Date().toISOString(), disputeId: id, action: body.action, detail };
      audit.unshift(entry);
      audit.length = Math.min(audit.length, MAX_AUDIT);
      log("info", "audit", entry);
      res.json({ result, dispute: await pp.getDispute(id) });
    } finally {
      inFlight.delete(id);
    }
  }),
);

app.get("/api/audit", (_req, res) => res.json(audit));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(clientDist, "index.html"));
  });
}

const CLIENT_SAFE_STATUS = new Set([400, 403, 404, 409, 422, 504]);

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", details: err.issues });
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "Malformed JSON" });
  if (err instanceof PayPalError) {
    log("error", "paypal_error", { path: req.path, status: err.status, details: err.details });
    return res.status(CLIENT_SAFE_STATUS.has(err.status) ? err.status : 502).json({ error: err.message });
  }
  if (err instanceof AiError) {
    log("error", "ai_error", { path: req.path, message: err.message, cause: String(err.cause) });
    return res.status(502).json({ error: err.message });
  }
  log("error", "unhandled", { path: req.path, message: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  log("info", "listening", { port: config.port, paypal: config.mockPayPal ? "mock" : config.paypalBase, auth: Boolean(config.authUser), production: config.production });
});

const shutdown = (signal: string) => {
  log("info", "shutting_down", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

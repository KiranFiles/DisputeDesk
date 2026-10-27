import { config } from "./config.js";
import { PayPalError, type AcceptReason, type Json, type PayPalGateway } from "./gateway.js";

const TIMEOUT_MS = 15_000;

let cached: { value: string; expiresAt: number } | null = null;
let pendingToken: Promise<string> | null = null;

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new PayPalError(504, timedOut ? "PayPal request timed out" : "Could not reach PayPal", err);
  }
}

async function fetchToken(): Promise<string> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await send(`${config.paypalBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new PayPalError(502, "PayPal authentication failed", body);
  cached = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.value;
}

function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return Promise.resolve(cached.value);
  pendingToken ??= fetchToken().finally(() => (pendingToken = null));
  return pendingToken;
}

async function request(method: string, path: string, body?: BodyInit | Json, retried = false): Promise<Json> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getAccessToken()}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await send(`${config.paypalBase}${path}`, { method, headers, body: payload });
  if (res.status === 401 && !retried) {
    cached = null;
    return request(method, path, body, true);
  }
  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? (JSON.parse(text) as Json) : {};
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new PayPalError(res.status, data.message ?? `PayPal ${method} ${path} failed`, data);
  return data;
}

const DAY = 86_400_000;

export const livePayPal: PayPalGateway = {
  async listDisputes() {
    const data = await request("GET", "/v1/customer/disputes?page_size=50");
    return data.items ?? [];
  },

  getDispute: (id) => request("GET", `/v1/customer/disputes/${encodeURIComponent(id)}`),

  async getTransaction(transactionId, disputeCreatedAt) {
    // Transaction Search allows at most a 31-day window.
    const end = new Date(disputeCreatedAt);
    const start = new Date(end.getTime() - 30 * DAY);
    const q = new URLSearchParams({
      transaction_id: transactionId,
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      fields: "all",
    });
    const data = await request("GET", `/v1/reporting/transactions?${q}`);
    return data.transaction_details?.[0] ?? null;
  },

  acceptClaim: (id, note, reason: AcceptReason) =>
    request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, {
      note,
      accept_claim_reason: reason,
      accept_claim_type: "REFUND",
    }),

  sendMessage: (id, message) =>
    request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, { message }),

  provideEvidence(id, notes, tracking) {
    const evidence = tracking
      ? {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: {
            tracking_info: [
              { carrier_name: "OTHER", carrier_name_other: tracking.carrier, tracking_number: tracking.trackingNumber },
            ],
          },
          notes,
        }
      : { evidence_type: "OTHER", notes };
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ evidences: [evidence] })], { type: "application/json" }), "input.json");
    return request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, form);
  },
};

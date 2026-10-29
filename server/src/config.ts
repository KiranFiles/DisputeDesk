import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../.env"), quiet: true });

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PAYPAL_BASE_URL: z.url().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  MOCK_PAYPAL: bool,
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  AI_PROVIDER: z.enum(["openai", "gemini", ""]).default(""),
  MAX_ACCEPT_AMOUNT: z.coerce.number().nonnegative().default(250),
  BASIC_AUTH_USER: z.string().default(""),
  BASIC_AUTH_PASSWORD: z.string().default(""),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().default(""),
  TRIAGE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
}
const env = parsed.data;

// Explicit AI_PROVIDER wins; otherwise use whichever key is present, preferring OpenAI.
const provider: "openai" | "gemini" =
  env.AI_PROVIDER || (!env.OPENAI_API_KEY && env.GEMINI_API_KEY ? "gemini" : "openai");

export const config = {
  production: env.NODE_ENV === "production",
  port: env.PORT,
  paypalBase: env.PAYPAL_BASE_URL.replace(/\/+$/, ""),
  clientId: env.PAYPAL_CLIENT_ID,
  clientSecret: env.PAYPAL_CLIENT_SECRET,
  mockPayPal: env.MOCK_PAYPAL || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET,
  aiProvider: provider,
  aiKey: provider === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY,
  aiModel: provider === "gemini" ? env.GEMINI_MODEL : env.OPENAI_MODEL,
  aiBaseUrl: provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined,
  maxAcceptAmount: env.MAX_ACCEPT_AMOUNT,
  authUser: env.BASIC_AUTH_USER,
  authPassword: env.BASIC_AUTH_PASSWORD,
  trustProxy: env.TRUST_PROXY,
  databaseUrl: env.DATABASE_URL,
  triageConcurrency: env.TRIAGE_CONCURRENCY,
};

if (config.production) {
  const problems: string[] = [];
  if (config.mockPayPal) problems.push("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required (MOCK_PAYPAL must be false)");
  if (!config.aiKey) problems.push("An AI key is required (OPENAI_API_KEY or GEMINI_API_KEY for the selected AI_PROVIDER)");
  if (!config.authUser || config.authPassword.length < 12) {
    problems.push("BASIC_AUTH_USER and BASIC_AUTH_PASSWORD (min 12 chars) are required");
  }
  if (problems.length) throw new Error(`Refusing to start in production:\n  - ${problems.join("\n  - ")}`);
}

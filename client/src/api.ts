export interface Money {
  currency_code: string;
  value: string;
}

export interface DisputeSummary {
  dispute_id: string;
  reason: string;
  status: string;
  dispute_amount: Money;
  create_time: string;
  seller_response_due_date?: string;
  buyer_name?: string;
  item?: string;
}

export interface DisputeDetail extends DisputeSummary {
  dispute_life_cycle_stage?: string;
  dispute_outcome?: string;
  messages?: { posted_by: string; time_posted: string; content: string }[];
  disputed_transactions?: { seller_transaction_id: string; buyer?: { name: string }; items?: { item_name: string; item_quantity: string }[] }[];
}

export interface Triage {
  summary: string;
  priority: "low" | "medium" | "high" | "urgent";
  winProbability: number;
  fraudSignals: string[];
  recommendedAction: "ACCEPT_CLAIM" | "PROVIDE_EVIDENCE" | "SEND_MESSAGE";
  reasoning: string;
  acceptReason: string;
  draftMessageToBuyer: string;
  evidenceNotes: string;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  evidenceChecklist: string[];
}

export interface TriageResult {
  triage: Triage;
  trace: { tool: string; args: Record<string, unknown> }[];
}

export interface Health {
  mockPayPal: boolean;
  aiConfigured: boolean;
  provider: "openai" | "gemini";
  model: string;
  maxAcceptAmount: number;
  persistence: "postgres" | "memory";
}

export interface BatchStatus {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AnalyticsRow {
  dispute_id: string;
  buyer: string;
  item: string;
  reason: string;
  status: string;
  amount: number;
  created: string | null;
  due_date: string | null;
  days_left: number | null;
  deadline_bucket: string;
  open_cases: number;
  open_amount: number;
  due_soon: number;
  analysis: string;
  priority: string;
  recommended_action: string;
  win_probability: number | null;
  fraud_signals: number;
  expected_loss: number;
}

export interface Analytics {
  rows: AnalyticsRow[];
  batch: BatchStatus;
  generatedAt: string;
}

export interface AuditEntry {
  time: string;
  disputeId: string;
  action: string;
  detail: string;
}

export type ActionBody =
  | { action: "ACCEPT_CLAIM"; note: string; reason: string }
  | { action: "SEND_MESSAGE"; message: string }
  | { action: "PROVIDE_EVIDENCE"; notes: string; carrier?: string | null; trackingNumber?: string | null };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  health: () => call<Health>("/health"),
  disputes: () => call<DisputeSummary[]>("/disputes"),
  dispute: (id: string) => call<DisputeDetail>(`/disputes/${id}`),
  triage: (id: string) => call<TriageResult>(`/disputes/${id}/triage`, { method: "POST" }),
  act: (id: string, body: ActionBody) =>
    call<{ dispute: DisputeDetail }>(`/disputes/${id}/actions`, { method: "POST", body: JSON.stringify(body) }),
  audit: () => call<AuditEntry[]>("/audit"),
  analytics: () => call<Analytics>("/analytics"),
  triageAll: (force = false) => call<BatchStatus>(`/triage-all${force ? "?force=true" : ""}`, { method: "POST" }),
  triageStatus: () => call<BatchStatus>("/triage-all"),
};

import type { Json, PayPalGateway } from "./gateway.js";
import { store } from "./store.js";

const DAY = 86_400_000;
const NOT_ANALYSED = "Not analysed";

const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized payment",
  CREDIT_NOT_PROCESSED: "Refund not received",
};
const ACTIONS: Record<string, string> = { ACCEPT_CLAIM: "Accept claim", PROVIDE_EVIDENCE: "Submit evidence", SEND_MESSAGE: "Message buyer" };

const label = (value: string) => value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const day = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

const bucket = (open: boolean, daysLeft: number | null) => {
  if (!open) return "Resolved";
  if (daysLeft === null) return "No deadline";
  if (daysLeft < 0) return "Overdue";
  if (daysLeft <= 3) return "0-3 days";
  if (daysLeft <= 7) return "4-7 days";
  return "8+ days";
};

/** One flat row per dispute, shaped for AG Studio. Unanalysed open disputes count as full-amount expected loss. */
export async function buildAnalyticsRows(pp: PayPalGateway): Promise<Json[]> {
  const [disputes, stored] = await Promise.all([pp.listDisputes(), store.listTriage()]);
  const triageById = new Map(stored.map((s) => [s.disputeId, s.triage]));
  const now = Date.now();

  return disputes.map((d) => {
    const id = String(d.dispute_id);
    const open = d.status !== "RESOLVED";
    const amount = Number(d.dispute_amount?.value ?? 0);
    const due = d.seller_response_due_date as string | undefined;
    const daysLeft = due ? Math.ceil((new Date(due).getTime() - now) / DAY) : null;
    const triage = triageById.get(id);
    const winProbability = triage ? triage.winProbability / 100 : null;

    return {
      dispute_id: id,
      buyer: d.buyer_name ?? "Unknown buyer",
      item: d.item ?? "Item not provided",
      reason: REASONS[d.reason] ?? label(String(d.reason ?? "unknown")),
      status: label(String(d.status ?? "unknown")),
      amount,
      created: day(d.create_time),
      due_date: day(due),
      days_left: open ? daysLeft : null,
      deadline_bucket: bucket(open, daysLeft),
      open_cases: open ? 1 : 0,
      open_amount: open ? amount : 0,
      due_soon: open && daysLeft !== null && daysLeft <= 3 ? 1 : 0,
      analysis: triage ? "Analysed" : NOT_ANALYSED,
      priority: triage ? label(triage.priority) : NOT_ANALYSED,
      recommended_action: triage ? ACTIONS[triage.recommendedAction] : NOT_ANALYSED,
      win_probability: winProbability,
      fraud_signals: triage?.fraudSignals.length ?? 0,
      expected_loss: open ? amount * (1 - (winProbability ?? 0)) : 0,
    };
  });
}

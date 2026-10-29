import { AiError, triageDispute } from "./agent.js";
import { config } from "./config.js";
import type { PayPalGateway } from "./gateway.js";
import { log } from "./logger.js";
import { store } from "./store.js";

export interface BatchStatus {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
}

let status: BatchStatus = { running: false, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null };

export const batchStatus = (): BatchStatus => ({ ...status });

/** Triages every open dispute that has no stored analysis (or all of them with `force`). Never writes to PayPal. */
export async function runBatch(pp: PayPalGateway, force = false): Promise<BatchStatus> {
  if (!config.aiKey) throw new AiError("AI is not configured on the server");
  if (status.running) return batchStatus();

  status = { running: true, total: 0, done: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null };
  try {
    const [disputes, stored] = await Promise.all([pp.listDisputes(), store.listTriage()]);
    const analysed = new Set(stored.map((s) => s.disputeId));
    const queue = disputes
      .filter((d) => d.status !== "RESOLVED" && (force || !analysed.has(String(d.dispute_id))))
      .map((d) => String(d.dispute_id));
    status.total = queue.length;

    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const result = await triageDispute(id, pp);
          await store.saveTriage(id, result.triage);
          status.done += 1;
        } catch (err) {
          status.failed += 1;
          log("error", "batch_triage_failed", {
            disputeId: id,
            message: err instanceof Error ? err.message : String(err),
            cause: err instanceof Error && err.cause ? String(err.cause).slice(0, 300) : undefined,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.triageConcurrency, queue.length) }, worker));
  } finally {
    status = { ...status, running: false, finishedAt: new Date().toISOString() };
    log("info", "batch_triage_finished", { ...status });
  }
  return batchStatus();
}

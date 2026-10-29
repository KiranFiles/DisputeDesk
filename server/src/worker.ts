import { config } from "./config.js";
import type { PayPalGateway } from "./gateway.js";
import { runBatch } from "./batch.js";
import { log } from "./logger.js";
import { mockPayPal } from "./mock.js";
import { livePayPal } from "./paypal.js";
import { store } from "./store.js";

// Entry point for a scheduled job (for example a Render cron job): triage new open disputes, then exit.
const pp: PayPalGateway = config.mockPayPal ? mockPayPal : livePayPal;

if (store.kind !== "postgres") {
  log("error", "worker_requires_database", { message: "Set DATABASE_URL so triage results outlive this process" });
  process.exit(1);
}

runBatch(pp, process.argv.includes("--force"))
  .then((status) => process.exit(status.failed > 0 && status.done === 0 ? 1 : 0))
  .catch((err) => {
    log("error", "worker_failed", { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

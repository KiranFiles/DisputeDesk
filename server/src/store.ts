import pg from "pg";
import type { Triage } from "./agent.js";
import { config } from "./config.js";

export interface AuditEntry {
  time: string;
  disputeId: string;
  action: string;
  detail: string;
}

export interface StoredTriage {
  disputeId: string;
  triage: Triage;
  analysedAt: string;
}

export interface Store {
  kind: "postgres" | "memory";
  addAudit(entry: AuditEntry): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  saveTriage(disputeId: string, triage: Triage): Promise<void>;
  listTriage(): Promise<StoredTriage[]>;
}

const MAX_AUDIT = 500;

function memoryStore(): Store {
  const audit: AuditEntry[] = [];
  const triage = new Map<string, StoredTriage>();
  return {
    kind: "memory",
    async addAudit(entry) {
      audit.unshift(entry);
      audit.length = Math.min(audit.length, MAX_AUDIT);
    },
    async listAudit() {
      return [...audit];
    },
    async saveTriage(disputeId, result) {
      triage.set(disputeId, { disputeId, triage: result, analysedAt: new Date().toISOString() });
    },
    async listTriage() {
      return [...triage.values()];
    },
  };
}

function postgresStore(connectionString: string): Store {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
  const ready = pool
    .query(
      `CREATE TABLE IF NOT EXISTS audit_log (
         id BIGSERIAL PRIMARY KEY,
         time TIMESTAMPTZ NOT NULL,
         dispute_id TEXT NOT NULL,
         action TEXT NOT NULL,
         detail TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS triage_results (
         dispute_id TEXT PRIMARY KEY,
         result JSONB NOT NULL,
         analysed_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );`,
    )
    .then(() => undefined);
  // Callers surface the failure; this only prevents an unhandled rejection at startup.
  ready.catch(() => undefined);

  return {
    kind: "postgres",
    async addAudit(entry) {
      await ready;
      await pool.query("INSERT INTO audit_log (time, dispute_id, action, detail) VALUES ($1, $2, $3, $4)", [
        entry.time,
        entry.disputeId,
        entry.action,
        entry.detail,
      ]);
    },
    async listAudit() {
      await ready;
      const { rows } = await pool.query(
        "SELECT time, dispute_id, action, detail FROM audit_log ORDER BY id DESC LIMIT $1",
        [MAX_AUDIT],
      );
      return rows.map((r) => ({ time: new Date(r.time).toISOString(), disputeId: r.dispute_id, action: r.action, detail: r.detail }));
    },
    async saveTriage(disputeId, result) {
      await ready;
      await pool.query(
        `INSERT INTO triage_results (dispute_id, result, analysed_at) VALUES ($1, $2, now())
         ON CONFLICT (dispute_id) DO UPDATE SET result = EXCLUDED.result, analysed_at = EXCLUDED.analysed_at`,
        [disputeId, JSON.stringify(result)],
      );
    },
    async listTriage() {
      await ready;
      const { rows } = await pool.query("SELECT dispute_id, result, analysed_at FROM triage_results");
      return rows.map((r) => ({ disputeId: r.dispute_id, triage: r.result as Triage, analysedAt: new Date(r.analysed_at).toISOString() }));
    },
  };
}

export const store: Store = config.databaseUrl ? postgresStore(config.databaseUrl) : memoryStore();

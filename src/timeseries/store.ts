/**
 * Time-series store — v0.5 spec AC6.
 *
 * SQLite-backed table of (ts, provider, pid, refinedStatus, turnCount,
 * toolCount, lastWriteAge) samples written by the sessions diff poller.
 * Consumed by:
 *   - the Prometheus exporter at GET /metrics (AC7) for current-state gauges
 *   - any external dashboard that wants to graph historical activity
 *     without re-parsing JSONL
 *
 * Design notes:
 *   - Single-file SQLite at $AGENT_CONDUCTOR_STATE_DIR/timeseries.db
 *     (default `~/.local/share/agent-conductor/timeseries.db`).
 *   - WAL mode + `synchronous=NORMAL` — survives crashes, accepts a tiny
 *     window of dropped samples on hard power loss. Acceptable for a
 *     local observability store; the source of truth remains the JSONL
 *     transcripts on disk.
 *   - Retention is row-count based, not time-based. Older samples are
 *     pruned in batches once the table exceeds `maxRows`. Disk budget is
 *     bounded by `maxRows * row_size` (~64 bytes/row → 6.4 MB default).
 *   - The constructor opens the db and runs migrations. `close()` is
 *     idempotent. Tests use `:memory:` to avoid touching the filesystem.
 *
 * Why opt-in (writer not running by default): the spec promises "no
 * telemetry, no network" out of the box. The store activates only when
 * `AGENT_CONDUCTOR_TIMESERIES=1` is set OR the embedder passes
 * `{ timeseries: true }` to startDaemon().
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { RefinedStatus } from "../types/sessions.js";

/** Default cap. ~64 bytes/row → 6.4 MB total. Override via env or constructor. */
export const DEFAULT_MAX_ROWS = 100_000;

/** Prune in batches so we don't lock the writer for a long DELETE. */
export const PRUNE_BATCH = 1_000;

/** Resolved default state dir (XDG with explicit override env var). */
export function defaultStateDir(): string {
  const fromEnv = process.env.AGENT_CONDUCTOR_STATE_DIR;
  if (fromEnv) return fromEnv;
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, "agent-conductor");
}

export interface Sample {
  /** Wall-clock ms when this sample was recorded. */
  ts: number;
  /** Provider name (`claude-code`, `aider`, etc.). */
  provider: string;
  /** Process id. */
  pid: number;
  /** Refined 5-state status at sample time. */
  refinedStatus: RefinedStatus;
  /** Cumulative turn count from the JSONL transcript, when known. */
  turnCount: number | null;
  /** Cumulative tool-use event count, when known. */
  toolCount: number | null;
  /** Ms since the transcript was last written (status freshness indicator). */
  lastWriteAge: number | null;
}

export interface TimeseriesStoreOptions {
  /** Path to the SQLite file. Use `:memory:` for tests. Defaults to the resolved state dir. */
  path?: string;
  /** Row-count cap before pruning kicks in. */
  maxRows?: number;
}

/**
 * SQLite-backed sample store. Construct once, reuse for the lifetime of
 * the daemon. Single-writer (the diff poller).
 */
export class TimeseriesStore {
  readonly path: string;
  readonly maxRows: number;
  private readonly db: DatabaseType;
  private readonly insertStmt: Statement;
  private readonly countStmt: Statement;
  private readonly pruneStmt: Statement;
  private readonly latestPerPidStmt: Statement;
  private closed = false;

  constructor(opts: TimeseriesStoreOptions = {}) {
    this.path = opts.path ?? join(defaultStateDir(), "timeseries.db");
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

    if (this.path !== ":memory:") {
      const dir = dirname(this.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.path);
    // WAL = better concurrent reads, durable across crashes for committed
    // writes. NORMAL fsync trades one in-flight fsync per commit for ~5x
    // write throughput — acceptable for an observability store.
    if (this.path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        provider        TEXT    NOT NULL,
        pid             INTEGER NOT NULL,
        refined_status  TEXT    NOT NULL,
        turn_count      INTEGER,
        tool_count      INTEGER,
        last_write_age  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_samples_ts  ON samples(ts);
      CREATE INDEX IF NOT EXISTS idx_samples_pid ON samples(pid);
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO samples (ts, provider, pid, refined_status, turn_count, tool_count, last_write_age)
       VALUES (@ts, @provider, @pid, @refinedStatus, @turnCount, @toolCount, @lastWriteAge)`,
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM samples`);
    this.pruneStmt = this.db.prepare(
      `DELETE FROM samples WHERE id IN (
         SELECT id FROM samples ORDER BY id ASC LIMIT @batch
       )`,
    );
    this.latestPerPidStmt = this.db.prepare(`
      SELECT s.ts, s.provider, s.pid, s.refined_status AS refinedStatus,
             s.turn_count AS turnCount, s.tool_count AS toolCount,
             s.last_write_age AS lastWriteAge
      FROM samples s
      INNER JOIN (
        SELECT pid, MAX(ts) AS max_ts FROM samples GROUP BY pid
      ) latest ON s.pid = latest.pid AND s.ts = latest.max_ts
    `);
  }

  /** Insert one sample. Returns the new row's id. */
  write(sample: Sample): number {
    if (this.closed) throw new Error("TimeseriesStore is closed");
    const res = this.insertStmt.run(sample);
    return Number(res.lastInsertRowid);
  }

  /** Bulk insert in a single transaction (cheaper than N writes). */
  writeMany(samples: Sample[]): void {
    if (this.closed) throw new Error("TimeseriesStore is closed");
    if (samples.length === 0) return;
    const tx = this.db.transaction((rows: Sample[]) => {
      for (const r of rows) this.insertStmt.run(r);
    });
    tx(samples);
  }

  /** Current row count. */
  rowCount(): number {
    const row = this.countStmt.get() as { n: number };
    return row.n;
  }

  /**
   * Prune oldest rows until row count is <= maxRows. Returns how many
   * rows were deleted. No-op when under cap.
   *
   * Batched delete: each iteration removes at most PRUNE_BATCH rows OR
   * however many are over the cap (whichever is smaller). The cap-aware
   * limit keeps prune deterministic when the overflow is small (a 25-row
   * table with maxRows=10 must end at exactly 10 rows, not 0).
   */
  prune(): number {
    if (this.closed) return 0;
    let total = 0;
    while (true) {
      const count = this.rowCount();
      if (count <= this.maxRows) break;
      const over = count - this.maxRows;
      const batch = Math.min(PRUNE_BATCH, over);
      const res = this.pruneStmt.run({ batch });
      total += Number(res.changes);
      if (res.changes === 0) break;
    }
    return total;
  }

  /**
   * Latest sample per pid. Used by the Prometheus exporter to build
   * `_total{provider, status}` gauges without scanning every row.
   */
  latestPerPid(): Sample[] {
    return this.latestPerPidStmt.all() as Sample[];
  }

  /** Idempotent close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Test/debug helper. Do not use in production code. */
  _all(): Sample[] {
    return this.db
      .prepare(
        `SELECT ts, provider, pid, refined_status AS refinedStatus,
                turn_count AS turnCount, tool_count AS toolCount,
                last_write_age AS lastWriteAge
         FROM samples ORDER BY id ASC`,
      )
      .all() as Sample[];
  }
}

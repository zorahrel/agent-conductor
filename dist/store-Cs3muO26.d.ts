import { R as RefinedStatus } from './sessions-CdTstnnc.js';

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

/** Default cap. ~64 bytes/row → 6.4 MB total. Override via env or constructor. */
declare const DEFAULT_MAX_ROWS = 100000;
/** Prune in batches so we don't lock the writer for a long DELETE. */
declare const PRUNE_BATCH = 1000;
/** Resolved default state dir (XDG with explicit override env var). */
declare function defaultStateDir(): string;
interface Sample {
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
interface TimeseriesStoreOptions {
    /** Path to the SQLite file. Use `:memory:` for tests. Defaults to the resolved state dir. */
    path?: string;
    /** Row-count cap before pruning kicks in. */
    maxRows?: number;
}
/**
 * SQLite-backed sample store. Construct once, reuse for the lifetime of
 * the daemon. Single-writer (the diff poller).
 */
declare class TimeseriesStore {
    readonly path: string;
    readonly maxRows: number;
    private readonly db;
    private readonly insertStmt;
    private readonly countStmt;
    private readonly pruneStmt;
    private readonly latestPerPidStmt;
    private closed;
    constructor(opts?: TimeseriesStoreOptions);
    /** Insert one sample. Returns the new row's id. */
    write(sample: Sample): number;
    /** Bulk insert in a single transaction (cheaper than N writes). */
    writeMany(samples: Sample[]): void;
    /** Current row count. */
    rowCount(): number;
    /**
     * Prune oldest rows until row count is <= maxRows. Returns how many
     * rows were deleted. No-op when under cap.
     *
     * Batched delete: each iteration removes at most PRUNE_BATCH rows OR
     * however many are over the cap (whichever is smaller). The cap-aware
     * limit keeps prune deterministic when the overflow is small (a 25-row
     * table with maxRows=10 must end at exactly 10 rows, not 0).
     */
    prune(): number;
    /**
     * Latest sample per pid. Used by the Prometheus exporter to build
     * `_total{provider, status}` gauges without scanning every row.
     */
    latestPerPid(): Sample[];
    /** Idempotent close. */
    close(): void;
    /** Test/debug helper. Do not use in production code. */
    _all(): Sample[];
}

export { DEFAULT_MAX_ROWS as D, PRUNE_BATCH as P, type Sample as S, TimeseriesStore as T, type TimeseriesStoreOptions as a, defaultStateDir as d };

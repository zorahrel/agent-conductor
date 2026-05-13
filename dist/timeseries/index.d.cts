import { T as TimeseriesStore, S as Sample } from '../store-a03wprzn.cjs';
export { D as DEFAULT_MAX_ROWS, P as PRUNE_BATCH, a as TimeseriesStoreOptions, d as defaultStateDir } from '../store-a03wprzn.cjs';
import { R as RefinedStatus } from '../sessions-CdTstnnc.cjs';

/**
 * Prometheus exposition — v0.5 spec AC7.
 *
 * Builds the `text/plain; version=0.0.4` body served at GET /metrics. Pure
 * function: takes the current state (sample store + audit log + Reminders
 * todo state if available) and returns the exposition string. No I/O.
 *
 * Metrics emitted:
 *   - agent_conductor_sessions_total{provider, status} — gauge, current
 *     count of live sessions in each state, derived from the latest sample
 *     per pid.
 *   - agent_conductor_samples_total — counter, cumulative rows in the
 *     timeseries table since boot (incl. pruned).
 *   - agent_conductor_audit_bytes_total — gauge, current size of the audit
 *     log file (when present; 0 otherwise).
 *   - agent_conductor_todos_total{state} — gauge, number of todos in
 *     {open, completed} states (when the Reminders bridge supplied data).
 *   - agent_conductor_build_info{version} — gauge, always 1, label carries
 *     the build version.
 *
 * The exposition format is intentionally text-only — no protobuf, no
 * OpenMetrics extensions. Compatible with every Prometheus scraper.
 */

/** Content-Type returned by GET /metrics. */
declare const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
interface PrometheusInput {
    /** Build version (embedded at build time by tsup `define`). */
    version: string;
    /** Optional sample store. When omitted, sessions_total is omitted entirely. */
    store?: TimeseriesStore;
    /** Cumulative sample-write counter since boot. Survives pruning. */
    samplesWritten?: number;
    /** Audit log size in bytes (caller fetches via fs.stat, or passes null). */
    auditBytes?: number | null;
    /**
     * Optional Reminders summary. Caller supplies when the bridge has
     * polled at least once; we don't fetch it ourselves to keep this pure.
     */
    todos?: {
        open: number;
        completed: number;
    };
}
/**
 * Aggregate latestPerPid() into a {provider → {status → count}} matrix.
 * Pure helper, exported for test use.
 */
declare function aggregateSessions(samples: Sample[]): Map<string, Map<RefinedStatus, number>>;
/**
 * Build the full /metrics body.
 */
declare function renderPrometheus(input: PrometheusInput): string;

export { PROMETHEUS_CONTENT_TYPE, type PrometheusInput, Sample, TimeseriesStore, aggregateSessions, renderPrometheus };

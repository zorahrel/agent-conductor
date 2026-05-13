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

import type { TimeseriesStore, Sample } from "./store.js";
import type { RefinedStatus } from "../types/sessions.js";

/** Content-Type returned by GET /metrics. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** All 5 refined statuses — emitted as labels even when zero, to keep scrapers happy. */
const STATUSES: RefinedStatus[] = [
  "awaiting_user_input",
  "tool_pending",
  "crashed",
  "working",
  "idle",
];

export interface PrometheusInput {
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
  todos?: { open: number; completed: number };
}

/**
 * Escape a Prometheus label value per the exposition spec:
 *   backslash, double quote, newline.
 */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Aggregate latestPerPid() into a {provider → {status → count}} matrix.
 * Pure helper, exported for test use.
 */
export function aggregateSessions(samples: Sample[]): Map<string, Map<RefinedStatus, number>> {
  const out = new Map<string, Map<RefinedStatus, number>>();
  for (const s of samples) {
    let perProvider = out.get(s.provider);
    if (!perProvider) {
      perProvider = new Map();
      out.set(s.provider, perProvider);
    }
    perProvider.set(s.refinedStatus, (perProvider.get(s.refinedStatus) ?? 0) + 1);
  }
  return out;
}

/**
 * Build the full /metrics body.
 */
export function renderPrometheus(input: PrometheusInput): string {
  const lines: string[] = [];

  // build_info — always emitted, scraper uses this to spot version drift.
  lines.push("# HELP agent_conductor_build_info Build metadata for the running agent-conductor.");
  lines.push("# TYPE agent_conductor_build_info gauge");
  lines.push(`agent_conductor_build_info{version="${escapeLabel(input.version)}"} 1`);

  // sessions_total — only when we have a store.
  if (input.store) {
    lines.push("# HELP agent_conductor_sessions_total Current count of sessions in each refinedStatus.");
    lines.push("# TYPE agent_conductor_sessions_total gauge");
    const samples = input.store.latestPerPid();
    const matrix = aggregateSessions(samples);
    if (matrix.size === 0) {
      // Emit a single zero row so the metric is discoverable in /metrics
      // even when no sessions are live yet.
      lines.push(`agent_conductor_sessions_total{provider="none",status="idle"} 0`);
    } else {
      // Stable ordering: provider asc, status by STATUSES list.
      const providers = Array.from(matrix.keys()).sort();
      for (const provider of providers) {
        const perStatus = matrix.get(provider)!;
        for (const status of STATUSES) {
          const count = perStatus.get(status) ?? 0;
          lines.push(
            `agent_conductor_sessions_total{provider="${escapeLabel(provider)}",status="${status}"} ${count}`,
          );
        }
      }
    }
  }

  // samples_total — cumulative writer counter.
  if (input.samplesWritten !== undefined) {
    lines.push("# HELP agent_conductor_samples_total Cumulative sample rows written to the timeseries store since boot.");
    lines.push("# TYPE agent_conductor_samples_total counter");
    lines.push(`agent_conductor_samples_total ${input.samplesWritten}`);
  }

  // audit_bytes_total — current audit log file size.
  if (input.auditBytes !== null && input.auditBytes !== undefined) {
    lines.push("# HELP agent_conductor_audit_bytes_total Current size of the inject audit log file in bytes.");
    lines.push("# TYPE agent_conductor_audit_bytes_total gauge");
    lines.push(`agent_conductor_audit_bytes_total ${input.auditBytes}`);
  }

  // todos_total — when the Reminders bridge has data.
  if (input.todos) {
    lines.push("# HELP agent_conductor_todos_total Current todo count by state (Apple Reminders intent layer).");
    lines.push("# TYPE agent_conductor_todos_total gauge");
    lines.push(`agent_conductor_todos_total{state="open"} ${input.todos.open}`);
    lines.push(`agent_conductor_todos_total{state="completed"} ${input.todos.completed}`);
  }

  // Prometheus expects a trailing newline.
  return lines.join("\n") + "\n";
}

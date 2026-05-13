/**
 * Time-series + Prometheus public surface — v0.5 spec AC6 + AC7.
 *
 * Embedders that only want the SQLite samples store import this. The HTTP
 * daemon wires the store into the /metrics route via `renderPrometheus`.
 */

export {
  TimeseriesStore,
  defaultStateDir,
  DEFAULT_MAX_ROWS,
  PRUNE_BATCH,
  type Sample,
  type TimeseriesStoreOptions,
} from "./store.js";

export {
  renderPrometheus,
  aggregateSessions,
  PROMETHEUS_CONTENT_TYPE,
  type PrometheusInput,
} from "./prometheus.js";

'use strict';

var os = require('os');
var path = require('path');
var fs = require('fs');
var Database = require('better-sqlite3');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var Database__default = /*#__PURE__*/_interopDefault(Database);

// src/timeseries/store.ts
var DEFAULT_MAX_ROWS = 1e5;
var PRUNE_BATCH = 1e3;
function defaultStateDir() {
  const fromEnv = process.env.AGENT_CONDUCTOR_STATE_DIR;
  if (fromEnv) return fromEnv;
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "agent-conductor");
}
var TimeseriesStore = class {
  path;
  maxRows;
  db;
  insertStmt;
  countStmt;
  pruneStmt;
  latestPerPidStmt;
  closed = false;
  constructor(opts = {}) {
    this.path = opts.path ?? path.join(defaultStateDir(), "timeseries.db");
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
    if (this.path !== ":memory:") {
      const dir = path.dirname(this.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database__default.default(this.path);
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
       VALUES (@ts, @provider, @pid, @refinedStatus, @turnCount, @toolCount, @lastWriteAge)`
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM samples`);
    this.pruneStmt = this.db.prepare(
      `DELETE FROM samples WHERE id IN (
         SELECT id FROM samples ORDER BY id ASC LIMIT @batch
       )`
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
  write(sample) {
    if (this.closed) throw new Error("TimeseriesStore is closed");
    const res = this.insertStmt.run(sample);
    return Number(res.lastInsertRowid);
  }
  /** Bulk insert in a single transaction (cheaper than N writes). */
  writeMany(samples) {
    if (this.closed) throw new Error("TimeseriesStore is closed");
    if (samples.length === 0) return;
    const tx = this.db.transaction((rows) => {
      for (const r of rows) this.insertStmt.run(r);
    });
    tx(samples);
  }
  /** Current row count. */
  rowCount() {
    const row = this.countStmt.get();
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
  prune() {
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
  latestPerPid() {
    return this.latestPerPidStmt.all();
  }
  /** Idempotent close. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
  /** Test/debug helper. Do not use in production code. */
  _all() {
    return this.db.prepare(
      `SELECT ts, provider, pid, refined_status AS refinedStatus,
                turn_count AS turnCount, tool_count AS toolCount,
                last_write_age AS lastWriteAge
         FROM samples ORDER BY id ASC`
    ).all();
  }
};

// src/timeseries/prometheus.ts
var PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
var STATUSES = [
  "awaiting_user_input",
  "tool_pending",
  "crashed",
  "working",
  "idle"
];
function escapeLabel(v) {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
function aggregateSessions(samples) {
  const out = /* @__PURE__ */ new Map();
  for (const s of samples) {
    let perProvider = out.get(s.provider);
    if (!perProvider) {
      perProvider = /* @__PURE__ */ new Map();
      out.set(s.provider, perProvider);
    }
    perProvider.set(s.refinedStatus, (perProvider.get(s.refinedStatus) ?? 0) + 1);
  }
  return out;
}
function renderPrometheus(input) {
  const lines = [];
  lines.push("# HELP agent_conductor_build_info Build metadata for the running agent-conductor.");
  lines.push("# TYPE agent_conductor_build_info gauge");
  lines.push(`agent_conductor_build_info{version="${escapeLabel(input.version)}"} 1`);
  if (input.store) {
    lines.push("# HELP agent_conductor_sessions_total Current count of sessions in each refinedStatus.");
    lines.push("# TYPE agent_conductor_sessions_total gauge");
    const samples = input.store.latestPerPid();
    const matrix = aggregateSessions(samples);
    if (matrix.size === 0) {
      lines.push(`agent_conductor_sessions_total{provider="none",status="idle"} 0`);
    } else {
      const providers = Array.from(matrix.keys()).sort();
      for (const provider of providers) {
        const perStatus = matrix.get(provider);
        for (const status of STATUSES) {
          const count = perStatus.get(status) ?? 0;
          lines.push(
            `agent_conductor_sessions_total{provider="${escapeLabel(provider)}",status="${status}"} ${count}`
          );
        }
      }
    }
  }
  if (input.samplesWritten !== void 0) {
    lines.push("# HELP agent_conductor_samples_total Cumulative sample rows written to the timeseries store since boot.");
    lines.push("# TYPE agent_conductor_samples_total counter");
    lines.push(`agent_conductor_samples_total ${input.samplesWritten}`);
  }
  if (input.auditBytes !== null && input.auditBytes !== void 0) {
    lines.push("# HELP agent_conductor_audit_bytes_total Current size of the inject audit log file in bytes.");
    lines.push("# TYPE agent_conductor_audit_bytes_total gauge");
    lines.push(`agent_conductor_audit_bytes_total ${input.auditBytes}`);
  }
  if (input.todos) {
    lines.push("# HELP agent_conductor_todos_total Current todo count by state (Apple Reminders intent layer).");
    lines.push("# TYPE agent_conductor_todos_total gauge");
    lines.push(`agent_conductor_todos_total{state="open"} ${input.todos.open}`);
    lines.push(`agent_conductor_todos_total{state="completed"} ${input.todos.completed}`);
  }
  return lines.join("\n") + "\n";
}

exports.DEFAULT_MAX_ROWS = DEFAULT_MAX_ROWS;
exports.PROMETHEUS_CONTENT_TYPE = PROMETHEUS_CONTENT_TYPE;
exports.PRUNE_BATCH = PRUNE_BATCH;
exports.TimeseriesStore = TimeseriesStore;
exports.aggregateSessions = aggregateSessions;
exports.defaultStateDir = defaultStateDir;
exports.renderPrometheus = renderPrometheus;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map
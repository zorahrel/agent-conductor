/**
 * Prometheus exposition tests (v0.5 spec AC7).
 *
 * Verifies the exposition string parses as valid text/plain Prometheus
 * format (line-oriented, # HELP + # TYPE + samples, trailing newline) and
 * that the label values + counts come from the store correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderPrometheus,
  aggregateSessions,
  PROMETHEUS_CONTENT_TYPE,
} from "./prometheus.js";
import { TimeseriesStore, type Sample } from "./store.js";

function makeSample(overrides: Partial<Sample> = {}): Sample {
  return {
    ts: 1_700_000_000_000,
    provider: "claude-code",
    pid: 1,
    refinedStatus: "working",
    turnCount: null,
    toolCount: null,
    lastWriteAge: null,
    ...overrides,
  };
}

describe("aggregateSessions", () => {
  it("groups samples by provider then status", () => {
    const m = aggregateSessions([
      makeSample({ pid: 1, provider: "claude-code", refinedStatus: "working" }),
      makeSample({ pid: 2, provider: "claude-code", refinedStatus: "working" }),
      makeSample({ pid: 3, provider: "claude-code", refinedStatus: "idle" }),
      makeSample({ pid: 4, provider: "aider", refinedStatus: "awaiting_user_input" }),
    ]);
    assert.equal(m.get("claude-code")?.get("working"), 2);
    assert.equal(m.get("claude-code")?.get("idle"), 1);
    assert.equal(m.get("aider")?.get("awaiting_user_input"), 1);
    assert.equal(m.get("aider")?.get("working"), undefined);
  });

  it("empty input yields empty matrix", () => {
    assert.equal(aggregateSessions([]).size, 0);
  });
});

describe("renderPrometheus (AC7)", () => {
  it("Content-Type constant matches Prometheus text 0.0.4 spec", () => {
    assert.equal(PROMETHEUS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
  });

  it("always emits build_info, even without a store", () => {
    const out = renderPrometheus({ version: "0.5.0" });
    assert.match(out, /# HELP agent_conductor_build_info/);
    assert.match(out, /# TYPE agent_conductor_build_info gauge/);
    assert.match(out, /agent_conductor_build_info\{version="0\.5\.0"\} 1/);
    assert.ok(out.endsWith("\n"), "trailing newline required by Prometheus");
  });

  it("emits sessions_total per (provider, status) when store has samples", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    try {
      store.writeMany([
        makeSample({ pid: 1, provider: "claude-code", refinedStatus: "working" }),
        makeSample({ pid: 2, provider: "claude-code", refinedStatus: "awaiting_user_input" }),
      ]);
      const out = renderPrometheus({ version: "0.5.0", store });
      assert.match(
        out,
        /agent_conductor_sessions_total\{provider="claude-code",status="working"\} 1/,
      );
      assert.match(
        out,
        /agent_conductor_sessions_total\{provider="claude-code",status="awaiting_user_input"\} 1/,
      );
      // All 5 statuses emitted (zeros included) so scrapers see the full label set.
      for (const status of ["awaiting_user_input", "tool_pending", "crashed", "working", "idle"]) {
        assert.match(
          out,
          new RegExp(`agent_conductor_sessions_total\\{provider="claude-code",status="${status}"\\}`),
        );
      }
    } finally {
      store.close();
    }
  });

  it("emits a discoverable zero row when store is empty", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    try {
      const out = renderPrometheus({ version: "0.5.0", store });
      assert.match(out, /agent_conductor_sessions_total\{provider="none",status="idle"\} 0/);
    } finally {
      store.close();
    }
  });

  it("emits samples_total as a counter when provided", () => {
    const out = renderPrometheus({ version: "0.5.0", samplesWritten: 42 });
    assert.match(out, /# TYPE agent_conductor_samples_total counter/);
    assert.match(out, /^agent_conductor_samples_total 42$/m);
  });

  it("emits audit_bytes_total when audit log exists", () => {
    const out = renderPrometheus({ version: "0.5.0", auditBytes: 1024 });
    assert.match(out, /^agent_conductor_audit_bytes_total 1024$/m);
  });

  it("skips audit_bytes_total when null (audit log missing)", () => {
    const out = renderPrometheus({ version: "0.5.0", auditBytes: null });
    assert.doesNotMatch(out, /agent_conductor_audit_bytes_total/);
  });

  it("emits todos_total with state labels", () => {
    const out = renderPrometheus({
      version: "0.5.0",
      todos: { open: 3, completed: 7 },
    });
    assert.match(out, /agent_conductor_todos_total\{state="open"\} 3/);
    assert.match(out, /agent_conductor_todos_total\{state="completed"\} 7/);
  });

  it("escapes special chars in label values", () => {
    // version is the most likely value to contain anything weird (e.g. a
    // build tag with quotes from CI). Build inputs/expectations with
    // explicit char arrays so the escape semantics stay readable.
    const rawInput = 'a"b\\c\nd'; // literally: a " b \ c <NL> d
    const out = renderPrometheus({ version: rawInput });
    // Expected exposition form per Prometheus spec:
    //   "  →  \"
    //   \  →  \\
    //   \n →  \n   (literal backslash + n, NOT a newline byte)
    const expected = 'version="a\\"b\\\\c\\nd"';
    assert.ok(
      out.includes(expected),
      `expected exposition to contain ${JSON.stringify(expected)}; got:\n${out}`,
    );
    // Sanity: the escaped value must NOT contain a raw newline byte —
    // splitting by \n must put the whole build_info value on one line.
    const versionLine = out.split("\n").find((l) => l.startsWith("agent_conductor_build_info"));
    assert.ok(versionLine);
    assert.ok(!versionLine!.includes(String.fromCharCode(10)), "no raw LF inside the line");
  });
});

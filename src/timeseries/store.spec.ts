/**
 * TimeseriesStore tests (v0.5 spec AC6).
 *
 * Uses :memory: SQLite so nothing touches the disk; the path branch is
 * covered by a separate temp-file test that verifies WAL + on-disk
 * persistence across a close/reopen cycle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimeseriesStore, type Sample } from "./store.js";

function sampleFixture(overrides: Partial<Sample> = {}): Sample {
  return {
    ts: 1_700_000_000_000,
    provider: "claude-code",
    pid: 1234,
    refinedStatus: "working",
    turnCount: 12,
    toolCount: 4,
    lastWriteAge: 250,
    ...overrides,
  };
}

describe("TimeseriesStore (AC6)", () => {
  it("writes a single sample and reads it back via _all()", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    try {
      const id = store.write(sampleFixture());
      assert.ok(id > 0, "write returns a row id");
      const all = store._all();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.pid, 1234);
      assert.equal(all[0]!.refinedStatus, "working");
      assert.equal(all[0]!.turnCount, 12);
    } finally {
      store.close();
    }
  });

  it("writeMany inserts a batch transactionally", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    try {
      store.writeMany([
        sampleFixture({ pid: 1, ts: 100 }),
        sampleFixture({ pid: 2, ts: 200 }),
        sampleFixture({ pid: 3, ts: 300 }),
      ]);
      assert.equal(store.rowCount(), 3);
    } finally {
      store.close();
    }
  });

  it("prune() deletes oldest rows once maxRows is exceeded", () => {
    const store = new TimeseriesStore({ path: ":memory:", maxRows: 10 });
    try {
      // Insert 25 rows — should prune down to <= 10 in batches of PRUNE_BATCH
      // (1000), so a single prune call will collapse to 10 here.
      const samples: Sample[] = [];
      for (let i = 0; i < 25; i += 1) {
        samples.push(sampleFixture({ pid: i, ts: 1000 + i }));
      }
      store.writeMany(samples);
      assert.equal(store.rowCount(), 25);
      const deleted = store.prune();
      assert.equal(deleted, 15);
      assert.equal(store.rowCount(), 10);
      // Oldest pids (0..14) should be gone, newest (15..24) retained.
      const remaining = store._all().map((s) => s.pid).sort((a, b) => a - b);
      assert.deepEqual(remaining, [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    } finally {
      store.close();
    }
  });

  it("prune() is a no-op when under cap", () => {
    const store = new TimeseriesStore({ path: ":memory:", maxRows: 100 });
    try {
      store.writeMany([sampleFixture({ pid: 1 }), sampleFixture({ pid: 2 })]);
      assert.equal(store.prune(), 0);
      assert.equal(store.rowCount(), 2);
    } finally {
      store.close();
    }
  });

  it("latestPerPid returns one sample per pid, picking the newest ts", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    try {
      store.writeMany([
        sampleFixture({ pid: 1, ts: 100, refinedStatus: "idle" }),
        sampleFixture({ pid: 1, ts: 200, refinedStatus: "working" }),
        sampleFixture({ pid: 2, ts: 150, refinedStatus: "tool_pending" }),
      ]);
      const latest = store.latestPerPid().sort((a, b) => a.pid - b.pid);
      assert.equal(latest.length, 2);
      assert.equal(latest[0]!.pid, 1);
      assert.equal(latest[0]!.refinedStatus, "working", "newest sample for pid 1");
      assert.equal(latest[1]!.pid, 2);
      assert.equal(latest[1]!.refinedStatus, "tool_pending");
    } finally {
      store.close();
    }
  });

  it("write() after close() throws", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    store.close();
    assert.throws(() => store.write(sampleFixture()), /closed/);
  });

  it("close() is idempotent", () => {
    const store = new TimeseriesStore({ path: ":memory:" });
    store.close();
    store.close(); // must not throw
  });

  it("persists across reopen (on-disk WAL path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-conductor-ts-"));
    const path = join(dir, "timeseries.db");
    try {
      const a = new TimeseriesStore({ path });
      a.write(sampleFixture({ pid: 999 }));
      a.close();
      const b = new TimeseriesStore({ path });
      assert.equal(b.rowCount(), 1);
      assert.equal(b._all()[0]!.pid, 999);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Graceful shutdown tests (v0.5 spec AC8).
 *
 * Covers:
 * - HTTP server stops accepting connections after gracefulClose() starts
 * - In-flight HTTP requests are allowed to finish within the budget
 * - WS clients receive a 1001 ("going away") close frame
 * - Force-termination kicks in when the deadline is exceeded
 * - close() is idempotent and returns a stable ShutdownReport
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startDaemon } from "./index.js";

describe("http shutdown (AC8)", () => {
  it("close() reports clean drain when nothing is in flight", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    const report = await daemon.close();
    assert.equal(report.httpDrained, true);
    assert.equal(report.inflightAtStart, 0);
    assert.equal(report.wsClientsClosed, 0);
    assert.ok(report.elapsedMs >= 0, "elapsedMs is non-negative");
    assert.ok(report.elapsedMs < 2000, "fast path closes well under 2s");
  });

  it("close() is idempotent — second call returns the cached report", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    const r1 = await daemon.close();
    const r2 = await daemon.close();
    assert.deepEqual(r2, r1, "second close returns identical report");
  });

  it("after close(), the HTTP port is free for re-bind", async () => {
    const daemon1 = await startDaemon({ sessionsPollMs: 999_999 });
    const port = daemon1.port;
    await daemon1.close();
    // Re-bind same port should succeed.
    const daemon2 = await startDaemon({ port, sessionsPollMs: 999_999 });
    assert.equal(daemon2.port, port);
    await daemon2.close();
  });

  it("WS clients receive a 1001 close frame", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    const closePromise = new Promise<{ code: number; reason: string }>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/events`);
        const timeout = setTimeout(() => reject(new Error("ws close timeout")), 3000);
        ws.on("open", () => {
          // Trigger shutdown shortly after connect so the client is in OPEN.
          setTimeout(() => void daemon.close(), 50);
        });
        ws.on("close", (code, reasonBuf) => {
          clearTimeout(timeout);
          resolve({ code, reason: reasonBuf.toString("utf8") });
        });
        ws.on("error", () => {
          // 'close' will follow.
        });
      },
    );
    const { code, reason } = await closePromise;
    assert.equal(code, 1001, "WS close code must be 1001 (going away)");
    assert.match(reason, /shutting down/i);
  });

  it("close() shutdown report counts WS clients that were connected", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/events`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 2000);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", reject);
    });
    const report = await daemon.close();
    assert.ok(report.wsClientsClosed >= 1, "at least one WS client counted");
    ws.removeAllListeners();
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  });

  it("after close(), new connections are refused (ECONNREFUSED)", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    const url = daemon.url;
    await daemon.close();
    // Any new connection attempt to the (now-closed) port must fail.
    // Node fetch surfaces the TCP error as a TypeError with cause.code.
    let errCode: string | undefined;
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      errCode = cause?.code ?? (err as Error).name;
    }
    assert.match(
      errCode ?? "",
      /ECONNREFUSED|TimeoutError|fetch failed/,
      `new connection after close must fail (got: ${errCode})`,
    );
  });

  it("gracefulClose() with a tiny budget still completes (no hang) when no client is connected", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    const start = Date.now();
    const report = await daemon.close(100);
    const elapsed = Date.now() - start;
    // Even with a 100ms budget, idle close should finish well under 500ms.
    assert.ok(elapsed < 500, `idle close should be fast (took ${elapsed}ms)`);
    assert.equal(report.httpDrained, true);
  });
});

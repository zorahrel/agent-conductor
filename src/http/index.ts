/**
 * agent-conductor HTTP daemon — public surface.
 *
 * Two entry shapes:
 *   - `startDaemon({ port? })` — convenience that starts HTTP + WS on the
 *     same loopback port, returns a single close() handle. The CLI uses this.
 *   - `startHttpServer()` + `attachWebSocket()` — pieces, for embedders that
 *     want to wire their own pollers / route their own upgrade events.
 *
 * Both honor the loopback Host guard and 127.0.0.1-only bind.
 */

import {
  startHttpServer,
  DEFAULT_PORT,
  PORT_SCAN_MAX,
  DEFAULT_DRAIN_MS,
  isLoopbackHost,
  dispatchHttp,
  type StartHttpOptions,
  type StartedHttp,
  type DispatchResult,
} from "./server.js";
import {
  attachWebSocket,
  WsBroadcaster,
  startSessionsDiffPoller,
  type AttachWsOptions,
  type AttachedWs,
  type WsEvent,
} from "./ws.js";

export {
  startHttpServer,
  attachWebSocket,
  WsBroadcaster,
  startSessionsDiffPoller,
  isLoopbackHost,
  dispatchHttp,
  DEFAULT_PORT,
  PORT_SCAN_MAX,
  DEFAULT_DRAIN_MS,
  type StartHttpOptions,
  type StartedHttp,
  type DispatchResult,
  type AttachWsOptions,
  type AttachedWs,
  type WsEvent,
};

export interface StartDaemonOptions extends StartHttpOptions, AttachWsOptions {}

export interface ShutdownReport {
  /** True when HTTP drained in-flight requests before the timeout. */
  httpDrained: boolean;
  /** In-flight HTTP requests at shutdown start. */
  inflightAtStart: number;
  /** WS clients that received a 1001 close frame (or were terminated). */
  wsClientsClosed: number;
  /** Wall-clock ms the shutdown actually took. */
  elapsedMs: number;
}

export interface StartedDaemon {
  /** Bound port. */
  port: number;
  /** Canonical loopback URL — useful for printing to stdout on boot. */
  url: string;
  /** Underlying HTTP server (exposed for tests / advanced embedders). */
  http: StartedHttp;
  /** WS attachment handle. */
  ws: AttachedWs;
  /**
   * Gracefully close HTTP + WS within `timeoutMs` (default 2000 — v0.5
   * spec AC8). Returns a report with drain status. Idempotent.
   */
  close: (timeoutMs?: number) => Promise<ShutdownReport>;
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<StartedDaemon> {
  const http = await startHttpServer(opts);
  const ws = attachWebSocket(http.server, opts);

  let closed = false;
  let cachedReport: ShutdownReport | null = null;
  const close = async (timeoutMs: number = DEFAULT_DRAIN_MS): Promise<ShutdownReport> => {
    if (closed) {
      return (
        cachedReport ?? {
          httpDrained: true,
          inflightAtStart: 0,
          wsClientsClosed: 0,
          elapsedMs: 0,
        }
      );
    }
    closed = true;
    const t0 = Date.now();
    // Snapshot the WS client count BEFORE close() (it tears them down).
    const wsClientsAtStart = http.server.listening ? ws.wss.clients.size : 0;
    // Close WS first so clients get a clean 1001; the HTTP server then
    // drains remaining HTTP requests. We split the budget 50/50.
    const half = Math.max(100, Math.floor(timeoutMs / 2));
    await ws.close(half);
    const httpReport = await http.gracefulClose(half);
    const report: ShutdownReport = {
      httpDrained: httpReport.drained,
      inflightAtStart: httpReport.inflightAtStart,
      wsClientsClosed: wsClientsAtStart,
      elapsedMs: Date.now() - t0,
    };
    cachedReport = report;
    return report;
  };

  return { port: http.port, url: http.url, http, ws, close };
}

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
  type StartHttpOptions,
  type StartedHttp,
  type DispatchResult,
  type AttachWsOptions,
  type AttachedWs,
  type WsEvent,
};

export interface StartDaemonOptions extends StartHttpOptions, AttachWsOptions {}

export interface StartedDaemon {
  /** Bound port. */
  port: number;
  /** Canonical loopback URL — useful for printing to stdout on boot. */
  url: string;
  /** Underlying HTTP server (exposed for tests / advanced embedders). */
  http: StartedHttp;
  /** WS attachment handle. */
  ws: AttachedWs;
  /** Gracefully close HTTP + WS. Idempotent. */
  close: () => Promise<void>;
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<StartedDaemon> {
  const http = await startHttpServer(opts);
  const ws = attachWebSocket(http.server, opts);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await ws.close();
    await new Promise<void>((resolve) => {
      http.server.close(() => resolve());
    });
  };

  return { port: http.port, url: http.url, http, ws, close };
}

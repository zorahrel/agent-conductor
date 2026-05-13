/**
 * agent-conductor HTTP daemon — public surface.
 *
 * Two entry shapes:
 *   - `startDaemon({ port?, timeseries? })` — convenience that starts HTTP +
 *     WS (and optionally the SQLite samples store) on the same loopback
 *     port, returns a single close() handle. The CLI uses this.
 *   - `startHttpServer()` + `attachWebSocket()` — pieces, for embedders
 *     that want to wire their own pollers / route their own upgrade events.
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
  type DispatchContext,
} from "./server.js";
import {
  attachWebSocket,
  WsBroadcaster,
  startSessionsDiffPoller,
  type AttachWsOptions,
  type AttachedWs,
  type WsEvent,
} from "./ws.js";
import { TimeseriesStore, type TimeseriesStoreOptions } from "../timeseries/store.js";

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
  type DispatchContext,
  type AttachWsOptions,
  type AttachedWs,
  type WsEvent,
};

export interface StartDaemonOptions
  extends Omit<StartHttpOptions, "ctx">,
    Omit<AttachWsOptions, "timeseriesStore" | "onSampleWritten"> {
  /**
   * Enable the SQLite samples store. Default false — opt-in to honor the
   * "no telemetry, no network" promise. Accepts a boolean (use defaults) or
   * an options object for custom path/maxRows.
   */
  timeseries?: boolean | TimeseriesStoreOptions;
}

export interface ShutdownReport {
  /** True when HTTP drained in-flight requests before the timeout. */
  httpDrained: boolean;
  /** In-flight HTTP requests at shutdown start. */
  inflightAtStart: number;
  /** WS clients that received a 1001 close frame (or were terminated). */
  wsClientsClosed: number;
  /** Wall-clock ms the shutdown actually took. */
  elapsedMs: number;
  /** Cumulative samples written to the store during this daemon's lifetime. */
  samplesWritten: number;
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
  /** Timeseries store when enabled — null when --timeseries flag was off. */
  store: TimeseriesStore | null;
  /** Cumulative samples written counter (survives store pruning). */
  samplesWritten: () => number;
  /**
   * Gracefully close HTTP + WS within `timeoutMs` (default 2000 — v0.5
   * spec AC8). Returns a report with drain status. Idempotent.
   */
  close: (timeoutMs?: number) => Promise<ShutdownReport>;
}

/** Decide whether timeseries should be enabled based on opts + env. */
function resolveTimeseries(
  opt: StartDaemonOptions["timeseries"],
): TimeseriesStoreOptions | null {
  if (opt === true) return {};
  if (opt && typeof opt === "object") return opt;
  if (process.env.AGENT_CONDUCTOR_TIMESERIES === "1") return {};
  return null;
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<StartedDaemon> {
  // 1. Optional samples store.
  const storeOpts = resolveTimeseries(opts.timeseries);
  const store = storeOpts ? new TimeseriesStore(storeOpts) : null;
  let writtenCount = 0;
  const samplesWritten = (): number => writtenCount;

  // 2. HTTP server with dispatch context so /metrics has live data.
  const ctx: DispatchContext = store ? { store, samplesWritten } : {};
  const http = await startHttpServer({ ...opts, ctx });

  // 3. WS server with optional sample writer hook.
  const ws = attachWebSocket(http.server, {
    ...opts,
    timeseriesStore: store ?? undefined,
    onSampleWritten: store ? () => (writtenCount += 1) : undefined,
  });

  let closed = false;
  let cachedReport: ShutdownReport | null = null;
  const close = async (
    timeoutMs: number = DEFAULT_DRAIN_MS,
  ): Promise<ShutdownReport> => {
    if (closed) {
      return (
        cachedReport ?? {
          httpDrained: true,
          inflightAtStart: 0,
          wsClientsClosed: 0,
          elapsedMs: 0,
          samplesWritten: writtenCount,
        }
      );
    }
    closed = true;
    const t0 = Date.now();
    const wsClientsAtStart = http.server.listening ? ws.wss.clients.size : 0;
    const half = Math.max(100, Math.floor(timeoutMs / 2));
    await ws.close(half);
    const httpReport = await http.gracefulClose(half);
    if (store) {
      try {
        store.close();
      } catch {
        // Closing a SQLite handle should not fail, but if it does we
        // don't want shutdown to surface an unrelated error.
      }
    }
    const report: ShutdownReport = {
      httpDrained: httpReport.drained,
      inflightAtStart: httpReport.inflightAtStart,
      wsClientsClosed: wsClientsAtStart,
      elapsedMs: Date.now() - t0,
      samplesWritten: writtenCount,
    };
    cachedReport = report;
    return report;
  };

  return { port: http.port, url: http.url, http, ws, store, samplesWritten, close };
}

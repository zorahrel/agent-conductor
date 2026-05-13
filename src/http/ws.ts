/**
 * WebSocket event stream — `ws://127.0.0.1:<port>/events`.
 *
 * Implements v0.5 spec AC5: clients connect once, receive newline-free JSON
 * frames as agent-conductor's pollers detect changes:
 *   - `{type: "todo:added"|"todo:completed"|"todo:updated", payload: TodoEvent}`
 *   - `{type: "sessions:update", payload: {pid, refinedStatus, previous}}`
 *
 * Architectural notes:
 *   - We share the HTTP server (single port for HTTP + WS) so AC4/AC5 use the
 *     same loopback Host guard. WS upgrade requests inherit the Host check.
 *   - The poll-and-diff loop for sessions lives here on purpose: v0.5 spec §5
 *     promises an Observatory singleton, but extracting it is a larger
 *     refactor (sequencing step 3). Inlining the diff state here ships AC5
 *     today without that prerequisite; the Observatory extraction can move
 *     this code without touching the broadcast contract.
 *   - We poll Reminders only when at least one client is subscribed. Idle
 *     daemon = zero background work (matches v0.4's "no telemetry, no
 *     network" promise modulo client-driven activity).
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isLoopbackHost } from "./server.js";
import {
  startReminderPolling,
  stopReminderPolling,
  type PollOptions,
} from "../reminders/poll.js";
import type { TodoEvent } from "../types/reminders.js";
import { allProviders } from "../providers/registry.js";
import { refinedStatusFor } from "../sessions/refinedStatus.js";
import type { RefinedStatus } from "../types/sessions.js";
import type { TimeseriesStore, Sample } from "../timeseries/store.js";

/** Default cadence — matches v0.5 spec §6 D5 (5s, ~ refinedStatus cache TTL × 2.5). */
const DEFAULT_SESSIONS_POLL_MS = 5_000;

export type WsEvent =
  | { type: "hello"; payload: { name: string; version: string; serverTime: string } }
  | { type: "todo:added"; payload: TodoEvent }
  | { type: "todo:completed"; payload: TodoEvent }
  | { type: "todo:updated"; payload: TodoEvent }
  | {
      type: "sessions:update";
      payload: {
        pid: number;
        refinedStatus: RefinedStatus;
        previous: RefinedStatus | null;
      };
    };

/**
 * Tiny broadcaster — subscribers register a callback, the server fans events
 * out to every subscriber. Decouples "I just learned X" (poll loops) from
 * "send X to N clients" (ws sockets).
 *
 * Exported so test code can subscribe without spinning up an actual socket.
 */
export class WsBroadcaster {
  private readonly subscribers = new Set<(e: WsEvent) => void>();

  subscribe(fn: (e: WsEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  size(): number {
    return this.subscribers.size;
  }

  emit(e: WsEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        // A bad subscriber must not break the broadcast — silently drop and
        // let the next iteration try the rest.
      }
    }
  }
}

/** Build-time embedded version. */
function serverVersion(): string {
  return (
    (globalThis as { __AGENT_CONDUCTOR_VERSION__?: string })
      .__AGENT_CONDUCTOR_VERSION__ ?? "dev"
  );
}

/**
 * Sessions diff poller — runs every `intervalMs` while at least one client is
 * subscribed. Compares each pid's refinedStatus to the previous tick and
 * emits a `sessions:update` for any delta.
 *
 * Returns a `stop()` thunk so the WS server can tear it down on the last
 * client disconnect.
 */
export interface DiffPollerOptions {
  /** Optional samples sink — when present, every observed status is recorded. */
  store?: TimeseriesStore;
  /**
   * Cumulative counter the caller maintains across pollers (so it survives
   * pruning + reflects rows actually written, not just rows currently in
   * the table). We bump it via the callback.
   */
  onSampleWritten?: () => void;
}

export function startSessionsDiffPoller(
  broadcaster: WsBroadcaster,
  intervalMs: number = DEFAULT_SESSIONS_POLL_MS,
  pollerOpts: DiffPollerOptions = {},
): () => void {
  let stopped = false;
  let prev = new Map<number, RefinedStatus>();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Aggregate per provider so we can tag samples with the provider that
      // discovered each session (Prometheus label).
      const byProvider = await Promise.all(
        allProviders().map(async (p) => {
          try {
            return { provider: p.name, sessions: await p.discover() };
          } catch {
            return { provider: p.name, sessions: [] };
          }
        }),
      );
      const sessions = byProvider.flatMap((b) => b.sessions);
      const providerByPid = new Map<number, string>();
      for (const b of byProvider) for (const s of b.sessions) providerByPid.set(s.pid, b.provider);

      const next = await refinedStatusFor(sessions);
      const now = Date.now();
      const samples: Sample[] = [];
      for (const [pid, status] of next.entries()) {
        const previous = prev.get(pid) ?? null;
        if (previous !== status) {
          broadcaster.emit({
            type: "sessions:update",
            payload: { pid, refinedStatus: status, previous },
          });
        }
        if (pollerOpts.store) {
          samples.push({
            ts: now,
            provider: providerByPid.get(pid) ?? "unknown",
            pid,
            refinedStatus: status,
            turnCount: null,
            toolCount: null,
            lastWriteAge: null,
          });
        }
      }
      if (pollerOpts.store && samples.length > 0) {
        try {
          pollerOpts.store.writeMany(samples);
          for (let i = 0; i < samples.length; i += 1) pollerOpts.onSampleWritten?.();
          // Opportunistic prune — cheap when under cap, no-op when not.
          pollerOpts.store.prune();
        } catch {
          // Disk full / locked / etc. Drop this batch silently — the
          // observability store must not break the live stream.
        }
      }
      prev = next;
    } catch {
      // Discovery failure is non-fatal; we'll retry next tick.
    }
  };

  // Fire-and-forget first tick so subscribers see initial state quickly.
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export interface AttachWsOptions {
  /**
   * Pre-built broadcaster. Tests can pass their own to assert against; the
   * normal path uses one created internally.
   */
  broadcaster?: WsBroadcaster;
  /** Reminders poll cadence override; passed through to startReminderPolling. */
  reminderPoll?: Partial<PollOptions>;
  /** Sessions diff poll cadence override (ms). */
  sessionsPollMs?: number;
  /** Optional timeseries store — when present, the diff poller writes samples. */
  timeseriesStore?: TimeseriesStore;
  /** Optional callback fired once per sample written. Used by Prometheus exporter. */
  onSampleWritten?: () => void;
}

export interface AttachedWs {
  broadcaster: WsBroadcaster;
  wss: WebSocketServer;
  /** Detach + close everything. Idempotent. */
  /** Detach + close everything. Idempotent. Drain budget defaults to 2s. */
  close: (timeoutMs?: number) => Promise<void>;
}

/**
 * Attach a WS server at `/events` on the given HTTP server. Wires reminders
 * polling + sessions diff polling to the broadcaster, and the broadcaster to
 * every connected client.
 */
export function attachWebSocket(
  http: HttpServer,
  opts: AttachWsOptions = {},
): AttachedWs {
  const broadcaster = opts.broadcaster ?? new WsBroadcaster();

  // `noServer: true` because we manually wire the upgrade so we can enforce
  // the loopback Host guard (mirrors the HTTP route gate in server.ts).
  const wss = new WebSocketServer({ noServer: true });

  let stopReminders: (() => void) | null = null;
  let stopSessions: (() => void) | null = null;

  const ensurePollersRunning = (): void => {
    if (broadcaster.size() === 0) return;
    if (!stopReminders) {
      // TodoEvent already has type "todo:added" | "todo:completed" | "todo:updated"
      // — no remapping needed; forward as-is.
      startReminderPolling({
        ...(opts.reminderPoll ?? {}),
        onEvent: (e: TodoEvent) => {
          broadcaster.emit({ type: e.type, payload: e });
        },
      });
      stopReminders = () => {
        try {
          stopReminderPolling();
        } catch {
          /* idempotent */
        }
      };
    }
    if (!stopSessions) {
      stopSessions = startSessionsDiffPoller(
        broadcaster,
        opts.sessionsPollMs ?? DEFAULT_SESSIONS_POLL_MS,
        { store: opts.timeseriesStore, onSampleWritten: opts.onSampleWritten },
      );
    }
  };

  const maybeStopPollers = (): void => {
    if (broadcaster.size() > 0) return;
    if (stopReminders) {
      stopReminders();
      stopReminders = null;
    }
    if (stopSessions) {
      stopSessions();
      stopSessions = null;
    }
  };

  // Each connection subscribes to the broadcaster; the unsubscribe runs when
  // the socket closes.
  wss.on("connection", (ws: WebSocket) => {
    const sendJson = (e: WsEvent): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(e));
      }
    };
    // Welcome frame — gives the client our version + server time without a
    // separate HTTP round-trip.
    sendJson({
      type: "hello",
      payload: {
        name: "agent-conductor",
        version: serverVersion(),
        serverTime: new Date().toISOString(),
      },
    });
    const unsubscribe = broadcaster.subscribe(sendJson);
    ensurePollersRunning();
    ws.on("close", () => {
      unsubscribe();
      maybeStopPollers();
    });
    ws.on("error", () => {
      // ws library emits 'close' after 'error'; the close handler does the
      // cleanup, so we don't double-unsubscribe here.
    });
  });

  // Manual upgrade handler — enforces /events path + loopback Host.
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isLoopbackHost(req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!req.url || !req.url.startsWith("/events")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };
  http.on("upgrade", onUpgrade);

  /**
   * Graceful WS shutdown (v0.5 spec AC8):
   * 1. Detach the upgrade handler so no new clients can join.
   * 2. Stop pollers.
   * 3. Send a 1001 ("going away") close frame to every connected client
   *    and wait for them to acknowledge — up to `timeoutMs`.
   * 4. Force-terminate any laggard via `ws.terminate()` once the budget
   *    is exhausted.
   * 5. Close the WebSocketServer itself.
   *
   * Without step 3 the `ws` library defaults to a 1005 ("no status") frame
   * on `wss.close()`, which most clients log as an abnormal disconnect.
   */
  const close = async (timeoutMs: number = 2_000): Promise<void> => {
    http.off("upgrade", onUpgrade);
    if (stopReminders) stopReminders();
    if (stopSessions) stopSessions();
    stopReminders = null;
    stopSessions = null;

    const clients = Array.from(wss.clients);
    if (clients.length > 0) {
      // Send 1001 to each and race their close events against the deadline.
      await new Promise<void>((resolve) => {
        let remaining = clients.length;
        const done = (): void => {
          remaining -= 1;
          if (remaining <= 0) resolve();
        };
        const timer = setTimeout(() => {
          // Hard stop — terminate anyone still connected.
          for (const c of clients) {
            if (c.readyState !== c.CLOSED) {
              try {
                c.terminate();
              } catch {
                /* ignore */
              }
            }
          }
          resolve();
        }, timeoutMs);
        timer.unref();
        for (const c of clients) {
          c.once("close", done);
          try {
            c.close(1001, "server shutting down");
          } catch {
            done();
          }
        }
      });
    }

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return { broadcaster, wss, close };
}

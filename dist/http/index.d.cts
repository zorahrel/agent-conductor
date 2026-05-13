import { Server, IncomingMessage } from 'node:http';
import { T as TimeseriesStore, a as TimeseriesStoreOptions } from '../store-a03wprzn.cjs';
import { WebSocketServer } from 'ws';
import { T as TodoEvent, P as PollOptions } from '../poll-BrgFV9zk.cjs';
import { R as RefinedStatus } from '../sessions-CdTstnnc.cjs';

/**
 * HTTP daemon — exposes the side-car library over loopback HTTP so non-Node
 * consumers (Swift menu-bar, Rust TUI, Python script, Tessera) can read the
 * same OrchestratorSnapshot without re-implementing discovery + JSONL tail.
 *
 * Implements v0.5 spec AC4 (GET /snapshot) plus the supporting routes the
 * spec implies for a usable daemon: /sessions, /audit, /health.
 *
 * Security model (single-user, single-machine — see docs/v0.5-spec.md §4):
 *   - Binds 127.0.0.1 only. No `0.0.0.0`, no remote.
 *   - Rejects any request whose `Host:` header is not a loopback name
 *     (`127.0.0.1:<port>` or `localhost:<port>`) with 403. This blocks DNS
 *     rebinding attacks where a remote attacker tricks the local browser
 *     into hitting the daemon with an attacker-controlled hostname.
 *   - No auth layer. Remote bind requires a reverse proxy with auth — not
 *     in scope for v0.5.
 *
 * Port picking: default 32140 (intentionally NOT the round 32100 / 32000),
 * if occupied we scan upward to 32199. Mirrors Tessera's port-scan UX.
 */

/** Default port range (inclusive). 32140 is rare-enough to avoid common collisions. */
declare const DEFAULT_PORT = 32140;
declare const PORT_SCAN_MAX = 32199;
/**
 * Loopback Host check — exported so the WS upgrade handler can reuse it.
 *
 * Accepts:
 *   - `127.0.0.1[:port]`
 *   - `localhost[:port]`
 *   - `[::1][:port]`  (IPv6 loopback)
 *
 * Rejects anything else (including `*.localtest.me`, `0.0.0.0`, the
 * machine's LAN IP, public DNS names). This is the DNS-rebinding guard.
 */
declare function isLoopbackHost(host: string | undefined): boolean;
/**
 * Core dispatcher — pure-ish: takes an IncomingMessage, returns the JSON
 * body and status. Exported so `server.spec.ts` can invoke it with a fake
 * request and assert the contract without spawning a server.
 *
 * The result is JSON unless `contentType` is set, in which case `body`
 * is treated as a string and served verbatim (used by /metrics).
 */
interface DispatchResult {
    status: number;
    body: unknown;
    /** Non-JSON Content-Type (e.g. Prometheus exposition). When set, body must be a string. */
    contentType?: string;
}
/**
 * Optional context for routes that need live state (timeseries store,
 * Prometheus exporter). When omitted, the corresponding routes either
 * degrade (e.g. /metrics returns only build_info) or 404.
 */
interface DispatchContext {
    store?: TimeseriesStore;
    samplesWritten?: () => number;
    todos?: () => {
        open: number;
        completed: number;
    } | undefined;
}
declare function dispatchHttp(req: IncomingMessage, ctx?: DispatchContext): Promise<DispatchResult>;
/**
 * Wire the dispatcher to a real HTTP server bound on loopback. Returns the
 * server instance so callers (CLI, tests, embedders) can attach a WS upgrade
 * handler and call `close()` on shutdown.
 *
 * Port selection: explicit `opts.port` is honoured exactly (fails if busy);
 * omitted port triggers the scan from DEFAULT_PORT.
 */
interface StartedHttp {
    server: Server;
    port: number;
    url: string;
    /**
     * Graceful shutdown — see v0.5 spec AC8.
     *
     * 1. Stop accepting new connections (`server.close()`).
     * 2. Wait for in-flight requests to finish, up to `timeoutMs`.
     * 3. On timeout, force-close residual connections via
     *    `server.closeAllConnections()` (Node >= 18.2).
     *
     * Resolves with `{drained: true, inflightAtStart, inflightAtEnd}` once
     * the server is fully closed. Idempotent.
     */
    gracefulClose: (timeoutMs?: number) => Promise<{
        drained: boolean;
        inflightAtStart: number;
        inflightAtEnd: number;
    }>;
}
/** Default drain budget for graceful shutdown (v0.5 spec AC8). */
declare const DEFAULT_DRAIN_MS = 2000;
interface StartHttpOptions {
    port?: number;
    scanFrom?: number;
    scanTo?: number;
    /** Dispatch context — feeds /metrics with live store + counter + todos. */
    ctx?: DispatchContext;
}
declare function startHttpServer(opts?: StartHttpOptions): Promise<StartedHttp>;

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

type WsEvent = {
    type: "hello";
    payload: {
        name: string;
        version: string;
        serverTime: string;
    };
} | {
    type: "todo:added";
    payload: TodoEvent;
} | {
    type: "todo:completed";
    payload: TodoEvent;
} | {
    type: "todo:updated";
    payload: TodoEvent;
} | {
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
declare class WsBroadcaster {
    private readonly subscribers;
    subscribe(fn: (e: WsEvent) => void): () => void;
    size(): number;
    emit(e: WsEvent): void;
}
/**
 * Sessions diff poller — runs every `intervalMs` while at least one client is
 * subscribed. Compares each pid's refinedStatus to the previous tick and
 * emits a `sessions:update` for any delta.
 *
 * Returns a `stop()` thunk so the WS server can tear it down on the last
 * client disconnect.
 */
interface DiffPollerOptions {
    /** Optional samples sink — when present, every observed status is recorded. */
    store?: TimeseriesStore;
    /**
     * Cumulative counter the caller maintains across pollers (so it survives
     * pruning + reflects rows actually written, not just rows currently in
     * the table). We bump it via the callback.
     */
    onSampleWritten?: () => void;
}
declare function startSessionsDiffPoller(broadcaster: WsBroadcaster, intervalMs?: number, pollerOpts?: DiffPollerOptions): () => void;
interface AttachWsOptions {
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
interface AttachedWs {
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
declare function attachWebSocket(http: Server, opts?: AttachWsOptions): AttachedWs;

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

interface StartDaemonOptions extends Omit<StartHttpOptions, "ctx">, Omit<AttachWsOptions, "timeseriesStore" | "onSampleWritten"> {
    /**
     * Enable the SQLite samples store. Default false — opt-in to honor the
     * "no telemetry, no network" promise. Accepts a boolean (use defaults) or
     * an options object for custom path/maxRows.
     */
    timeseries?: boolean | TimeseriesStoreOptions;
}
interface ShutdownReport {
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
interface StartedDaemon {
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
declare function startDaemon(opts?: StartDaemonOptions): Promise<StartedDaemon>;

export { type AttachWsOptions, type AttachedWs, DEFAULT_DRAIN_MS, DEFAULT_PORT, type DispatchContext, type DispatchResult, PORT_SCAN_MAX, type ShutdownReport, type StartDaemonOptions, type StartHttpOptions, type StartedDaemon, type StartedHttp, WsBroadcaster, type WsEvent, attachWebSocket, dispatchHttp, isLoopbackHost, startDaemon, startHttpServer, startSessionsDiffPoller };

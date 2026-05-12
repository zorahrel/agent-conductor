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

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { promises as fs } from "node:fs";
import {
  buildSnapshot,
  AUDIT_FILE_PATH,
} from "../index.js";
import {
  getProvider,
  allProviders,
  DEFAULT_PROVIDER_NAME,
} from "../providers/registry.js";

/** Default port range (inclusive). 32140 is rare-enough to avoid common collisions. */
export const DEFAULT_PORT = 32140;
export const PORT_SCAN_MAX = 32199;

/** Build-time embedded version (tsup `define`); falls back to "dev". */
function serverVersion(): string {
  return (
    (globalThis as { __AGENT_CONDUCTOR_VERSION__?: string })
      .__AGENT_CONDUCTOR_VERSION__ ?? "dev"
  );
}

/**
 * Public, JSON-only response writer. Centralised so the Content-Type +
 * encoding contract is consistent across every route (and any middleware
 * regression is caught in one place by `server.spec.ts`).
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text).toString(),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

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
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip optional port. IPv6 form is `[::1]:port`.
  let h = host;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return false;
    h = h.slice(1, end);
  } else {
    const colon = h.lastIndexOf(":");
    if (colon > 0) h = h.slice(0, colon);
  }
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Parse a query string into a flat string map. Stdlib `URL` does the heavy
 * lifting; we just return string values to keep handlers simple.
 */
function parseQuery(rawUrl: string): Record<string, string> {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) out[k] = v;
  return out;
}

/**
 * Sessions discovery, honoring `?provider=<name>` or `?provider=all`.
 * Mirrors the CLI semantics in src/cli/commands/snapshot.ts.
 */
async function discoverSessions(providerName: string) {
  if (providerName === "all") {
    const merged = await Promise.all(
      allProviders().map(async (p) => {
        try {
          return await p.discover();
        } catch {
          return [];
        }
      }),
    );
    return merged.flat();
  }
  const p = getProvider(providerName);
  if (!p) {
    throw new Error(
      `unknown provider '${providerName}'. Available: ${allProviders().map((x) => x.name).join(", ")}`,
    );
  }
  return await p.discover();
}

/**
 * The route table — pure functions of (query) → payload. Keeping each route
 * as a small async function makes them trivially mockable in tests.
 */
async function handleSnapshot(query: Record<string, string>): Promise<unknown> {
  const providerName = query.provider ?? DEFAULT_PROVIDER_NAME;
  const sessions = await discoverSessions(providerName);
  return await buildSnapshot(sessions);
}

async function handleSessions(query: Record<string, string>): Promise<unknown> {
  const providerName = query.provider ?? DEFAULT_PROVIDER_NAME;
  return await discoverSessions(providerName);
}

async function handleAudit(query: Record<string, string>): Promise<unknown> {
  const tail = Number(query.tail ?? "20");
  const limit = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 20;
  let raw: string;
  try {
    raw = await fs.readFile(AUDIT_FILE_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: AUDIT_FILE_PATH, total: 0, entries: [] };
    }
    throw err;
  }
  const entries: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return { path: AUDIT_FILE_PATH, total: entries.length, entries: entries.slice(-limit) };
}

function handleHealth(): unknown {
  return {
    ok: true,
    name: "agent-conductor",
    version: serverVersion(),
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
  };
}

const STARTED_AT = Date.now();

/**
 * Core dispatcher — pure-ish: takes an IncomingMessage, returns the JSON
 * body and status. Exported so `server.spec.ts` can invoke it with a fake
 * request and assert the contract without spawning a server.
 */
export interface DispatchResult {
  status: number;
  body: unknown;
}

export async function dispatchHttp(req: IncomingMessage): Promise<DispatchResult> {
  // 1. Method gate — read-only daemon, only GET (and HEAD via Node default).
  if (req.method !== "GET" && req.method !== "HEAD") {
    return { status: 405, body: { error: "method_not_allowed", allowed: ["GET"] } };
  }

  // 2. Loopback Host guard.
  if (!isLoopbackHost(req.headers.host)) {
    return {
      status: 403,
      body: {
        error: "non_loopback_host_rejected",
        host: req.headers.host ?? null,
        hint: "agent-conductor binds to 127.0.0.1 only. Set Host: 127.0.0.1 or localhost.",
      },
    };
  }

  // 3. Route.
  const rawUrl = req.url ?? "/";
  const path = rawUrl.split("?")[0] ?? "/";
  const query = parseQuery(rawUrl);

  try {
    switch (path) {
      case "/":
      case "/health":
        return { status: 200, body: handleHealth() };
      case "/snapshot":
        return { status: 200, body: await handleSnapshot(query) };
      case "/sessions":
        return { status: 200, body: await handleSessions(query) };
      case "/audit":
        return { status: 200, body: await handleAudit(query) };
      default:
        return {
          status: 404,
          body: {
            error: "not_found",
            path,
            routes: ["/health", "/snapshot", "/sessions", "/audit", "/events (WebSocket)"],
          },
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: "internal_error", message: msg } };
  }
}

/**
 * Picks an available port starting at `start`, scanning upward to `max`.
 * Resolves to the first port that successfully `listen`s, or rejects when
 * the range is exhausted.
 *
 * Why a probe loop instead of `:0` + read-back-port: we want the URL to be
 * predictable across restarts when nothing else is on the machine. Tessera
 * does the same (32123 + scan upward).
 */
function pickPort(start: number, max: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number): void => {
      if (p > max) {
        reject(new Error(`no free port in range ${start}..${max}`));
        return;
      }
      const probe = createServer();
      probe.unref();
      probe.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      probe.listen({ port: p, host: "127.0.0.1" }, () => {
        const addr = probe.address();
        probe.close(() => {
          resolve(typeof addr === "object" && addr ? addr.port : p);
        });
      });
    };
    tryPort(start);
  });
}

/**
 * Wire the dispatcher to a real HTTP server bound on loopback. Returns the
 * server instance so callers (CLI, tests, embedders) can attach a WS upgrade
 * handler and call `close()` on shutdown.
 *
 * Port selection: explicit `opts.port` is honoured exactly (fails if busy);
 * omitted port triggers the scan from DEFAULT_PORT.
 */
export interface StartHttpOptions {
  port?: number;
  scanFrom?: number;
  scanTo?: number;
}

export interface StartedHttp {
  server: Server;
  port: number;
  url: string;
}

export async function startHttpServer(
  opts: StartHttpOptions = {},
): Promise<StartedHttp> {
  const requested = opts.port;
  const listenPort =
    requested !== undefined
      ? requested
      : await pickPort(opts.scanFrom ?? DEFAULT_PORT, opts.scanTo ?? PORT_SCAN_MAX);

  const server = createServer((req, res) => {
    void (async () => {
      const { status, body } = await dispatchHttp(req);
      sendJson(res, status, body);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: listenPort, host: "127.0.0.1" }, () => resolve());
  });

  // Read back the actual bound port — when `listenPort` is 0 (dynamic),
  // server.address() reports the kernel-picked port, not 0.
  const addr = server.address();
  const port =
    typeof addr === "object" && addr !== null ? addr.port : listenPort;

  return { server, port, url: `http://127.0.0.1:${port}` };
}

/**
 * `agent-conductor serve` — start the HTTP + WebSocket daemon.
 *
 * Boots the loopback daemon (127.0.0.1 only — see src/http/server.ts §security),
 * prints the picked URL to stdout, and stays running until SIGINT/SIGTERM.
 *
 * Why this lives in its own subcommand: the daemon is opt-in. Library
 * consumers that only want `buildSnapshot()` from Node don't pay the WS
 * dependency cost at runtime (CommonJS imports of `agent-conductor` don't
 * touch `agent-conductor/http`).
 *
 * Signal handling: on SIGINT / SIGTERM we call `daemon.close()` and exit 0
 * within the v0.5 spec's 2s drain budget (AC8 — graceful shutdown).
 */

import { startDaemon } from "../../http/index.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagInt } from "../args.js";

const HELP = `Usage: agent-conductor serve [--port N]

Start the HTTP + WebSocket daemon on 127.0.0.1 (loopback only).

Routes:
  GET  /health        Server info + uptime
  GET  /snapshot      OrchestratorSnapshot (?provider=claude-code|aider|cursor-cli|all)
  GET  /sessions      Discovery only (cheaper)
  GET  /audit         Audit log tail (?tail=20)
  WS   /events        Live event stream — hello + todo:* + sessions:update

Flags:
  --port N            Bind to a specific port (fails if in use).
                      Default: pick the first free port from 32140 upward.
  -h, --help          Show this help

Security:
  The daemon binds 127.0.0.1 only. Any request whose Host: header is not a
  loopback name (127.0.0.1, localhost, ::1) is rejected with 403. There is
  no auth layer — remote access requires a reverse proxy you control.

Examples:
  agent-conductor serve
  agent-conductor serve --port 32200

  # Health check from another shell:
  curl http://127.0.0.1:32140/health

  # Snapshot via curl:
  curl http://127.0.0.1:32140/snapshot

  # Event stream (websocat / wscat / similar):
  wscat -c ws://127.0.0.1:32140/events
`;

export async function serveCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const port = flagInt(args, "port");

  const daemon = await startDaemon({ port });
  process.stdout.write(`agent-conductor: HTTP ${daemon.url}\n`);
  process.stdout.write(`agent-conductor: WS   ws://127.0.0.1:${daemon.port}/events\n`);
  process.stdout.write(`agent-conductor: PID  ${process.pid}\n`);
  process.stdout.write(`agent-conductor: ready (Ctrl+C to stop)\n`);

  // Park the process. Signal handlers below trigger the graceful shutdown.
  const exitOn = (signal: NodeJS.Signals): Promise<void> => {
    return (async () => {
      process.stdout.write(`\nagent-conductor: ${signal} received — draining...\n`);
      try {
        await daemon.close();
        process.stdout.write(`agent-conductor: closed cleanly\n`);
      } catch (err) {
        process.stderr.write(
          `agent-conductor: shutdown error: ${(err as Error).message}\n`,
        );
      }
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => void exitOn("SIGINT"));
  process.on("SIGTERM", () => void exitOn("SIGTERM"));

  // Resolve only on signal — keep the event loop alive.
  await new Promise<void>(() => {
    /* never resolves; serve forever */
  });
  return 0;
}

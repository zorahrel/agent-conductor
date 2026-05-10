/**
 * `agent-conductor snapshot` — build a full OrchestratorSnapshot for every
 * live Claude Code session discovered via `ps`. Outputs pretty table by
 * default, JSON with `--json`.
 */

import { buildSnapshot } from "../../sessions/snapshot.js";
import { claudeCodeProvider } from "../../discovery/claude-code.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor snapshot [--json] [--provider <name>]

Build OrchestratorSnapshot — every live AI coding session with refinedStatus,
last assistant summary, suggestion, action, conflict, tmux mapping.

Flags:
  --json              Output raw OrchestratorSnapshot JSON
  --provider <name>   Discovery provider (default: claude-code)
  -h, --help          Show this help
`;

export async function snapshotCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const provider = flagString(args, "provider") ?? "claude-code";
  if (provider !== "claude-code") {
    process.stderr.write(
      `agent-conductor: unknown provider '${provider}'. Available: claude-code (more in v0.4)\n`,
    );
    return 2;
  }

  const sessions = await claudeCodeProvider.discover();
  if (sessions.length === 0) {
    if (flagBool(args, "json")) {
      process.stdout.write(JSON.stringify({ generated_at: new Date().toISOString(), sessions: [] }, null, 2) + "\n");
    } else {
      process.stdout.write("No live Claude Code sessions detected.\n");
      process.stdout.write("(Run `claude` in a tmux pane and retry, or provide a custom DiscoveryProvider.)\n");
    }
    return 0;
  }

  const snap = await buildSnapshot(sessions);

  if (flagBool(args, "json")) {
    renderJson(snap);
    return 0;
  }

  const cols: Column<typeof snap.sessions[number]>[] = [
    { header: "PID", get: (e) => String(e.pid) },
    { header: "REPO", get: (e) => e.repo, max: 18 },
    { header: "BRANCH", get: (e) => e.branch ?? "—", max: 16 },
    { header: "STATUS", get: (e) => e.status },
    { header: "CONFIDENCE", get: (e) => e.confidence },
    { header: "TMUX", get: (e) => (e.tmux ? `${e.tmux.session}:${e.tmux.pane}` : "—") },
    { header: "CONFLICT", get: (e) => (e.conflict !== null ? String(e.conflict) : "—") },
    { header: "SUGGESTION", get: (e) => e.suggestion, max: 40 },
  ];
  renderTable(snap.sessions, cols);
  process.stdout.write(`\nGenerated at: ${snap.generated_at}\n`);
  process.stdout.write(`Sessions: ${snap.sessions.length}\n`);
  return 0;
}

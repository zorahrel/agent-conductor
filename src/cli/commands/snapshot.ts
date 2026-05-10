/**
 * `agent-conductor snapshot` — build a full OrchestratorSnapshot for every
 * live Claude Code session discovered via `ps`. Outputs pretty table by
 * default, JSON with `--json`.
 */

import { buildSnapshot } from "../../sessions/snapshot.js";
import {
  getProvider,
  allProviders,
  DEFAULT_PROVIDER_NAME,
} from "../../providers/registry.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor snapshot [--json] [--provider <name>] [--all-providers]

Build OrchestratorSnapshot — every live AI coding session with refinedStatus,
last assistant summary, suggestion, action, conflict, tmux mapping.

Flags:
  --json                  Output raw OrchestratorSnapshot JSON
  --provider <name>       Discovery provider (default: claude-code).
                          Available: claude-code, aider, cursor-cli
  --all-providers         Discover across every registered provider and merge
  -h, --help              Show this help

Examples:
  agent-conductor snapshot
  agent-conductor snapshot --provider aider
  agent-conductor snapshot --all-providers
`;

export async function snapshotCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const allMode = flagBool(args, "all-providers");
  const providerName = flagString(args, "provider") ?? DEFAULT_PROVIDER_NAME;

  let sessions;
  if (allMode) {
    const merged = await Promise.all(
      allProviders().map(async (p) => {
        try {
          return await p.discover();
        } catch {
          return [];
        }
      }),
    );
    sessions = merged.flat();
  } else {
    const provider = getProvider(providerName);
    if (!provider) {
      process.stderr.write(
        `agent-conductor: unknown provider '${providerName}'. Run 'agent-conductor providers list' to see available providers.\n`,
      );
      return 2;
    }
    sessions = await provider.discover();
  }
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

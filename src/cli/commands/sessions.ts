/**
 * `agent-conductor sessions` — discover live sessions without the full snapshot.
 * Cheaper than `snapshot` (no transcript reads, no conflict map, no tmux walk).
 */

import {
  getProvider,
  allProviders,
  DEFAULT_PROVIDER_NAME,
} from "../../providers/registry.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor sessions [--json] [--provider <name>] [--all-providers]

Discover live AI coding agent sessions (provider-specific signature match
on \`ps\`). Cheaper than \`snapshot\`: no JSONL reads, no conflict scan.

Flags:
  --json                  Output JSON array
  --provider <name>       Discovery provider (default: claude-code).
                          Available: claude-code, aider, cursor-cli
  --all-providers         Discover across every registered provider and merge
  -h, --help              Show this help
`;

export async function sessionsCmd(args: ParsedArgs): Promise<number> {
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

  if (flagBool(args, "json")) {
    renderJson(sessions);
    return 0;
  }
  if (sessions.length === 0) {
    process.stdout.write("No live sessions detected.\n");
    return 0;
  }
  const cols: Column<typeof sessions[number]>[] = [
    { header: "PID", get: (s) => String(s.pid) },
    { header: "REPO", get: (s) => s.repoName, max: 22 },
    { header: "BRANCH", get: (s) => s.branch ?? "—", max: 18 },
    { header: "CWD", get: (s) => s.cwd, max: 48 },
    {
      header: "TRANSCRIPT",
      get: (s) => (s.transcriptPath ? "yes" : "no"),
    },
  ];
  renderTable(sessions, cols);
  process.stdout.write(`\nDiscovered: ${sessions.length}\n`);
  return 0;
}

/**
 * `agent-conductor sessions` — discover live sessions without the full snapshot.
 * Cheaper than `snapshot` (no transcript reads, no conflict map, no tmux walk).
 */

import { claudeCodeProvider } from "../../discovery/claude-code.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor sessions [--json] [--provider <name>]

Discover live AI coding agent sessions (provider-specific signature match
on \`ps\`). Cheaper than \`snapshot\`: no JSONL reads, no conflict scan.

Flags:
  --json              Output JSON array
  --provider <name>   Discovery provider (default: claude-code)
  -h, --help          Show this help
`;

export async function sessionsCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const provider = flagString(args, "provider") ?? "claude-code";
  if (provider !== "claude-code") {
    process.stderr.write(
      `agent-conductor: unknown provider '${provider}'. Available: claude-code\n`,
    );
    return 2;
  }
  const sessions = await claudeCodeProvider.discover();

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

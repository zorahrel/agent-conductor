/**
 * `agent-conductor inject` — send keystrokes to a session's tmux pane, with audit.
 */

import { findPaneForPid, sendKeys } from "../../tmux/tmuxMap.js";
import { appendAudit } from "../../tmux/audit.js";
import { claudeCodeProvider } from "../../discovery/claude-code.js";
import { detectConflict } from "../../sessions/lock.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagInt, flagString } from "../args.js";
import { renderJson } from "./_render.js";

const HELP = `Usage: agent-conductor inject --pid <N> --text <string> [flags]

Send keystrokes to the tmux pane owning <pid>. Refuses if the pid isn't
under tmux. Refuses with cwd-collision unless --force is set.

Required:
  --pid <N>           Target session pid
  --text <string>     What to type (Enter is appended automatically)

Optional:
  --source <id>       Audit source label (default: cli)
  --force             Bypass cwd-collision conflict check
  --dry-run           Log what would be sent, no actual send-keys
  --json              JSON output
  -h, --help          Show this help

Examples:
  agent-conductor inject --pid 12345 --text y
  agent-conductor inject --pid 12345 --text "git status" --source ci
  agent-conductor inject --pid 12345 --text y --force      # bypass lock
`;

export async function injectCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const pid = flagInt(args, "pid");
  const text = flagString(args, "text");
  const source = flagString(args, "source") ?? "cli";
  const force = flagBool(args, "force");
  const dryRun = flagBool(args, "dry-run", "n");

  if (!pid || !text) {
    process.stderr.write("inject: --pid and --text are required\n\n");
    process.stderr.write(HELP);
    return 2;
  }

  // 1. Resolve pane
  let pane;
  try {
    pane = await findPaneForPid(pid);
  } catch (err) {
    process.stderr.write(`inject: tmux not available — ${(err as Error).message}\n`);
    return 3;
  }
  if (!pane) {
    process.stderr.write(`inject: pid ${pid} is not running under tmux (bare TTY sessions are read-only)\n`);
    return 3;
  }

  // 2. Conflict check (unless --force)
  if (!force) {
    const sessions = await claudeCodeProvider.discover();
    const me = sessions.find((s) => s.pid === pid);
    if (me) {
      for (const other of sessions) {
        if (other.pid === pid) continue;
        if (await detectConflict(me.cwd, other.cwd)) {
          process.stderr.write(
            `inject: cwd-collision with pid ${other.pid} (shared path: ${me.cwd}). Re-run with --force to bypass.\n`,
          );
          return 3;
        }
      }
    }
  }

  // 3. Send + audit
  const repoSlug = (await claudeCodeProvider.discover()).find((s) => s.pid === pid)?.repoName ?? "unknown";
  if (dryRun) {
    const payload = { pid, pane: pane.pane, session: pane.session, text, source, repo: repoSlug, dry_run: true };
    if (flagBool(args, "json")) renderJson(payload);
    else process.stdout.write(`[dry-run] would inject "${text}" → ${pane.session}:${pane.pane} (pid ${pid})\n`);
    return 0;
  }

  await sendKeys(pane.pane, text);
  await appendAudit({
    ts: Date.now(),
    pid,
    repo: repoSlug,
    action: "inject",
    text,
    source: source === "auto" ? "auto" : source === "skill" ? "skill" : "user-approved",
  });

  const result = { pid, pane: pane.pane, session: pane.session, sent: text };
  if (flagBool(args, "json")) {
    renderJson(result);
  } else {
    process.stdout.write(`Injected "${text}" → ${pane.session}:${pane.pane} (pid ${pid})\n`);
    process.stdout.write(`Audit written.\n`);
  }
  return 0;
}

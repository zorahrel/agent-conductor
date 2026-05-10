/**
 * agent-conductor CLI entry point.
 *
 * Subcommands:
 *   snapshot              Build OrchestratorSnapshot for live Claude Code sessions
 *   sessions              List discovered sessions with refinedStatus
 *   transcript <path>     Project last-N turns from a JSONL transcript file
 *   todos list            List todos from Apple Reminders
 *   todos add <title>     Create a new todo
 *   todos complete <id>   Mark a todo completed
 *   tmux panes            List every tmux pane (pid → session+pane)
 *   tmux find <pid>       Resolve which tmux pane owns a pid
 *   inject --pid N --text Send keystrokes to the pane owning <pid>
 *   audit [--tail N]      Show the last N entries from the audit log
 *
 * Run `agent-conductor <subcommand> --help` for per-command flags.
 *
 * Exit codes:
 *   0  success
 *   1  generic error (caught + logged)
 *   2  usage error (bad args, missing required flag)
 *   3  precondition failure (no tmux, list missing, etc.)
 */

import { parseArgs, flagString, flagBool, flagInt } from "./args.js";
import { snapshotCmd } from "./commands/snapshot.js";
import { sessionsCmd } from "./commands/sessions.js";
import { transcriptCmd } from "./commands/transcript.js";
import { todosCmd } from "./commands/todos.js";
import { tmuxCmd } from "./commands/tmux.js";
import { injectCmd } from "./commands/inject.js";
import { auditCmd } from "./commands/audit.js";
import { providersCmd } from "./commands/providers.js";

const HELP = `agent-conductor — pilot N concurrent AI coding agent CLI sessions from one place.

Usage:
  agent-conductor <command> [flags]

Commands:
  snapshot              Build OrchestratorSnapshot for live AI agent sessions
  sessions              List discovered sessions with refinedStatus
  transcript <path>     Project last-N turns from a JSONL transcript file
  todos <list|add|complete>   Manage Apple Reminders intent layer
  tmux <panes|find>     Inspect tmux pane mapping
  inject                Send keystrokes to a session's tmux pane (with audit)
  audit                 Show recent audit log entries
  providers <list|info> Inspect the multi-provider registry (Claude, Aider, …)

Common flags:
  -h, --help            Show this help
  -v, --version         Print package version
      --json            Force JSON output (most commands default to pretty)

Examples:
  agent-conductor snapshot
  agent-conductor sessions --json
  agent-conductor transcript ~/.claude/projects/-Users-me-app/abc.jsonl --limit 3
  agent-conductor todos list --list Personal
  agent-conductor todos add "Refactor auth"
  agent-conductor tmux find 12345
  agent-conductor inject --pid 12345 --text y --force
  agent-conductor audit --tail 20

Docs: https://github.com/zorahrel/agent-conductor
`;

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (flagBool(args, "h", "help") && args._.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  if (flagBool(args, "v", "version")) {
    // Embedded at build time via tsup `define` (falls back to "dev").
    const version = (globalThis as { __AGENT_CONDUCTOR_VERSION__?: string })
      .__AGENT_CONDUCTOR_VERSION__ ?? "dev";
    process.stdout.write(`agent-conductor v${version}\n`);
    return 0;
  }

  const [sub, ...subPositionals] = args._;
  if (!sub) {
    process.stdout.write(HELP);
    return 0;
  }

  // Subcommands receive the SAME parsed args (all flags propagate) but with the
  // first positional (the subcommand name) stripped. They read args._[0] as their
  // own first positional argument.
  const restArgs = { _: subPositionals, flags: args.flags };

  try {
    switch (sub) {
      case "snapshot":
        return await snapshotCmd(restArgs);
      case "sessions":
        return await sessionsCmd(restArgs);
      case "transcript":
        return await transcriptCmd(restArgs);
      case "todos":
        return await todosCmd(restArgs);
      case "tmux":
        return await tmuxCmd(restArgs);
      case "inject":
        return await injectCmd(restArgs);
      case "audit":
        return await auditCmd(restArgs);
      case "providers":
        return await providersCmd(restArgs);
      case "help":
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(`agent-conductor: unknown command '${sub}'\n\n`);
        process.stderr.write(HELP);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-conductor: ${msg}\n`);
    return 1;
  }
}

// Re-exports for embedding consumers
export { parseArgs, flagString, flagBool, flagInt };

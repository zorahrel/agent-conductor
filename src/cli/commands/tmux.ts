/**
 * `agent-conductor tmux <panes|find>` — pid↔pane inspection.
 */

import { listAllPanes, findPaneForPid } from "../../tmux/tmuxMap.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagInt } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor tmux <subcommand> [flags]

Subcommands:
  panes                           List every tmux pane (pid, session, pane)
  find <pid> | --pid <pid>        Resolve which pane owns a pid

Flags:
  --json                          JSON output
  -h, --help                      Show this help

Examples:
  agent-conductor tmux panes
  agent-conductor tmux find 12345
`;

export async function tmuxCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = args._[0];
  switch (sub) {
    case "panes":
      return await runPanes(args);
    case "find":
      return await runFind(args);
    default:
      process.stderr.write(`tmux: unknown subcommand '${sub ?? ""}'\n\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

async function runPanes(args: ParsedArgs): Promise<number> {
  let panes;
  try {
    panes = await listAllPanes();
  } catch (err) {
    process.stderr.write(`tmux not available: ${(err as Error).message}\n`);
    return 3;
  }
  if (flagBool(args, "json")) {
    renderJson(panes);
    return 0;
  }
  if (panes.length === 0) {
    process.stdout.write("(no tmux panes)\n");
    return 0;
  }
  const cols: Column<typeof panes[number]>[] = [
    { header: "PID", get: (p) => String(p.pid) },
    { header: "SESSION", get: (p) => p.session, max: 24 },
    { header: "PANE", get: (p) => p.pane },
  ];
  renderTable(panes, cols);
  process.stdout.write(`\nPanes: ${panes.length}\n`);
  return 0;
}

async function runFind(args: ParsedArgs): Promise<number> {
  const pid = flagInt(args, "pid") ?? Number(args._[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    process.stderr.write("tmux find: invalid or missing <pid>\n");
    return 2;
  }
  let pane;
  try {
    pane = await findPaneForPid(pid);
  } catch (err) {
    process.stderr.write(`tmux not available: ${(err as Error).message}\n`);
    return 3;
  }
  if (!pane) {
    if (flagBool(args, "json")) {
      renderJson(null);
    } else {
      process.stdout.write(`No tmux pane owns pid ${pid}\n`);
    }
    return 0;
  }
  if (flagBool(args, "json")) {
    renderJson(pane);
  } else {
    process.stdout.write(`pid ${pid} → ${pane.session}:${pane.pane}\n`);
  }
  return 0;
}

/**
 * `agent-conductor todos <list|add|complete>` — Apple Reminders intent layer.
 */

import { listTodos, addTodo, completeTodo, probeAuth } from "../../reminders/cli.js";
import { formatTodoMetadata } from "../../reminders/metadata.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString, flagInt } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor todos <subcommand> [flags]

Subcommands:
  list                            List open todos
  add <title>                     Create a new todo
  complete <id>                   Mark a todo completed

Flags:
  --list <name>                   Reminders list (default: AgentTasks)
  --notes <text>                  Notes body (add only)
  --due <ISO-date>                Due date (add only)
  --pid <N> --repo <slug> --phase <plan|exec|review>
                                  Attach metadata (add only)
  --json                          JSON output
  -h, --help                      Show this help

Examples:
  agent-conductor todos list --list Personal
  agent-conductor todos add "Refactor auth" --pid 1234 --repo demo-app --phase plan
  agent-conductor todos complete REM-001
`;

export async function todosCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = args._[0];
  const list = flagString(args, "list") ?? "AgentTasks";
  const auth = await probeAuth();
  if (!auth.authorized) {
    process.stderr.write(
      `agent-conductor: Reminders CLI not authorized (active=${auth.active}). Run \`tccutil reset Reminders\` then retry, or install \`brew install steipete/tap/remindctl\` and grant Calendars access.\n`,
    );
    return 3;
  }

  switch (sub) {
    case "list":
      return await runList(args, list);
    case "add":
      return await runAdd(args, list);
    case "complete":
      return await runComplete(args);
    default:
      process.stderr.write(`todos: unknown subcommand '${sub ?? ""}'\n\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

async function runList(args: ParsedArgs, list: string): Promise<number> {
  const todos = await listTodos(list);
  if (flagBool(args, "json")) {
    renderJson(todos);
    return 0;
  }
  if (todos.length === 0) {
    process.stdout.write(`(no open todos in "${list}")\n`);
    return 0;
  }
  const cols: Column<typeof todos[number]>[] = [
    { header: "ID", get: (t) => t.id.slice(0, 12), max: 14 },
    { header: "TITLE", get: (t) => t.title, max: 40 },
    { header: "DUE", get: (t) => t.due ?? "—" },
    { header: "PID", get: (t) => (t.metadata?.pid ? String(t.metadata.pid) : "—") },
    { header: "REPO", get: (t) => t.metadata?.repo ?? "—", max: 18 },
    { header: "PHASE", get: (t) => t.metadata?.phase ?? "—" },
  ];
  renderTable(todos, cols);
  process.stdout.write(`\nOpen: ${todos.length}\n`);
  return 0;
}

async function runAdd(args: ParsedArgs, list: string): Promise<number> {
  const title = args._[1];
  if (!title) {
    process.stderr.write("todos add: missing <title>\n");
    return 2;
  }
  const notes = flagString(args, "notes");
  const due = flagString(args, "due");
  const pid = flagInt(args, "pid");
  const repo = flagString(args, "repo");
  const phase = flagString(args, "phase");

  let body = notes ?? "";
  if (pid !== undefined && repo && (phase === "plan" || phase === "exec" || phase === "review")) {
    const meta = formatTodoMetadata({ pid, repo, phase });
    body = body ? `${body}\n\n${meta}` : meta;
  }

  const created = await addTodo({ title, notes: body || undefined, due }, list);
  if (flagBool(args, "json")) {
    renderJson(created);
  } else {
    process.stdout.write(`Created: ${created.id} — ${created.title}\n`);
    if (created.metadata?.pid) {
      process.stdout.write(
        `Metadata: pid=${created.metadata.pid} repo=${created.metadata.repo} phase=${created.metadata.phase}\n`,
      );
    }
  }
  return 0;
}

async function runComplete(args: ParsedArgs): Promise<number> {
  const id = args._[1];
  if (!id) {
    process.stderr.write("todos complete: missing <id>\n");
    return 2;
  }
  const result = await completeTodo(id);
  if (flagBool(args, "json")) {
    renderJson(result);
  } else {
    process.stdout.write(result.ok ? `Completed: ${id}\n` : `Failed to complete: ${id}\n`);
  }
  return result.ok ? 0 : 1;
}

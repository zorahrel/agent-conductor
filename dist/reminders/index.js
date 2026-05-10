import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// src/reminders/cli.ts

// src/reminders/metadata.ts
var META_LINE = /^pid:(\d+)\s+repo:([^\s]+)\s+phase:(plan|exec|review)\s*$/m;
function parseTodoMetadata(notes) {
  if (!notes) return {};
  const m = notes.match(META_LINE);
  if (!m) return {};
  return {
    pid: parseInt(m[1], 10),
    repo: m[2],
    phase: m[3]
  };
}
function formatTodoMetadata(meta) {
  return `pid:${meta.pid} repo:${meta.repo} phase:${meta.phase}`;
}

// src/reminders/cli.ts
var PRIORITY_TO_NUM = {
  none: 0,
  low: 1,
  medium: 5,
  high: 9
};
function normalizeRemindCtl(raw) {
  return {
    id: raw.id,
    title: raw.title,
    list: raw.list ?? raw.listName ?? "",
    notes: raw.notes ?? null,
    due: raw.due ?? null,
    priority: typeof raw.priority === "number" ? raw.priority : PRIORITY_TO_NUM[String(raw.priority ?? "none").toLowerCase()] ?? 0,
    completed: raw.completed ?? raw.isCompleted ?? false
  };
}
var execFileDefault = promisify(execFile);
var FALLBACK_FILE = join(homedir(), ".claude", "jarvis", "todos.json");
var ACTIVE_LIST = "AgentTasks";
async function getActiveCli(execFn = execFileDefault) {
  const candidates = [
    { bin: "remindctl", cli: "remindctl" },
    { bin: "reminder", cli: "apple-reminders-cli" },
    { bin: "ekctl", cli: "ekctl" }
  ];
  for (const { bin, cli } of candidates) {
    try {
      await execFn(bin, ["--version"]);
      return cli;
    } catch {
    }
  }
  return "fallback-file";
}
function binFor(cli) {
  if (cli === "apple-reminders-cli") return "reminder";
  if (cli === "ekctl") return "ekctl";
  return "remindctl";
}
async function probeAuth(cli = "remindctl", execFn = execFileDefault) {
  if (cli === "fallback-file") return { active: cli, authorized: true };
  try {
    const bin = binFor(cli);
    const { stdout } = await execFn(bin, ["status", "--json"]);
    const parsed = JSON.parse(stdout || "{}");
    return { active: cli, authorized: !!parsed.authorized };
  } catch (err) {
    const stderr = err.stderr ?? "";
    if (stderr.includes("not authorized")) return { active: cli, authorized: false };
    return { active: cli, authorized: false };
  }
}
async function listTodos(list = ACTIVE_LIST, cli = "remindctl", execFn = execFileDefault) {
  if (cli === "fallback-file") {
    try {
      const raw2 = await promises.readFile(FALLBACK_FILE, "utf8");
      const arr = JSON.parse(raw2);
      return arr.map((t) => ({ ...t, metadata: parseTodoMetadata(t.notes) }));
    } catch {
      return [];
    }
  }
  if (cli !== "remindctl") {
    console.warn(
      `[reminders] using fallback CLI ${cli} \u2014 JSON shape may differ from remindctl. Install steipete/remindctl for fully tested behavior: brew install steipete/tap/remindctl`
    );
  }
  const bin = binFor(cli);
  const args = cli === "remindctl" ? ["show", "all", "--list", list, "--json"] : ["show", "--list", list, "--json"];
  const { stdout } = await execFn(bin, args);
  const raw = JSON.parse(stdout || "[]");
  return raw.map((r) => {
    const normalized = normalizeRemindCtl(r);
    return { ...normalized, metadata: parseTodoMetadata(normalized.notes) };
  });
}
async function addTodo(input, list = ACTIVE_LIST, cli = "remindctl", execFn = execFileDefault) {
  const fullNotes = input.metadata ? (input.notes ? `${input.notes}

` : "") + formatTodoMetadata(input.metadata) : input.notes ?? "";
  if (cli === "fallback-file") {
    const todos = await listTodos(list, cli, execFn);
    const newTodo = {
      id: `local-${Date.now()}`,
      title: input.title,
      list,
      notes: fullNotes || null,
      due: input.due ?? null,
      priority: 0,
      completed: false,
      metadata: input.metadata ?? {}
    };
    await promises.mkdir(join(homedir(), ".claude", "jarvis"), { recursive: true });
    const onDisk = [...todos, newTodo].map(({ metadata: _m, ...rest }) => rest);
    await promises.writeFile(FALLBACK_FILE, JSON.stringify(onDisk, null, 2));
    return newTodo;
  }
  const bin = binFor(cli);
  const args = ["add", input.title, "--list", list];
  if (fullNotes) {
    args.push("--notes", fullNotes);
  }
  if (input.due) {
    args.push("--due", input.due);
  }
  args.push("--json");
  const { stdout } = await execFn(bin, args);
  const created = JSON.parse(stdout);
  const normalized = normalizeRemindCtl(created);
  return { ...normalized, metadata: parseTodoMetadata(normalized.notes) };
}
async function completeTodo(id, cli = "remindctl", execFn = execFileDefault) {
  if (cli === "fallback-file") {
    const todos = await listTodos(ACTIVE_LIST, cli, execFn);
    const next = todos.map((t) => t.id === id ? { ...t, completed: true } : t);
    const onDisk = next.map(({ metadata: _m, ...rest }) => rest);
    await promises.writeFile(FALLBACK_FILE, JSON.stringify(onDisk, null, 2));
    return { ok: true };
  }
  const bin = binFor(cli);
  await execFn(bin, ["complete", id, "--json"]);
  return { ok: true };
}

// src/reminders/poll.ts
function diffTodos(prev, next) {
  const events = [];
  const prevMap = new Map(prev.map((t) => [t.id, t]));
  for (const t of next) {
    const before = prevMap.get(t.id);
    if (!before) {
      events.push({ type: "todo:added", todo: t });
      continue;
    }
    if (!before.completed && t.completed) {
      events.push({ type: "todo:completed", todo: t });
      continue;
    }
    if (before.title !== t.title || before.notes !== t.notes || before.due !== t.due) {
      events.push({ type: "todo:updated", todo: t, previous: before });
    }
  }
  return events;
}
var pollHandle = null;
var prevState = [];
function startReminderPolling(opts) {
  if (pollHandle) return;
  const interval = opts.intervalMs ?? 3e3;
  const tick = async () => {
    try {
      const next = await listTodos(opts.list);
      const events = diffTodos(prevState, next);
      prevState = next;
      for (const e of events) {
        try {
          opts.onEvent(e);
        } catch (err) {
          opts.onError?.(err);
        }
      }
    } catch (err) {
      const msg = String(err.message ?? err);
      if (/list not found/i.test(msg) || /no such list/i.test(msg)) return;
      opts.onError?.(err);
    }
  };
  pollHandle = setInterval(tick, interval);
  void tick();
}
function stopReminderPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  prevState = [];
}

export { addTodo, completeTodo, diffTodos, formatTodoMetadata, getActiveCli, listTodos, parseTodoMetadata, probeAuth, startReminderPolling, stopReminderPolling };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map
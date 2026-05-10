'use strict';

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var util = require('util');
var os = require('os');

// src/jsonl/parser.ts
var DEFAULT_TAIL_BYTES = 256e3;
async function readJsonlTailLines(path, maxBytes = DEFAULT_TAIL_BYTES) {
  let fh = null;
  try {
    fh = await fs.promises.open(path, "r");
    const st = await fh.stat();
    const toRead = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - toRead);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const text = buf.toString("utf8");
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (fh) await fh.close().catch(() => void 0);
  }
}
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
async function extractToolUseEvents(path, lastNTurns = 5) {
  const lines = await readJsonlTailLines(path);
  if (lines.length === 0) return [];
  const allEvents = [];
  let turnIndex = -1;
  for (const line of lines) {
    const obj = safeParse(line);
    if (!obj) continue;
    if (obj.type === "assistant") {
      turnIndex++;
      const blocks = obj.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          allEvents.push({
            name: block.name,
            inputKeys: block.input ? Object.keys(block.input) : [],
            turnIndex
          });
        }
      }
    }
  }
  const totalTurns = turnIndex + 1;
  if (totalTurns <= 0) return [];
  const cutoff = Math.max(0, totalTurns - lastNTurns);
  return allEvents.filter((e) => e.turnIndex >= cutoff);
}
async function sumTokens(path) {
  const lines = await readJsonlTailLines(path);
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.type === "assistant" && obj.message?.usage) {
      const u = obj.message.usage;
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      cacheCreation += u.cache_creation_input_tokens ?? 0;
      cacheRead += u.cache_read_input_tokens ?? 0;
    }
  }
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: input + output + cacheCreation + cacheRead
  };
}
async function countTurns(path) {
  const lines = await readJsonlTailLines(path);
  let count = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.type === "assistant") count++;
  }
  return count;
}
async function extractLastAssistantTurn(transcriptPath) {
  const lines = await readJsonlTailLines(transcriptPath, 256e3);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === "assistant" && obj.message?.role === "assistant") {
        return {
          stop_reason: obj.message.stop_reason ?? null,
          content: obj.message.content ?? [],
          timestamp: obj.timestamp ?? "",
          uuid: obj.uuid ?? ""
        };
      }
    } catch {
    }
  }
  return null;
}
async function extractPendingToolUses(transcriptPath) {
  const lines = await readJsonlTailLines(transcriptPath, 256e3);
  const toolUses = /* @__PURE__ */ new Map();
  const matchedIds = /* @__PURE__ */ new Set();
  for (const raw of lines) {
    try {
      const obj = JSON.parse(raw);
      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "tool_use" && typeof block.id === "string") {
            toolUses.set(block.id, {
              id: block.id,
              name: typeof block.name === "string" ? block.name : "",
              input: block.input ?? null
            });
          }
        }
      }
      if (obj.type === "user" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            matchedIds.add(block.tool_use_id);
          }
        }
      }
    } catch {
    }
  }
  return [...toolUses.values()].filter((tu) => !matchedIds.has(tu.id));
}
async function getStopReason(transcriptPath) {
  const last = await extractLastAssistantTurn(transcriptPath);
  return last?.stop_reason ?? null;
}
var IDLE_THRESHOLD_MS = 3e4;
var CACHE_TTL_MS = 2e3;
var cache = null;
async function deriveRefinedStatus(s, opts) {
  if (!s.transcriptPath) return "idle";
  const last = await extractLastAssistantTurn(s.transcriptPath);
  const pending = await extractPendingToolUses(s.transcriptPath);
  if (pending.length > 0) return "tool_pending";
  if (opts?.pidAlive === false && last && last.stop_reason == null) return "crashed";
  const stat = await fs.promises.stat(s.transcriptPath).catch(() => null);
  const lastWriteAge = stat ? Date.now() - stat.mtimeMs : Infinity;
  if (last && last.stop_reason === "end_turn" && lastWriteAge >= IDLE_THRESHOLD_MS) {
    return "awaiting_user_input";
  }
  if (lastWriteAge < IDLE_THRESHOLD_MS) return "working";
  return "idle";
}
async function refinedStatusFor(sessions) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.statuses;
  const out = /* @__PURE__ */ new Map();
  const pairs = await Promise.all(
    sessions.map(async (s) => [s.pid, await deriveRefinedStatus(s)])
  );
  for (const [pid, st] of pairs) out.set(pid, st);
  cache = { at: Date.now(), statuses: out };
  return out;
}
async function findGitRoot(p) {
  let cur;
  try {
    cur = await fs.promises.realpath(p);
  } catch {
    return null;
  }
  while (cur !== "/" && cur !== "") {
    try {
      await fs.promises.stat(`${cur}/.git`);
      return cur;
    } catch {
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
async function detectConflict(a, b) {
  let ra, rb;
  try {
    [ra, rb] = await Promise.all([fs.promises.realpath(a), fs.promises.realpath(b)]);
  } catch {
    return false;
  }
  if (ra === rb) return true;
  if (ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep)) {
    const [ga, gb] = await Promise.all([findGitRoot(ra), findGitRoot(rb)]);
    if (ga && gb && ga !== gb) return false;
    return true;
  }
  return false;
}

// src/sessions/suggest.ts
var APPROVAL_PROMPT_RE = /\b(approve|approval|y\/n|proceed\?|continue\?)\b/;
function suggestNext(s) {
  switch (s.refinedStatus) {
    case "awaiting_user_input": {
      const last = (s.lastAssistantSummary ?? "").toLowerCase();
      const trimmed = last.trim();
      if (APPROVAL_PROMPT_RE.test(last) || /\?$/.test(trimmed)) {
        return {
          text: "Approve and proceed",
          action: { type: "inject", text: "y" },
          confidence: "high",
          reason: "explicit approval prompt"
        };
      }
      return {
        text: "Acknowledge",
        action: { type: "inject", text: "ok" },
        confidence: "low",
        reason: "ambiguous prompt"
      };
    }
    case "tool_pending":
      return {
        text: "Wait \u2014 tool call in flight",
        action: { type: "none", reason: "tool_use unmatched" },
        confidence: "high",
        reason: "tool_use unmatched"
      };
    case "crashed":
      return {
        text: "Restart session",
        action: { type: "restart" },
        confidence: "medium",
        reason: "process gone, transcript incomplete"
      };
    case "working":
      return {
        text: "Working \u2014 let it run",
        action: { type: "none", reason: "active progress" },
        confidence: "high",
        reason: "active progress"
      };
    case "idle":
      return {
        text: "Idle \u2014 check in",
        action: { type: "none", reason: "no recent activity" },
        confidence: "low",
        reason: "no recent activity but no prompt either"
      };
  }
}
var execFileDefault = util.promisify(child_process.execFile);
async function listAllPanes(execFn = execFileDefault) {
  let stdout;
  try {
    const r = await execFn("tmux", [
      "list-panes",
      "-aF",
      "#{pane_pid} #{session_name} #{pane_id} #{window_index} #{pane_active}"
    ]);
    stdout = r.stdout;
  } catch {
    return [];
  }
  return stdout.trim().split("\n").filter((l) => l.length > 0).map((line) => {
    const parts = line.split(" ");
    return {
      pid: parseInt(parts[0] ?? "0", 10),
      session: parts[1] ?? "",
      pane: parts[2] ?? "",
      windowIndex: parseInt(parts[3] ?? "0", 10),
      active: parts[4] === "1"
    };
  });
}
async function findPaneForPid(targetPid, execFn = execFileDefault, cachedPanes) {
  const panes = cachedPanes ? Array.from(cachedPanes.entries()).map(
    ([pid, v]) => ({ pid, session: v.session, pane: v.pane, windowIndex: 0, active: false })
  ) : await listAllPanes(execFn);
  if (panes.length === 0) return null;
  let cur = targetPid;
  for (let i = 0; i < 50 && cur > 1; i++) {
    const hit = panes.find((p) => p.pid === cur);
    if (hit) return { session: hit.session, pane: hit.pane };
    try {
      const { stdout } = await execFn("ps", ["-o", "ppid=", "-p", String(cur)]);
      const ppid = parseInt(stdout.trim(), 10);
      if (!ppid || ppid === cur) break;
      cur = ppid;
    } catch {
      return null;
    }
  }
  return null;
}
async function sendKeys(paneId, text, execFn = execFileDefault) {
  const lines = text.split("\n");
  const args = ["send-keys", "-t", paneId, "--"];
  for (const line of lines) {
    args.push(line);
    args.push("Enter");
  }
  await execFn("tmux", args);
}
async function capturePane(paneId, lines = 50, execFn = execFileDefault) {
  const { stdout } = await execFn("tmux", [
    "capture-pane",
    "-t",
    paneId,
    "-p",
    "-S",
    `-${lines}`
  ]);
  return stdout;
}

// src/sessions/snapshot.ts
async function buildTranscript(transcriptPath, pid, limit) {
  const lines = await readJsonlTailLines(transcriptPath, 256e3);
  const turns = [];
  for (const raw of lines) {
    try {
      const obj = JSON.parse(raw);
      if (obj.type !== "assistant" && obj.type !== "user") continue;
      const role = obj.message?.role;
      if (role !== "assistant" && role !== "user") continue;
      let content;
      if (typeof obj.message?.content === "string") {
        content = [{ type: "text", text: obj.message.content }];
      } else if (Array.isArray(obj.message?.content)) {
        content = obj.message.content;
      } else {
        content = [];
      }
      turns.push({
        role,
        content,
        stop_reason: obj.message?.stop_reason ?? null,
        timestamp: obj.timestamp ?? "",
        uuid: obj.uuid ?? ""
      });
    } catch {
    }
  }
  const out = turns.slice(Math.max(0, turns.length - limit));
  return { pid, turns: out };
}
async function getTmuxPanesOnce() {
  const out = /* @__PURE__ */ new Map();
  try {
    const rows = await listAllPanes();
    for (const r of rows) out.set(r.pid, { session: r.session, pane: r.pane });
  } catch {
  }
  return out;
}
function composeSnapshot(sessions, statusMap, lastByPid, conflictMap, tmuxByPid) {
  const entries = sessions.map((s) => {
    const status = statusMap.get(s.pid) ?? "idle";
    const lastSummary = lastByPid.get(s.pid) ?? null;
    const sug = suggestNext({ refinedStatus: status, lastAssistantSummary: lastSummary });
    return {
      pid: s.pid,
      repo: s.repoName ?? "",
      branch: s.branch ?? null,
      cwd: s.cwd,
      status,
      last_assistant_summary: lastSummary,
      suggestion: sug.text,
      action: sug.action,
      confidence: sug.confidence,
      todo_link: null,
      // populated by Plan 02-02 at consumer-side enrichment time
      tmux: tmuxByPid?.get(s.pid) ?? null,
      conflict: conflictMap.get(s.pid) ?? null
    };
  });
  return { generated_at: (/* @__PURE__ */ new Date()).toISOString(), sessions: entries };
}
async function buildSnapshot(sessions) {
  const statusMap = await refinedStatusFor(sessions);
  const lastByPid = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    if (!s.transcriptPath) {
      lastByPid.set(s.pid, null);
      continue;
    }
    const last = await extractLastAssistantTurn(s.transcriptPath).catch(() => null);
    const summary = last?.content?.find((b) => b.type === "text")?.text?.slice(0, 200) ?? null;
    lastByPid.set(s.pid, summary);
  }
  const conflictMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < sessions.length; i++) {
    let conflictPid = null;
    for (let j = 0; j < sessions.length; j++) {
      if (i === j) continue;
      if (await detectConflict(sessions[i].cwd, sessions[j].cwd)) {
        conflictPid = sessions[j].pid;
        break;
      }
    }
    conflictMap.set(sessions[i].pid, conflictPid);
  }
  const tmuxCache = await getTmuxPanesOnce();
  const tmuxByPid = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    const direct = tmuxCache.get(s.pid);
    if (direct) {
      tmuxByPid.set(s.pid, direct);
      continue;
    }
    const walked = await findPaneForPid(s.pid, void 0, tmuxCache).catch(() => null);
    tmuxByPid.set(s.pid, walked);
  }
  return composeSnapshot(sessions, statusMap, lastByPid, conflictMap, tmuxByPid);
}
function getAuditDir() {
  return process.env.JARVIS_AUDIT_DIR ?? path.join(os.homedir(), ".claude", "jarvis", "orchestrator");
}
var AUDIT_DIR = getAuditDir();
var AUDIT_FILE_PATH = path.join(getAuditDir(), "audit.jsonl");
var ROTATE_BYTES = 10 * 1024 * 1024;
var writeQueue = Promise.resolve();
function appendAudit(entry) {
  writeQueue = writeQueue.then(async () => {
    const dir = getAuditDir();
    const path$1 = path.join(dir, "audit.jsonl");
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      const st = await fs.promises.stat(path$1);
      if (st.size > ROTATE_BYTES) {
        const archive = `${path$1}.${Date.now()}`;
        await fs.promises.rename(path$1, archive);
      }
    } catch {
    }
    await fs.promises.appendFile(path$1, JSON.stringify(entry) + "\n", "utf8");
  }).catch(() => void 0);
  return writeQueue;
}

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
var execFileDefault2 = util.promisify(child_process.execFile);
var FALLBACK_FILE = path.join(os.homedir(), ".claude", "jarvis", "todos.json");
var ACTIVE_LIST = "AgentTasks";
async function getActiveCli(execFn = execFileDefault2) {
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
async function probeAuth(cli = "remindctl", execFn = execFileDefault2) {
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
async function listTodos(list = ACTIVE_LIST, cli = "remindctl", execFn = execFileDefault2) {
  if (cli === "fallback-file") {
    try {
      const raw2 = await fs.promises.readFile(FALLBACK_FILE, "utf8");
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
async function addTodo(input, list = ACTIVE_LIST, cli = "remindctl", execFn = execFileDefault2) {
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
    await fs.promises.mkdir(path.join(os.homedir(), ".claude", "jarvis"), { recursive: true });
    const onDisk = [...todos, newTodo].map(({ metadata: _m, ...rest }) => rest);
    await fs.promises.writeFile(FALLBACK_FILE, JSON.stringify(onDisk, null, 2));
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
async function completeTodo(id, cli = "remindctl", execFn = execFileDefault2) {
  if (cli === "fallback-file") {
    const todos = await listTodos(ACTIVE_LIST, cli, execFn);
    const next = todos.map((t) => t.id === id ? { ...t, completed: true } : t);
    const onDisk = next.map(({ metadata: _m, ...rest }) => rest);
    await fs.promises.writeFile(FALLBACK_FILE, JSON.stringify(onDisk, null, 2));
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
var execFileAsync = util.promisify(child_process.execFile);
async function listAllProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-axwo",
      "pid=,ppid=,command="
    ], { maxBuffer: 8 * 1024 * 1024 });
    return parsePsOutput(stdout);
  } catch {
    return [];
  }
}
function parsePsOutput(stdout) {
  const rows = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, command });
    }
  }
  return rows;
}

// src/discovery/claude-code.ts
var execFileAsync2 = util.promisify(child_process.execFile);
var CLAUDE_PATTERNS = [
  /\/claude\b/,
  /[/ ]node\b.+\bclaude\b/,
  /[/ ]claude --print/,
  /Claude\.app/
];
function looksLikeClaude(command) {
  return CLAUDE_PATTERNS.some((re) => re.test(command));
}
async function cwdOf(pid) {
  try {
    const { stdout } = await execFileAsync2(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { timeout: 1500 }
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1) || null;
    }
  } catch {
  }
  return null;
}
function encodeProjectPath(cwd) {
  return cwd.replace(/\//g, "-");
}
async function findTranscriptForCwd(cwd) {
  const root = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(cwd));
  let entries;
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path$1 = path.join(root, name);
    try {
      const st = await fs.promises.stat(path$1);
      if (!newest || st.mtimeMs > newest.mtime) {
        newest = { path: path$1, mtime: st.mtimeMs };
      }
    } catch {
    }
  }
  return newest?.path ?? null;
}
async function gitBranchOf(cwd) {
  try {
    const { stdout } = await execFileAsync2(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 1500 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
var claudeCodeProvider = {
  name: "claude-code",
  async discover() {
    const processes = await listAllProcesses();
    const candidates = processes.filter((p) => looksLikeClaude(p.command));
    const out = [];
    for (const p of candidates) {
      const cwd = await cwdOf(p.pid) ?? process.cwd();
      const branch = await gitBranchOf(cwd);
      const transcriptPath = await findTranscriptForCwd(cwd);
      out.push({
        pid: p.pid,
        cwd,
        repoName: path.basename(cwd),
        branch,
        status: "unknown",
        hookEvent: null,
        sessionId: null,
        transcriptPath,
        lastActivity: Date.now(),
        tty: null,
        parentCommand: null,
        preview: { lastUserMessage: null, lastAssistantText: null },
        isRouterSpawned: false
      });
    }
    return out;
  }
};

// src/providers/claude-code.ts
var claudeCodeProvider2 = {
  name: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's Claude Code CLI. JSONL transcripts under ~/.claude/projects/, tmux send-keys for inject.",
  async discover() {
    return claudeCodeProvider.discover();
  },
  async readTranscript(session, limit) {
    if (!session.transcriptPath) return null;
    const lines = await readJsonlTailLines(session.transcriptPath, 256e3);
    const turns = [];
    for (const raw of lines) {
      try {
        const obj = JSON.parse(raw);
        if (obj.type !== "assistant" && obj.type !== "user") continue;
        const role = obj.message?.role;
        if (role !== "assistant" && role !== "user") continue;
        let content;
        if (typeof obj.message?.content === "string") {
          content = [{ type: "text", text: obj.message.content }];
        } else if (Array.isArray(obj.message?.content)) {
          content = obj.message.content;
        } else {
          content = [];
        }
        turns.push({
          role,
          content,
          stop_reason: obj.message?.stop_reason ?? null,
          timestamp: obj.timestamp ?? "",
          uuid: obj.uuid ?? ""
        });
      } catch {
      }
    }
    return turns.slice(Math.max(0, turns.length - limit));
  },
  async deriveStatus(session) {
    return deriveRefinedStatus(session);
  },
  suggestNext(_session, lastAssistantSummary, refinedStatus) {
    return suggestNext({ refinedStatus, lastAssistantSummary });
  },
  async inject(session, text) {
    const pane = await findPaneForPid(session.pid).catch(() => null);
    if (!pane) {
      return { ok: false, reason: "no_tmux" };
    }
    await sendKeys(pane.pane, text);
    const ts = Date.now();
    await appendAudit({
      ts,
      pid: session.pid,
      repo: session.repoName,
      action: "inject",
      text,
      source: "user-approved"
    });
    return {
      ok: true,
      audit: { ts, pid: session.pid, text, method: "tmux:send-keys" }
    };
  }
};
var execFileAsync3 = util.promisify(child_process.execFile);
async function cwdOf2(pid) {
  try {
    const { stdout } = await execFileAsync3(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { timeout: 1500 }
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1) || null;
    }
  } catch {
  }
  return null;
}
var aiderProvider = {
  name: "aider",
  displayName: "Aider",
  description: "AI pair-programming CLI. Markdown transcripts in .aider.chat.history.md. Full transcript parser arrives in v0.5; discovery + tmux inject work today.",
  async discover() {
    const processes = await listAllProcesses();
    const out = [];
    for (const p of processes) {
      if (!/\baider\b/.test(p.command)) continue;
      const cwd = await cwdOf2(p.pid) ?? process.cwd();
      out.push({
        pid: p.pid,
        cwd,
        repoName: path.basename(cwd),
        branch: null,
        status: "unknown",
        hookEvent: null,
        sessionId: null,
        transcriptPath: null,
        // v0.5 will resolve `.aider.chat.history.md`
        lastActivity: Date.now(),
        tty: null,
        parentCommand: null,
        preview: { lastUserMessage: null, lastAssistantText: null },
        isRouterSpawned: false
      });
    }
    return out;
  },
  async readTranscript() {
    return null;
  },
  async deriveStatus(_session) {
    return "idle";
  },
  suggestNext() {
    return {
      text: "Switch to the aider terminal and continue the conversation.",
      action: { type: "none", reason: "aider provider transcript parser ships in v0.5" },
      confidence: "low",
      reason: "aider provider is a stub in v0.4 \u2014 discovery works, transcript+status do not"
    };
  },
  async inject(session, text) {
    const pane = await findPaneForPid(session.pid).catch(() => null);
    if (!pane) return { ok: false, reason: "no_tmux" };
    await sendKeys(pane.pane, text);
    const ts = Date.now();
    await appendAudit({
      ts,
      pid: session.pid,
      repo: session.repoName,
      action: "inject",
      text,
      source: "user-approved"
    });
    return { ok: true, audit: { ts, pid: session.pid, text, method: "tmux:send-keys" } };
  }
};
var execFileAsync4 = util.promisify(child_process.execFile);
async function cwdOf3(pid) {
  try {
    const { stdout } = await execFileAsync4(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { timeout: 1500 }
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1) || null;
    }
  } catch {
  }
  return null;
}
var cursorCliProvider = {
  name: "cursor-cli",
  displayName: "Cursor CLI",
  description: "Anysphere's Cursor CLI (`cursor-agent`). Transcript parser arrives in v0.5; discovery + tmux inject work today.",
  async discover() {
    const processes = await listAllProcesses();
    const out = [];
    for (const p of processes) {
      if (!/cursor[- ]?agent/i.test(p.command)) continue;
      const cwd = await cwdOf3(p.pid) ?? process.cwd();
      out.push({
        pid: p.pid,
        cwd,
        repoName: path.basename(cwd),
        branch: null,
        status: "unknown",
        hookEvent: null,
        sessionId: null,
        transcriptPath: null,
        lastActivity: Date.now(),
        tty: null,
        parentCommand: null,
        preview: { lastUserMessage: null, lastAssistantText: null },
        isRouterSpawned: false
      });
    }
    return out;
  },
  async readTranscript() {
    return null;
  },
  async deriveStatus() {
    return "idle";
  },
  suggestNext() {
    return {
      text: "Switch to Cursor and continue the conversation.",
      action: { type: "none", reason: "cursor-cli provider stub \u2014 full impl in v0.5" },
      confidence: "low",
      reason: "cursor-cli provider is a stub in v0.4"
    };
  },
  async inject(session, text) {
    const pane = await findPaneForPid(session.pid).catch(() => null);
    if (!pane) return { ok: false, reason: "no_tmux" };
    await sendKeys(pane.pane, text);
    const ts = Date.now();
    await appendAudit({
      ts,
      pid: session.pid,
      repo: session.repoName,
      action: "inject",
      text,
      source: "user-approved"
    });
    return { ok: true, audit: { ts, pid: session.pid, text, method: "tmux:send-keys" } };
  }
};

// src/providers/registry.ts
var registry = /* @__PURE__ */ new Map();
function registerProvider(provider) {
  registry.set(provider.name, provider);
}
function getProvider(name) {
  return registry.get(name);
}
function allProviders() {
  return Array.from(registry.values());
}
var DEFAULT_PROVIDER_NAME = "claude-code";
registerProvider(claudeCodeProvider2);
registerProvider(aiderProvider);
registerProvider(cursorCliProvider);

exports.AUDIT_DIR = AUDIT_DIR;
exports.AUDIT_FILE_PATH = AUDIT_FILE_PATH;
exports.DEFAULT_PROVIDER_NAME = DEFAULT_PROVIDER_NAME;
exports.ROTATE_BYTES = ROTATE_BYTES;
exports.addTodo = addTodo;
exports.aiderProvider = aiderProvider;
exports.allProviders = allProviders;
exports.appendAudit = appendAudit;
exports.buildSnapshot = buildSnapshot;
exports.buildTranscript = buildTranscript;
exports.capturePane = capturePane;
exports.claudeCodeAgentProvider = claudeCodeProvider2;
exports.completeTodo = completeTodo;
exports.composeSnapshot = composeSnapshot;
exports.countTurns = countTurns;
exports.cursorCliProvider = cursorCliProvider;
exports.deriveRefinedStatus = deriveRefinedStatus;
exports.detectConflict = detectConflict;
exports.diffTodos = diffTodos;
exports.extractLastAssistantTurn = extractLastAssistantTurn;
exports.extractPendingToolUses = extractPendingToolUses;
exports.extractToolUseEvents = extractToolUseEvents;
exports.findGitRoot = findGitRoot;
exports.findPaneForPid = findPaneForPid;
exports.formatTodoMetadata = formatTodoMetadata;
exports.getActiveCli = getActiveCli;
exports.getProvider = getProvider;
exports.getStopReason = getStopReason;
exports.listAllPanes = listAllPanes;
exports.listTodos = listTodos;
exports.parseTodoMetadata = parseTodoMetadata;
exports.probeAuth = probeAuth;
exports.readJsonlTailLines = readJsonlTailLines;
exports.refinedStatusFor = refinedStatusFor;
exports.registerProvider = registerProvider;
exports.sendKeys = sendKeys;
exports.startReminderPolling = startReminderPolling;
exports.stopReminderPolling = stopReminderPolling;
exports.suggestNext = suggestNext;
exports.sumTokens = sumTokens;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map
import { createInterface } from 'readline';
import { promises } from 'fs';
import { join, basename, sep, dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';

// src/mcp/server.ts

// src/mcp/protocol.ts
var MCP_PROTOCOL_VERSION = "2024-11-05";
var MCP_SERVER_NAME = "agent-conductor";
var JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
};
function jsonRpcSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  return { jsonrpc: "2.0", id, error };
}
function toolCallError(id, message) {
  return jsonRpcSuccess(id, {
    isError: true,
    content: [{ type: "text", text: message }]
  });
}
function toolCallSuccess(id, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return jsonRpcSuccess(id, {
    content: [{ type: "text", text }]
  });
}
var DEFAULT_TAIL_BYTES = 256e3;
async function readJsonlTailLines(path, maxBytes = DEFAULT_TAIL_BYTES) {
  let fh = null;
  try {
    fh = await promises.open(path, "r");
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
var IDLE_THRESHOLD_MS = 3e4;
var CACHE_TTL_MS = 2e3;
var cache = null;
async function deriveRefinedStatus(s, opts) {
  if (!s.transcriptPath) return "idle";
  const last = await extractLastAssistantTurn(s.transcriptPath);
  const pending = await extractPendingToolUses(s.transcriptPath);
  if (pending.length > 0) return "tool_pending";
  const stat = await promises.stat(s.transcriptPath).catch(() => null);
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
    cur = await promises.realpath(p);
  } catch {
    return null;
  }
  while (cur !== "/" && cur !== "") {
    try {
      await promises.stat(`${cur}/.git`);
      return cur;
    } catch {
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
async function detectConflict(a, b) {
  let ra, rb;
  try {
    [ra, rb] = await Promise.all([promises.realpath(a), promises.realpath(b)]);
  } catch {
    return false;
  }
  if (ra === rb) return true;
  if (ra.startsWith(rb + sep) || rb.startsWith(ra + sep)) {
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
var execFileDefault = promisify(execFile);
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

// src/sessions/snapshot.ts
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
  return process.env.JARVIS_AUDIT_DIR ?? join(homedir(), ".claude", "jarvis", "orchestrator");
}
getAuditDir();
var AUDIT_FILE_PATH = join(getAuditDir(), "audit.jsonl");
var ROTATE_BYTES = 10 * 1024 * 1024;
var writeQueue = Promise.resolve();
function appendAudit(entry) {
  writeQueue = writeQueue.then(async () => {
    const dir = getAuditDir();
    const path = join(dir, "audit.jsonl");
    await promises.mkdir(dir, { recursive: true });
    try {
      const st = await promises.stat(path);
      if (st.size > ROTATE_BYTES) {
        const archive = `${path}.${Date.now()}`;
        await promises.rename(path, archive);
      }
    } catch {
    }
    await promises.appendFile(path, JSON.stringify(entry) + "\n", "utf8");
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
var execFileDefault2 = promisify(execFile);
var FALLBACK_FILE = join(homedir(), ".claude", "jarvis", "todos.json");
var ACTIVE_LIST = "AgentTasks";
function binFor(cli) {
  if (cli === "apple-reminders-cli") return "reminder";
  if (cli === "ekctl") return "ekctl";
  return "remindctl";
}
async function listTodos(list = ACTIVE_LIST, cli = "remindctl", execFn = execFileDefault2) {
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
async function completeTodo(id, cli = "remindctl", execFn = execFileDefault2) {
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
var execFileAsync = promisify(execFile);
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
var execFileAsync2 = promisify(execFile);
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
  const root = join(homedir(), ".claude", "projects", encodeProjectPath(cwd));
  let entries;
  try {
    entries = await promises.readdir(root);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(root, name);
    try {
      const st = await promises.stat(path);
      if (!newest || st.mtimeMs > newest.mtime) {
        newest = { path, mtime: st.mtimeMs };
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
        repoName: basename(cwd),
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
var execFileAsync3 = promisify(execFile);
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
        repoName: basename(cwd),
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
var execFileAsync4 = promisify(execFile);
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
        repoName: basename(cwd),
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

// src/mcp/tools.ts
var stringArg = (args, key) => {
  const v = args[key];
  return typeof v === "string" ? v : void 0;
};
var numberArg = (args, key) => {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
};
var boolArg = (args, key) => {
  const v = args[key];
  return typeof v === "boolean" ? v : void 0;
};
var snapshotTool = {
  descriptor: {
    name: "snapshot",
    description: "Build an OrchestratorSnapshot for every live AI coding session: pid, repo, branch, refinedStatus, last assistant summary, deterministic suggestion + action, tmux pane mapping, cwd-collision conflict marker.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider name (claude-code | aider | cursor-cli). Default: claude-code. Use --all-providers semantics by passing 'all'."
        }
      },
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const providerName = stringArg(args, "provider") ?? DEFAULT_PROVIDER_NAME;
    let sessions;
    if (providerName === "all") {
      const merged = await Promise.all(
        allProviders().map(async (p) => {
          try {
            return await p.discover();
          } catch {
            return [];
          }
        })
      );
      sessions = merged.flat();
    } else {
      const p = getProvider(providerName);
      if (!p) {
        throw new Error(
          `unknown provider '${providerName}'. Available: ${allProviders().map((x) => x.name).join(", ")}`
        );
      }
      sessions = await p.discover();
    }
    return await buildSnapshot(sessions);
  }
};
var sessionsTool = {
  descriptor: {
    name: "sessions",
    description: "Discover live AI coding sessions (cheaper than snapshot \u2014 no transcript tail, no suggestion, no tmux lookup).",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider name. Default: claude-code. Use 'all' for every provider."
        }
      },
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const providerName = stringArg(args, "provider") ?? DEFAULT_PROVIDER_NAME;
    if (providerName === "all") {
      const merged = await Promise.all(
        allProviders().map(async (p2) => {
          try {
            return await p2.discover();
          } catch {
            return [];
          }
        })
      );
      return merged.flat();
    }
    const p = getProvider(providerName);
    if (!p) {
      throw new Error(
        `unknown provider '${providerName}'. Available: ${allProviders().map((x) => x.name).join(", ")}`
      );
    }
    return await p.discover();
  }
};
var transcriptTool = {
  descriptor: {
    name: "transcript",
    description: "Read the last N turns from a JSONL transcript at the given path (tails the last few KB rather than reading the whole file).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the .jsonl transcript file."
        },
        limit: {
          type: "number",
          description: "Number of recent lines to return (default: 5)."
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const path = stringArg(args, "path");
    if (!path) throw new Error("missing required arg: path");
    const limit = numberArg(args, "limit") ?? 5;
    const lines = await readJsonlTailLines(path, limit);
    const lastAssistant = await extractLastAssistantTurn(path);
    return { path, limit, lines, lastAssistant };
  }
};
var todosListTool = {
  descriptor: {
    name: "todos_list",
    description: "List todos from the Apple Reminders intent layer. macOS only; returns {authorized:false} on other platforms or when remindctl is missing.",
    inputSchema: {
      type: "object",
      properties: {
        list: {
          type: "string",
          description: "Reminders list name (default: AgentTasks)."
        }
      },
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const list = stringArg(args, "list") ?? "AgentTasks";
    return await listTodos(list);
  }
};
var todosAddTool = {
  descriptor: {
    name: "todos_add",
    description: "Create a new todo in the Apple Reminders intent layer.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Todo title." },
        body: {
          type: "string",
          description: "Optional body. Use 'pid:NNNN repo:foo phase:plan' metadata format."
        },
        list: { type: "string", description: "List name (default: AgentTasks)." }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const title = stringArg(args, "title");
    if (!title) throw new Error("missing required arg: title");
    const body = stringArg(args, "body");
    const list = stringArg(args, "list") ?? "AgentTasks";
    return await addTodo({ title, notes: body }, list);
  }
};
var todosCompleteTool = {
  descriptor: {
    name: "todos_complete",
    description: "Mark a todo completed in the Apple Reminders intent layer.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Reminder ID \u2014 full UUID or a unique prefix (remindctl resolves prefixes)."
        }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const id = stringArg(args, "id");
    if (!id) throw new Error("missing required arg: id");
    return await completeTodo(id);
  }
};
var injectTool = {
  descriptor: {
    name: "inject",
    description: "Send keystrokes to the tmux pane owning the given pid (with audit log). REQUIRES `approve: true` in arguments \u2014 mirrors the auto-pilot 'confidence === high' gate. Cwd-collision lock is enforced unless `force: true`.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Target process pid." },
        text: { type: "string", description: "Keystrokes to send (newline appended by sendKeys)." },
        approve: {
          type: "boolean",
          description: "Must be `true`. Explicit safety gate so MCP clients cannot inject without intent."
        },
        force: {
          type: "boolean",
          description: "Bypass the cwd-collision lock. Default false."
        },
        dryRun: {
          type: "boolean",
          description: "Audit-only, do not actually call tmux send-keys."
        },
        source: {
          type: "string",
          description: "Audit log `source` tag. Constrained to 'user-approved' | 'auto' | 'skill'; anything else (or omitted) is normalised to 'skill' since MCP callers are typically other agents invoking on the user's behalf."
        }
      },
      required: ["pid", "text", "approve"],
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const pid = numberArg(args, "pid");
    const text = stringArg(args, "text");
    const approve = boolArg(args, "approve");
    if (pid === void 0) throw new Error("missing required arg: pid (number)");
    if (text === void 0) throw new Error("missing required arg: text (string)");
    if (approve !== true) {
      throw new Error("missing required arg: approve === true (explicit safety gate)");
    }
    const force = boolArg(args, "force") ?? false;
    const dryRun = boolArg(args, "dryRun") ?? false;
    const sourceRaw = stringArg(args, "source");
    const source = sourceRaw === "user-approved" || sourceRaw === "auto" ? sourceRaw : "skill";
    const pane = await findPaneForPid(pid);
    if (!pane) {
      throw new Error(`precondition: pid ${pid} is not running under tmux (bare TTY sessions are read-only)`);
    }
    const sessions = await claudeCodeProvider2.discover();
    const me = sessions.find((s) => s.pid === pid);
    const repoSlug = me?.repoName ?? "unknown";
    if (!force && me) {
      for (const other of sessions) {
        if (other.pid === pid) continue;
        if (await detectConflict(me.cwd, other.cwd)) {
          throw new Error(
            `precondition: cwd_collision with pid ${other.pid} on path ${me.cwd} (use force:true to bypass)`
          );
        }
      }
    }
    if (dryRun) {
      return {
        ok: true,
        pid,
        pane: pane.pane,
        session: pane.session,
        repo: repoSlug,
        dryRun: true
      };
    }
    const ts = Date.now();
    await sendKeys(pane.pane, text);
    await appendAudit({ pid, repo: repoSlug, action: "inject", text, source, ts });
    return {
      ok: true,
      pid,
      pane: pane.pane,
      session: pane.session,
      repo: repoSlug,
      dryRun: false,
      audit: { ts, pid, repo: repoSlug, action: "inject", text, source }
    };
  }
};
var auditTailTool = {
  descriptor: {
    name: "audit_tail",
    description: "Return the last N entries from the inject audit log.",
    inputSchema: {
      type: "object",
      properties: {
        tail: { type: "number", description: "Number of entries (default: 20)." }
      },
      additionalProperties: false
    }
  },
  handler: async (args) => {
    const tail = numberArg(args, "tail") ?? 20;
    let raw;
    try {
      raw = await promises.readFile(AUDIT_FILE_PATH, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return { path: AUDIT_FILE_PATH, total: 0, entries: [] };
      }
      throw err;
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
      }
    }
    const slice = entries.slice(-tail);
    return { path: AUDIT_FILE_PATH, total: entries.length, entries: slice };
  }
};
var MCP_TOOLS = [
  snapshotTool,
  sessionsTool,
  transcriptTool,
  todosListTool,
  todosAddTool,
  todosCompleteTool,
  injectTool,
  auditTailTool
];
function findTool(name) {
  return MCP_TOOLS.find((t) => t.descriptor.name === name);
}
function allToolDescriptors() {
  return MCP_TOOLS.map((t) => t.descriptor);
}

// src/mcp/server.ts
function serverVersion() {
  return "0.5.0";
}
async function dispatch(req) {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return jsonRpcError(
      req.id ?? null,
      JsonRpcErrorCode.InvalidRequest,
      "invalid JSON-RPC envelope"
    );
  }
  const id = req.id ?? null;
  const isNotification = req.id === void 0;
  switch (req.method) {
    case "initialize": {
      req.params ?? {};
      const result = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: serverVersion() }
      };
      return isNotification ? null : jsonRpcSuccess(id, result);
    }
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return isNotification ? null : jsonRpcSuccess(id, {});
    case "tools/list": {
      const result = { tools: allToolDescriptors() };
      return jsonRpcSuccess(id, result);
    }
    case "tools/call": {
      const params = req.params;
      if (!params || typeof params.name !== "string") {
        return jsonRpcError(
          id,
          JsonRpcErrorCode.InvalidParams,
          "tools/call requires { name: string, arguments?: object }"
        );
      }
      const tool = findTool(params.name);
      if (!tool) {
        return jsonRpcError(
          id,
          JsonRpcErrorCode.MethodNotFound,
          `unknown tool '${params.name}'`
        );
      }
      try {
        const payload = await tool.handler(params.arguments ?? {});
        return toolCallSuccess(id, payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolCallError(id, msg);
      }
    }
    default:
      return jsonRpcError(
        id,
        JsonRpcErrorCode.MethodNotFound,
        `unknown method '${req.method}'`
      );
  }
}
function runStdioServer(opts = {}) {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const rl = createInterface({
    input: stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  const writeLine = (obj) => {
    stdout.write(JSON.stringify(obj) + "\n");
  };
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req;
      try {
        req = JSON.parse(trimmed);
      } catch (err) {
        writeLine(
          jsonRpcError(
            null,
            JsonRpcErrorCode.ParseError,
            `parse error: ${err.message}`
          )
        );
        return;
      }
      void (async () => {
        try {
          const res = await dispatch(req);
          if (res !== null) writeLine(res);
        } catch (err) {
          stderr.write(
            `agent-conductor mcp: dispatch crash: ${err.stack ?? String(err)}
`
          );
          writeLine(
            jsonRpcError(
              req.id ?? null,
              JsonRpcErrorCode.InternalError,
              `internal error: ${err.message}`
            )
          );
        }
      })();
    });
    rl.on("close", () => resolve());
  });
}

export { JsonRpcErrorCode, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_TOOLS, allToolDescriptors, dispatch, findTool, runStdioServer };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map
#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var util = require('util');
var os = require('os');
var readline = require('readline');

// src/cli/args.ts
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  let endOfOptions = false;
  const set = (key, value) => {
    const existing = flags[key];
    if (existing === void 0) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[key] = [String(existing), String(value)];
    }
  };
  while (i < argv.length) {
    const tok = argv[i];
    if (endOfOptions) {
      positional.push(tok);
      i++;
      continue;
    }
    if (tok === "--") {
      endOfOptions = true;
      i++;
      continue;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        const key = tok.slice(2, eq);
        const value = tok.slice(eq + 1);
        set(key, value);
        i++;
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("-")) {
          set(key, next);
          i += 2;
        } else {
          set(key, true);
          i++;
        }
      }
    } else if (tok.startsWith("-") && tok.length > 1) {
      const key = tok.slice(1, 2);
      const inline = tok.slice(2);
      if (inline) {
        set(key, inline);
        i++;
      } else {
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("-")) {
          set(key, next);
          i += 2;
        } else {
          set(key, true);
          i++;
        }
      }
    } else {
      positional.push(tok);
      i++;
    }
  }
  return { _: positional, flags };
}
function flagString(args, ...names) {
  for (const n of names) {
    const v = args.flags[n];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v[0];
  }
  return void 0;
}
function flagBool(args, ...names) {
  for (const n of names) {
    const v = args.flags[n];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v !== "false" && v !== "0";
  }
  return false;
}
function flagInt(args, ...names) {
  const s = flagString(args, ...names);
  if (s === void 0) return void 0;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) ? n : void 0;
}
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
function getAuditDir() {
  return process.env.JARVIS_AUDIT_DIR ?? path.join(os.homedir(), ".claude", "jarvis", "orchestrator");
}
getAuditDir();
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

// src/cli/commands/_render.ts
function renderJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
function clamp(s, max) {
  if (!max || s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}
function renderTable(rows, cols) {
  if (rows.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }
  const cells = rows.map((row) => cols.map((c) => clamp(c.get(row), c.max)));
  const widths = cols.map(
    (c, i) => Math.max(c.header.length, ...cells.map((r) => r[i].length))
  );
  const sep2 = widths.map((w) => "\u2500".repeat(w)).join("\u2500\u253C\u2500");
  const header = cols.map((c, i) => c.header.padEnd(widths[i])).join(" \u2502 ");
  process.stdout.write(header + "\n");
  process.stdout.write(sep2 + "\n");
  for (const r of cells) {
    process.stdout.write(r.map((v, i) => v.padEnd(widths[i])).join(" \u2502 ") + "\n");
  }
}

// src/cli/commands/snapshot.ts
var HELP = `Usage: agent-conductor snapshot [--json] [--provider <name>] [--all-providers]

Build OrchestratorSnapshot \u2014 every live AI coding session with refinedStatus,
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
async function snapshotCmd(args) {
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
      })
    );
    sessions = merged.flat();
  } else {
    const provider = getProvider(providerName);
    if (!provider) {
      process.stderr.write(
        `agent-conductor: unknown provider '${providerName}'. Run 'agent-conductor providers list' to see available providers.
`
      );
      return 2;
    }
    sessions = await provider.discover();
  }
  if (sessions.length === 0) {
    if (flagBool(args, "json")) {
      process.stdout.write(JSON.stringify({ generated_at: (/* @__PURE__ */ new Date()).toISOString(), sessions: [] }, null, 2) + "\n");
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
  const cols = [
    { header: "PID", get: (e) => String(e.pid) },
    { header: "REPO", get: (e) => e.repo, max: 18 },
    { header: "BRANCH", get: (e) => e.branch ?? "\u2014", max: 16 },
    { header: "STATUS", get: (e) => e.status },
    { header: "CONFIDENCE", get: (e) => e.confidence },
    { header: "TMUX", get: (e) => e.tmux ? `${e.tmux.session}:${e.tmux.pane}` : "\u2014" },
    { header: "CONFLICT", get: (e) => e.conflict !== null ? String(e.conflict) : "\u2014" },
    { header: "SUGGESTION", get: (e) => e.suggestion, max: 40 }
  ];
  renderTable(snap.sessions, cols);
  process.stdout.write(`
Generated at: ${snap.generated_at}
`);
  process.stdout.write(`Sessions: ${snap.sessions.length}
`);
  return 0;
}

// src/cli/commands/sessions.ts
var HELP2 = `Usage: agent-conductor sessions [--json] [--provider <name>] [--all-providers]

Discover live AI coding agent sessions (provider-specific signature match
on \`ps\`). Cheaper than \`snapshot\`: no JSONL reads, no conflict scan.

Flags:
  --json                  Output JSON array
  --provider <name>       Discovery provider (default: claude-code).
                          Available: claude-code, aider, cursor-cli
  --all-providers         Discover across every registered provider and merge
  -h, --help              Show this help
`;
async function sessionsCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP2);
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
      })
    );
    sessions = merged.flat();
  } else {
    const provider = getProvider(providerName);
    if (!provider) {
      process.stderr.write(
        `agent-conductor: unknown provider '${providerName}'. Run 'agent-conductor providers list' to see available providers.
`
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
  const cols = [
    { header: "PID", get: (s) => String(s.pid) },
    { header: "REPO", get: (s) => s.repoName, max: 22 },
    { header: "BRANCH", get: (s) => s.branch ?? "\u2014", max: 18 },
    { header: "CWD", get: (s) => s.cwd, max: 48 },
    {
      header: "TRANSCRIPT",
      get: (s) => s.transcriptPath ? "yes" : "no"
    }
  ];
  renderTable(sessions, cols);
  process.stdout.write(`
Discovered: ${sessions.length}
`);
  return 0;
}

// src/cli/commands/transcript.ts
var HELP3 = `Usage: agent-conductor transcript <path> [--limit N] [--json]

Project the last N turns from a Claude Code JSONL transcript. Skips
attachment + last-prompt rows. User content strings are normalized to
[{type:"text"}] for consistency.

Flags:
  --limit N           Max turns (default 10)
  --json              Output raw TranscriptResponse
  -h, --help          Show this help
`;
async function transcriptCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP3);
    return 0;
  }
  const path = args._[0];
  if (!path) {
    process.stderr.write("transcript: missing <path>\n\n");
    process.stderr.write(HELP3);
    return 2;
  }
  const limit = flagInt(args, "limit") ?? 10;
  const tx = await buildTranscript(path, 0, limit);
  if (flagBool(args, "json")) {
    renderJson(tx);
    return 0;
  }
  if (tx.turns.length === 0) {
    process.stdout.write("(no turns)\n");
    return 0;
  }
  for (const turn of tx.turns) {
    const text = turn.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    const toolUses = turn.content.filter((b) => b.type === "tool_use");
    process.stdout.write(`
\u2500\u2500 ${turn.role.toUpperCase()}  ${turn.timestamp}
`);
    if (text) process.stdout.write(text.slice(0, 500) + (text.length > 500 ? "\u2026" : "") + "\n");
    for (const tu of toolUses) {
      process.stdout.write(`   [tool_use ${tu.name ?? "?"}  id=${tu.id ?? "?"}]
`);
    }
    if (turn.stop_reason) {
      process.stdout.write(`   (stop_reason: ${turn.stop_reason})
`);
    }
  }
  return 0;
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

// src/cli/commands/todos.ts
var HELP4 = `Usage: agent-conductor todos <subcommand> [flags]

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
async function todosCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP4);
    return 0;
  }
  const sub = args._[0];
  const list = flagString(args, "list") ?? "AgentTasks";
  const auth = await probeAuth();
  if (!auth.authorized) {
    process.stderr.write(
      `agent-conductor: Reminders CLI not authorized (active=${auth.active}). Run \`tccutil reset Reminders\` then retry, or install \`brew install steipete/tap/remindctl\` and grant Calendars access.
`
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
      process.stderr.write(`todos: unknown subcommand '${sub ?? ""}'

`);
      process.stderr.write(HELP4);
      return 2;
  }
}
async function runList(args, list) {
  const todos = await listTodos(list);
  if (flagBool(args, "json")) {
    renderJson(todos);
    return 0;
  }
  if (todos.length === 0) {
    process.stdout.write(`(no open todos in "${list}")
`);
    return 0;
  }
  const cols = [
    { header: "ID", get: (t) => t.id.slice(0, 12), max: 14 },
    { header: "TITLE", get: (t) => t.title, max: 40 },
    { header: "DUE", get: (t) => t.due ?? "\u2014" },
    { header: "PID", get: (t) => t.metadata?.pid ? String(t.metadata.pid) : "\u2014" },
    { header: "REPO", get: (t) => t.metadata?.repo ?? "\u2014", max: 18 },
    { header: "PHASE", get: (t) => t.metadata?.phase ?? "\u2014" }
  ];
  renderTable(todos, cols);
  process.stdout.write(`
Open: ${todos.length}
`);
  return 0;
}
async function runAdd(args, list) {
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
  if (pid !== void 0 && repo && (phase === "plan" || phase === "exec" || phase === "review")) {
    const meta = formatTodoMetadata({ pid, repo, phase });
    body = body ? `${body}

${meta}` : meta;
  }
  const created = await addTodo({ title, notes: body || void 0, due }, list);
  if (flagBool(args, "json")) {
    renderJson(created);
  } else {
    process.stdout.write(`Created: ${created.id} \u2014 ${created.title}
`);
    if (created.metadata?.pid) {
      process.stdout.write(
        `Metadata: pid=${created.metadata.pid} repo=${created.metadata.repo} phase=${created.metadata.phase}
`
      );
    }
  }
  return 0;
}
async function runComplete(args) {
  const id = args._[1];
  if (!id) {
    process.stderr.write("todos complete: missing <id>\n");
    return 2;
  }
  const result = await completeTodo(id);
  if (flagBool(args, "json")) {
    renderJson(result);
  } else {
    process.stdout.write(result.ok ? `Completed: ${id}
` : `Failed to complete: ${id}
`);
  }
  return result.ok ? 0 : 1;
}

// src/cli/commands/tmux.ts
var HELP5 = `Usage: agent-conductor tmux <subcommand> [flags]

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
async function tmuxCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP5);
    return 0;
  }
  const sub = args._[0];
  switch (sub) {
    case "panes":
      return await runPanes(args);
    case "find":
      return await runFind(args);
    default:
      process.stderr.write(`tmux: unknown subcommand '${sub ?? ""}'

`);
      process.stderr.write(HELP5);
      return 2;
  }
}
async function runPanes(args) {
  let panes;
  try {
    panes = await listAllPanes();
  } catch (err) {
    process.stderr.write(`tmux not available: ${err.message}
`);
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
  const cols = [
    { header: "PID", get: (p) => String(p.pid) },
    { header: "SESSION", get: (p) => p.session, max: 24 },
    { header: "PANE", get: (p) => p.pane }
  ];
  renderTable(panes, cols);
  process.stdout.write(`
Panes: ${panes.length}
`);
  return 0;
}
async function runFind(args) {
  const pid = flagInt(args, "pid") ?? Number(args._[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    process.stderr.write("tmux find: invalid or missing <pid>\n");
    return 2;
  }
  let pane;
  try {
    pane = await findPaneForPid(pid);
  } catch (err) {
    process.stderr.write(`tmux not available: ${err.message}
`);
    return 3;
  }
  if (!pane) {
    if (flagBool(args, "json")) {
      renderJson(null);
    } else {
      process.stdout.write(`No tmux pane owns pid ${pid}
`);
    }
    return 0;
  }
  if (flagBool(args, "json")) {
    renderJson(pane);
  } else {
    process.stdout.write(`pid ${pid} \u2192 ${pane.session}:${pane.pane}
`);
  }
  return 0;
}

// src/cli/commands/inject.ts
var HELP6 = `Usage: agent-conductor inject --pid <N> --text <string> [flags]

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
async function injectCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP6);
    return 0;
  }
  const pid = flagInt(args, "pid");
  const text = flagString(args, "text");
  const source = flagString(args, "source") ?? "cli";
  const force = flagBool(args, "force");
  const dryRun = flagBool(args, "dry-run", "n");
  if (!pid || !text) {
    process.stderr.write("inject: --pid and --text are required\n\n");
    process.stderr.write(HELP6);
    return 2;
  }
  let pane;
  try {
    pane = await findPaneForPid(pid);
  } catch (err) {
    process.stderr.write(`inject: tmux not available \u2014 ${err.message}
`);
    return 3;
  }
  if (!pane) {
    process.stderr.write(`inject: pid ${pid} is not running under tmux (bare TTY sessions are read-only)
`);
    return 3;
  }
  if (!force) {
    const sessions = await claudeCodeProvider.discover();
    const me = sessions.find((s) => s.pid === pid);
    if (me) {
      for (const other of sessions) {
        if (other.pid === pid) continue;
        if (await detectConflict(me.cwd, other.cwd)) {
          process.stderr.write(
            `inject: cwd-collision with pid ${other.pid} (shared path: ${me.cwd}). Re-run with --force to bypass.
`
          );
          return 3;
        }
      }
    }
  }
  const repoSlug = (await claudeCodeProvider.discover()).find((s) => s.pid === pid)?.repoName ?? "unknown";
  if (dryRun) {
    const payload = { pid, pane: pane.pane, session: pane.session, text, source, repo: repoSlug, dry_run: true };
    if (flagBool(args, "json")) renderJson(payload);
    else process.stdout.write(`[dry-run] would inject "${text}" \u2192 ${pane.session}:${pane.pane} (pid ${pid})
`);
    return 0;
  }
  await sendKeys(pane.pane, text);
  await appendAudit({
    ts: Date.now(),
    pid,
    repo: repoSlug,
    action: "inject",
    text,
    source: source === "auto" ? "auto" : source === "skill" ? "skill" : "user-approved"
  });
  const result = { pid, pane: pane.pane, session: pane.session, sent: text };
  if (flagBool(args, "json")) {
    renderJson(result);
  } else {
    process.stdout.write(`Injected "${text}" \u2192 ${pane.session}:${pane.pane} (pid ${pid})
`);
    process.stdout.write(`Audit written.
`);
  }
  return 0;
}
var HELP7 = `Usage: agent-conductor audit [--tail N] [--json]

Show the tail of the audit log (default: 20 entries).
Audit path is overridable via the AGENT_CONDUCTOR_AUDIT_DIR env var.

Flags:
  --tail N            How many entries (default 20)
  --json              JSON output (one array)
  -h, --help          Show this help
`;
async function auditCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP7);
    return 0;
  }
  const tail = flagInt(args, "tail") ?? 20;
  let raw;
  try {
    raw = await fs.promises.readFile(AUDIT_FILE_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      if (flagBool(args, "json")) renderJson([]);
      else process.stdout.write(`(no audit log yet at ${AUDIT_FILE_PATH})
`);
      return 0;
    }
    process.stderr.write(`audit: ${err.message}
`);
    return 1;
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
    }
  }
  const slice = rows.slice(-tail);
  if (flagBool(args, "json")) {
    renderJson(slice);
    return 0;
  }
  if (slice.length === 0) {
    process.stdout.write("(audit log empty)\n");
    return 0;
  }
  const cols = [
    { header: "WHEN", get: (r) => new Date(r.ts).toISOString() },
    { header: "PID", get: (r) => String(r.pid) },
    { header: "REPO", get: (r) => r.repo, max: 18 },
    { header: "ACTION", get: (r) => r.action },
    { header: "SOURCE", get: (r) => r.source },
    { header: "TEXT", get: (r) => r.text ?? "\u2014", max: 32 }
  ];
  renderTable(slice, cols);
  process.stdout.write(`
Showing last ${slice.length} of ${rows.length} entries from ${AUDIT_FILE_PATH}
`);
  return 0;
}

// src/cli/commands/providers.ts
var HELP8 = `Usage: agent-conductor providers <subcommand> [flags]

Subcommands:
  list                List every registered AgentProvider
  info <name>         Show full description + capabilities for one provider

Flags:
  --json              JSON output
  -h, --help          Show this help

Examples:
  agent-conductor providers list
  agent-conductor providers info aider
  agent-conductor providers list --json
`;
async function providersCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP8);
    return 0;
  }
  const sub = args._[0];
  switch (sub) {
    case "list":
      return runList2(args);
    case "info":
      return runInfo(args);
    default:
      process.stderr.write(`providers: unknown subcommand '${sub ?? ""}'

`);
      process.stderr.write(HELP8);
      return 2;
  }
}
function runList2(args) {
  const providers = allProviders();
  if (flagBool(args, "json")) {
    renderJson(
      providers.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        isDefault: p.name === DEFAULT_PROVIDER_NAME
      }))
    );
    return 0;
  }
  const cols = [
    { header: "NAME", get: (p) => p.name },
    { header: "DISPLAY", get: (p) => p.displayName, max: 18 },
    { header: "DEFAULT", get: (p) => p.name === DEFAULT_PROVIDER_NAME ? "\u2605" : "" },
    { header: "DESCRIPTION", get: (p) => p.description, max: 72 }
  ];
  renderTable(providers, cols);
  process.stdout.write(`
Registered: ${providers.length} provider(s). Default: ${DEFAULT_PROVIDER_NAME}
`);
  return 0;
}
function runInfo(args) {
  const name = args._[1];
  if (!name) {
    process.stderr.write("providers info: missing <name>\n");
    return 2;
  }
  const p = getProvider(name);
  if (!p) {
    process.stderr.write(
      `providers info: '${name}' not registered. Run 'agent-conductor providers list' to see available providers.
`
    );
    return 2;
  }
  if (flagBool(args, "json")) {
    renderJson({
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      isDefault: p.name === DEFAULT_PROVIDER_NAME,
      capabilities: {
        discover: true,
        readTranscript: typeof p.readTranscript === "function",
        deriveStatus: typeof p.deriveStatus === "function",
        suggestNext: typeof p.suggestNext === "function",
        inject: typeof p.inject === "function"
      }
    });
    return 0;
  }
  process.stdout.write(`Provider:    ${p.displayName} (${p.name})${p.name === DEFAULT_PROVIDER_NAME ? "  \u2605 default" : ""}
`);
  process.stdout.write(`Description: ${p.description}

`);
  process.stdout.write(`Capabilities (all providers implement the AgentProvider interface;
`);
  process.stdout.write(`stub providers may return null / no-op until full implementation lands):
`);
  process.stdout.write(`  - discover()        : best-effort 'ps'-based scan
`);
  process.stdout.write(`  - readTranscript()  : reads provider-specific transcript format
`);
  process.stdout.write(`  - deriveStatus()    : awaiting_user_input | tool_pending | crashed | working | idle
`);
  process.stdout.write(`  - suggestNext()     : deterministic next-step (no LLM calls)
`);
  process.stdout.write(`  - inject()          : tmux send-keys (or provider-specific channel)
`);
  return 0;
}

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
      raw = await fs.promises.readFile(AUDIT_FILE_PATH, "utf8");
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
  return "0.4.0";
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
  const rl = readline.createInterface({
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

// src/cli/commands/mcp.ts
var HELP9 = `Usage: agent-conductor mcp

Start the MCP stdio server. Reads JSON-RPC 2.0 messages on stdin, writes
responses on stdout. Exits 0 when stdin closes.

This is the side-car / observability surface intended to be consumed by
MCP clients (Claude Code, Codex, Tessera, custom dashboards) so they can
see and pilot AI coding sessions the client did not spawn itself.

Flags:
  -h, --help          Show this help

Examples:
  # As a server in an MCP client config (claude desktop, etc.):
  # {
  #   "mcpServers": {
  #     "agent-conductor": { "command": "agent-conductor", "args": ["mcp"] }
  #   }
  # }

  # Quick stdio handshake test:
  printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \\
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | agent-conductor mcp
`;
async function mcpCmd(args) {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP9);
    return 0;
  }
  await runStdioServer();
  return 0;
}

// src/cli/index.ts
var HELP10 = `agent-conductor \u2014 pilot N concurrent AI coding agent CLI sessions from one place.

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
  providers <list|info> Inspect the multi-provider registry (Claude, Aider, \u2026)
  mcp                   Start the MCP stdio server (v0.5 spike \u2014 docs/v0.5-spec.md)

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
async function run(argv) {
  const args = parseArgs(argv);
  if (flagBool(args, "h", "help") && args._.length === 0) {
    process.stdout.write(HELP10);
    return 0;
  }
  if (flagBool(args, "v", "version")) {
    const version = "0.4.0";
    process.stdout.write(`agent-conductor v${version}
`);
    return 0;
  }
  const [sub, ...subPositionals] = args._;
  if (!sub) {
    process.stdout.write(HELP10);
    return 0;
  }
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
      case "mcp":
        return await mcpCmd(restArgs);
      case "help":
        process.stdout.write(HELP10);
        return 0;
      default:
        process.stderr.write(`agent-conductor: unknown command '${sub}'

`);
        process.stderr.write(HELP10);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-conductor: ${msg}
`);
    return 1;
  }
}

// src/cli/bin.ts
run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`agent-conductor: fatal: ${err?.stack ?? err}
`);
    process.exit(1);
  }
);
//# sourceMappingURL=bin.cjs.map
//# sourceMappingURL=bin.cjs.map
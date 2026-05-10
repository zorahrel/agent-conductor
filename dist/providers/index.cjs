'use strict';

var child_process = require('child_process');
var util = require('util');
var fs = require('fs');
var os = require('os');
var path = require('path');

// src/discovery/claude-code.ts
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
  const panes = await listAllPanes(execFn);
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
function getAuditDir() {
  return process.env.JARVIS_AUDIT_DIR ?? path.join(os.homedir(), ".claude", "jarvis", "orchestrator");
}
getAuditDir();
path.join(getAuditDir(), "audit.jsonl");
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

exports.DEFAULT_PROVIDER_NAME = DEFAULT_PROVIDER_NAME;
exports.aiderProvider = aiderProvider;
exports.allProviders = allProviders;
exports.claudeCodeProvider = claudeCodeProvider2;
exports.cursorCliProvider = cursorCliProvider;
exports.getProvider = getProvider;
exports.registerProvider = registerProvider;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map
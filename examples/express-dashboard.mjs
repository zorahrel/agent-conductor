#!/usr/bin/env node
/**
 * Minimal Express-like dashboard example — exposes agent-conductor primitives
 * over HTTP without any framework. Uses Node's built-in `node:http` to keep
 * dependencies at zero.
 *
 * Routes:
 *   GET  /api/sessions          → claudeCodeProvider.discover()
 *   GET  /api/snapshot          → buildSnapshot()
 *   GET  /api/transcript/:pid   → last 10 turns from the session's JSONL
 *   GET  /api/todos             → listTodos("AgentTasks")
 *   POST /api/todos             → addTodo({title, notes?, due?})
 *   POST /api/todos/:id/complete → completeTodo(id)
 *   POST /api/inject            → sendKeys + appendAudit (requires {pid, text, force?})
 *   GET  /api/audit?tail=N      → tail of audit log
 *
 * Run:
 *   node examples/express-dashboard.mjs
 *   # then in another terminal:
 *   curl http://localhost:8765/api/snapshot | jq
 *
 * This is intentionally minimal — a real production server would add CORS,
 * rate-limiting, authentication, and validation. Use this as a starting point.
 */

import { createServer } from "node:http";
import { promises as fs } from "node:fs";

import { buildSnapshot, buildTranscript } from "agent-conductor";
import { claudeCodeProvider } from "agent-conductor/discovery";
import {
  listTodos,
  addTodo,
  completeTodo,
  probeAuth,
} from "agent-conductor/reminders";
import { findPaneForPid, sendKeys, appendAudit, AUDIT_FILE_PATH } from "agent-conductor/tmux";

const PORT = Number(process.env.PORT) || 8765;
const LIST = process.env.LIST || "AgentTasks";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    // --- Sessions / snapshot ---
    if (method === "GET" && path === "/api/sessions") {
      return json(res, 200, await claudeCodeProvider.discover());
    }
    if (method === "GET" && path === "/api/snapshot") {
      const sessions = await claudeCodeProvider.discover();
      return json(res, 200, await buildSnapshot(sessions));
    }

    // --- Transcript ---
    const txMatch = path.match(/^\/api\/transcript\/(\d+)$/);
    if (method === "GET" && txMatch) {
      const pid = Number(txMatch[1]);
      const sessions = await claudeCodeProvider.discover();
      const s = sessions.find((x) => x.pid === pid);
      if (!s?.transcriptPath) return json(res, 404, { error: "no_transcript" });
      const limit = Number(url.searchParams.get("limit")) || 10;
      return json(res, 200, await buildTranscript(s.transcriptPath, pid, limit));
    }

    // --- Todos ---
    if (method === "GET" && path === "/api/todos") {
      const auth = await probeAuth();
      if (!auth.authorized) {
        return json(res, 200, {
          todos: [],
          authorized: false,
          banner: "Grant Reminders access (System Settings → Privacy → Reminders)",
        });
      }
      return json(res, 200, { todos: await listTodos(LIST) });
    }
    if (method === "POST" && path === "/api/todos") {
      const body = await readBody(req);
      if (!body.title) return json(res, 400, { error: "title_required" });
      const created = await addTodo(body, LIST);
      return json(res, 201, created);
    }
    const cmpMatch = path.match(/^\/api\/todos\/(.+)\/complete$/);
    if (method === "POST" && cmpMatch) {
      return json(res, 200, await completeTodo(cmpMatch[1]));
    }

    // --- Inject (write side, with audit) ---
    if (method === "POST" && path === "/api/inject") {
      const body = await readBody(req);
      if (!body.pid || !body.text) return json(res, 400, { error: "missing_pid_or_text" });
      const pane = await findPaneForPid(Number(body.pid));
      if (!pane) return json(res, 409, { error: "no_tmux", message: "pid not under tmux" });
      await sendKeys(pane.pane, body.text);
      await appendAudit({
        ts: Date.now(),
        pid: Number(body.pid),
        repo: body.repo || "unknown",
        action: "inject",
        text: body.text,
        source: "user-approved",
      });
      return json(res, 200, { ok: true, pane: pane.pane });
    }

    // --- Audit tail ---
    if (method === "GET" && path === "/api/audit") {
      const tail = Number(url.searchParams.get("tail")) || 20;
      try {
        const raw = await fs.readFile(AUDIT_FILE_PATH, "utf8");
        const lines = raw.split("\n").filter(Boolean).slice(-tail);
        return json(res, 200, lines.map((l) => JSON.parse(l)));
      } catch (err) {
        if (err.code === "ENOENT") return json(res, 200, []);
        throw err;
      }
    }

    return json(res, 404, { error: "not_found", path });
  } catch (err) {
    return json(res, 500, { error: "internal", message: String(err.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`agent-conductor example dashboard listening on http://localhost:${PORT}`);
  console.log(`Reminders list: "${LIST}" (override with LIST env var)`);
});

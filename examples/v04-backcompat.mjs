#!/usr/bin/env node
/**
 * v0.4 backward-compat smoke (v0.5 spec AC10).
 *
 * Imports ONLY the API surface that was exported in agent-conductor v0.4.0,
 * exercises a representative call from each subsystem, and asserts the
 * shape hasn't drifted. Run by CI in addition to `npm test` so a v0.5+
 * change that breaks v0.4 callers fails loud.
 *
 * Exits 0 on success, 1 on any failure. No external deps — uses
 * `node:assert/strict`. Intentionally NOT a node:test spec so it can be
 * run against a published tarball or git-installed dist without a runner.
 *
 *   npm run build && node examples/v04-backcompat.mjs
 *
 * Imports point at `../dist/index.js` so the script exercises the actual
 * built artifact (the same one consumers get via `npm install github:`).
 * If you want to validate a published install instead, replace the import
 * paths with `agent-conductor`, `agent-conductor/jsonl`, etc.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, "..", "dist", "index.js");

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => process.stdout.write(`  ✔ ${name}\n`))
    .catch((err) => {
      failures.push({ name, err });
      process.stdout.write(`  ✖ ${name}\n    ${err.message}\n`);
    });
}

process.stdout.write("agent-conductor v0.4 backward-compat smoke\n");

// 1. Top-level barrel — every v0.4 export must still resolve.
const root = await import(distRoot);

await check("v0.4 root exports present", () => {
  // JSONL parser
  assert.equal(typeof root.readJsonlTailLines, "function");
  assert.equal(typeof root.extractLastAssistantTurn, "function");
  assert.equal(typeof root.extractPendingToolUses, "function");
  assert.equal(typeof root.getStopReason, "function");
  assert.equal(typeof root.extractToolUseEvents, "function");
  assert.equal(typeof root.sumTokens, "function");
  assert.equal(typeof root.countTurns, "function");
  // Sessions
  assert.equal(typeof root.deriveRefinedStatus, "function");
  assert.equal(typeof root.refinedStatusFor, "function");
  assert.equal(typeof root.findGitRoot, "function");
  assert.equal(typeof root.detectConflict, "function");
  assert.equal(typeof root.suggestNext, "function");
  assert.equal(typeof root.composeSnapshot, "function");
  assert.equal(typeof root.buildSnapshot, "function");
  assert.equal(typeof root.buildTranscript, "function");
  // tmux
  assert.equal(typeof root.listAllPanes, "function");
  assert.equal(typeof root.findPaneForPid, "function");
  assert.equal(typeof root.sendKeys, "function");
  assert.equal(typeof root.capturePane, "function");
  assert.equal(typeof root.appendAudit, "function");
  assert.equal(typeof root.AUDIT_DIR, "string");
  assert.equal(typeof root.AUDIT_FILE_PATH, "string");
  assert.equal(typeof root.ROTATE_BYTES, "number");
  // Reminders
  assert.equal(typeof root.listTodos, "function");
  assert.equal(typeof root.addTodo, "function");
  assert.equal(typeof root.completeTodo, "function");
  assert.equal(typeof root.parseTodoMetadata, "function");
  assert.equal(typeof root.formatTodoMetadata, "function");
  assert.equal(typeof root.diffTodos, "function");
  assert.equal(typeof root.startReminderPolling, "function");
  assert.equal(typeof root.stopReminderPolling, "function");
  // Providers (v0.4 multi-provider arch)
  assert.equal(typeof root.registerProvider, "function");
  assert.equal(typeof root.getProvider, "function");
  assert.equal(typeof root.allProviders, "function");
  assert.equal(typeof root.DEFAULT_PROVIDER_NAME, "string");
  assert.equal(root.DEFAULT_PROVIDER_NAME, "claude-code");
});

// 2. Subpaths — every v0.4 subpath must still resolve.
await check("v0.4 subpath imports resolve", async () => {
  const dist = (subpath) => join(here, "..", "dist", subpath, "index.js");
  await import(dist("jsonl"));
  await import(dist("sessions"));
  await import(dist("tmux"));
  await import(dist("reminders"));
  await import(dist("discovery"));
  await import(dist("providers"));
});

// 3. suggestNext — pure function, no I/O. Output shape must match v0.4
//    contract: { text, action, confidence, reason }.
await check("suggestNext shape stable", () => {
  const s = root.suggestNext({
    refinedStatus: "awaiting_user_input",
    lastAssistantSummary: "approve and proceed?",
  });
  assert.equal(typeof s.text, "string");
  assert.equal(typeof s.action, "object");
  assert.equal(typeof s.confidence, "string");
  assert.equal(typeof s.reason, "string");
  assert.equal(s.confidence, "high");
  assert.equal(s.action.type, "inject");
});

// 4. detectConflict — pure function. Same cwd → true.
await check("detectConflict same-path → true", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agent-conductor-bc-"));
  try {
    const conflict = await root.detectConflict(dir, dir);
    assert.equal(conflict, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 5. composeSnapshot — pure, sync. Positional args (v0.4 contract):
//      composeSnapshot(sessions, statusMap, lastByPid, conflictMap, tmuxByPid?)
//    Empty inputs produce an empty snapshot — proves the shape without touching ps.
await check("composeSnapshot returns OrchestratorSnapshot shape", () => {
  const snap = root.composeSnapshot([], new Map(), new Map(), new Map());
  assert.equal(typeof snap.generated_at, "string");
  assert.ok(Array.isArray(snap.sessions));
  assert.equal(snap.sessions.length, 0);
});

// 6. allProviders — v0.4 ships claude-code + aider + cursor-cli as built-ins.
await check("v0.4 built-in providers are registered", () => {
  const names = root.allProviders().map((p) => p.name).sort();
  assert.deepEqual(names, ["aider", "claude-code", "cursor-cli"]);
});

// 7. AuditEntry written through v0.4 appendAudit must remain readable.
await check("appendAudit round-trips via $AGENT_CONDUCTOR_AUDIT_DIR override", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agent-conductor-bc-audit-"));
  // appendAudit reads JARVIS_AUDIT_DIR (NOT AGENT_CONDUCTOR_AUDIT_DIR — this
  // is a v0.4 quirk preserved for backward compat; renaming would BE a
  // breaking change. See src/tmux/audit.ts).
  const prev = process.env.JARVIS_AUDIT_DIR;
  process.env.JARVIS_AUDIT_DIR = dir;
  try {
    await root.appendAudit({
      ts: Date.now(),
      pid: 42,
      repo: "demo",
      action: "inject",
      text: "y",
      source: "user-approved",
    });
    const written = await fs.readFile(join(dir, "audit.jsonl"), "utf8");
    const parsed = JSON.parse(written.trim());
    assert.equal(parsed.pid, 42);
    assert.equal(parsed.action, "inject");
  } finally {
    if (prev === undefined) {
      delete process.env.JARVIS_AUDIT_DIR;
    } else {
      process.env.JARVIS_AUDIT_DIR = prev;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

process.stdout.write("\n");
if (failures.length === 0) {
  process.stdout.write(`✔ v0.4 backward-compat smoke: ${7} checks passed\n`);
  process.exit(0);
} else {
  process.stderr.write(`✖ v0.4 backward-compat smoke: ${failures.length} failure(s)\n`);
  for (const f of failures) {
    process.stderr.write(`  - ${f.name}: ${f.err.stack ?? f.err.message}\n`);
  }
  process.exit(1);
}

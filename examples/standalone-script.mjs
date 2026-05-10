#!/usr/bin/env node
/**
 * Standalone Node.js example — build a snapshot of every live Claude Code
 * session and print the next-step suggestion for each one.
 *
 * Run:
 *   node examples/standalone-script.mjs
 *
 * Or after `npm install agent-conductor`:
 *   node node_modules/agent-conductor/examples/standalone-script.mjs
 */

import { buildSnapshot } from "agent-conductor";
import { claudeCodeProvider } from "agent-conductor/discovery";

async function main() {
  const sessions = await claudeCodeProvider.discover();
  if (sessions.length === 0) {
    console.log("No live Claude Code sessions detected.");
    console.log("Start one with `claude` and rerun.");
    return;
  }

  const snap = await buildSnapshot(sessions);

  console.log(`Snapshot @ ${snap.generated_at}`);
  console.log("─".repeat(60));
  for (const e of snap.sessions) {
    console.log(`pid ${e.pid}  repo ${e.repo}  branch ${e.branch ?? "—"}`);
    console.log(`  status:     ${e.status} (${e.confidence})`);
    console.log(`  last:       ${e.last_assistant_summary?.slice(0, 80) ?? "—"}`);
    console.log(`  suggestion: ${e.suggestion}`);
    console.log(`  action:     ${JSON.stringify(e.action)}`);
    if (e.tmux) console.log(`  tmux:       ${e.tmux.session}:${e.tmux.pane}`);
    if (e.conflict !== null) console.log(`  ⚠ conflict with pid ${e.conflict}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

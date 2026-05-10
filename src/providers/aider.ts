/**
 * Aider provider — stub.
 *
 * Aider (https://aider.chat) is an AI pair-programming CLI that writes
 * transcripts to `.aider.chat.history.md` in markdown format. The discovery
 * here finds `aider` processes via `ps`, but transcript reading + status
 * derivation are not yet implemented — they require a markdown-history
 * parser (planned for v0.5).
 *
 * Until v0.5 lands:
 *   - `discover()` returns sessions correctly (you'll see them in `agent-conductor sessions --provider aider`)
 *   - `readTranscript()` returns `null`
 *   - `deriveStatus()` returns `"unknown"`
 *   - `suggestNext()` returns a generic "check the terminal" suggestion
 *   - `inject()` works via tmux if the session is under tmux (same as Claude Code)
 *
 * Contributions welcome: see CONTRIBUTING.md "What gets merged faster".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";

import type { AgentProvider, InjectResult, TranscriptTurnShape } from "./types.js";
import type { LocalSession } from "../types/local-session.js";
import type { RefinedStatus, Suggestion } from "../types/sessions.js";
import { listAllProcesses } from "../discovery/ps.js";
import { findPaneForPid, sendKeys } from "../tmux/tmuxMap.js";
import { appendAudit } from "../tmux/audit.js";

const execFileAsync = promisify(execFile);

async function cwdOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { timeout: 1500 },
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1) || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const aiderProvider: AgentProvider = {
  name: "aider",
  displayName: "Aider",
  description:
    "AI pair-programming CLI. Markdown transcripts in .aider.chat.history.md. Full transcript parser arrives in v0.5; discovery + tmux inject work today.",

  async discover(): Promise<LocalSession[]> {
    const processes = await listAllProcesses();
    const out: LocalSession[] = [];
    for (const p of processes) {
      // Aider invocations look like `python .../aider` or `aider`
      if (!/\baider\b/.test(p.command)) continue;
      const cwd = (await cwdOf(p.pid)) ?? process.cwd();
      out.push({
        pid: p.pid,
        cwd,
        repoName: basename(cwd),
        branch: null,
        status: "unknown",
        hookEvent: null,
        sessionId: null,
        transcriptPath: null, // v0.5 will resolve `.aider.chat.history.md`
        lastActivity: Date.now(),
        tty: null,
        parentCommand: null,
        preview: { lastUserMessage: null, lastAssistantText: null },
        isRouterSpawned: false,
      });
    }
    return out;
  },

  async readTranscript(): Promise<TranscriptTurnShape[] | null> {
    // v0.5: parse .aider.chat.history.md (markdown format) into TranscriptTurnShape[].
    return null;
  },

  async deriveStatus(_session: LocalSession): Promise<RefinedStatus> {
    // Without transcript reading we can't tell awaiting_user_input from working.
    return "idle";
  },

  suggestNext(): Suggestion {
    return {
      text: "Switch to the aider terminal and continue the conversation.",
      action: { type: "none", reason: "aider provider transcript parser ships in v0.5" },
      confidence: "low",
      reason: "aider provider is a stub in v0.4 — discovery works, transcript+status do not",
    };
  },

  async inject(session: LocalSession, text: string): Promise<InjectResult> {
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
      source: "user-approved",
    });
    return { ok: true, audit: { ts, pid: session.pid, text, method: "tmux:send-keys" } };
  },
};

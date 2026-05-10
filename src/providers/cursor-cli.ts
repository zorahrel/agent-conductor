/**
 * Cursor CLI provider — discovery stub.
 *
 * Cursor (https://cursor.com) is primarily an IDE, but ships a CLI (`cursor-agent`
 * since v0.45). Transcripts live in `~/.cursor/agent-history/` (subject to
 * change). The discovery here finds `cursor-agent` processes via `ps`; full
 * transcript reader + status derivation are planned for v0.5.
 *
 * Inject channel is currently tmux. Cursor's HTTP API exposes its own chat
 * interface that may become a more direct injection channel in v0.6.
 *
 * Until v0.5:
 *   - `discover()` finds running `cursor-agent` processes
 *   - `readTranscript()` returns `null`
 *   - `deriveStatus()` returns `"idle"`
 *   - `suggestNext()` returns a generic prompt to attend the IDE
 *   - `inject()` works via tmux if the session is under tmux
 *
 * Contributions welcome.
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

export const cursorCliProvider: AgentProvider = {
  name: "cursor-cli",
  displayName: "Cursor CLI",
  description:
    "Anysphere's Cursor CLI (`cursor-agent`). Transcript parser arrives in v0.5; discovery + tmux inject work today.",

  async discover(): Promise<LocalSession[]> {
    const processes = await listAllProcesses();
    const out: LocalSession[] = [];
    for (const p of processes) {
      // Matches `cursor-agent`, `Cursor Agent` (without space depending on
      // launcher), and the path-based form.
      if (!/cursor[- ]?agent/i.test(p.command)) continue;
      const cwd = (await cwdOf(p.pid)) ?? process.cwd();
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
        isRouterSpawned: false,
      });
    }
    return out;
  },

  async readTranscript(): Promise<TranscriptTurnShape[] | null> {
    return null;
  },

  async deriveStatus(): Promise<RefinedStatus> {
    return "idle";
  },

  suggestNext(): Suggestion {
    return {
      text: "Switch to Cursor and continue the conversation.",
      action: { type: "none", reason: "cursor-cli provider stub — full impl in v0.5" },
      confidence: "low",
      reason: "cursor-cli provider is a stub in v0.4",
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

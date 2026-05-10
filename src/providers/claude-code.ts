/**
 * Claude Code provider — full implementation. The default provider.
 *
 * Wraps the existing discovery + transcript + status + suggest + tmux primitives
 * into a single `AgentProvider` so the multi-provider CLI and library can treat
 * Claude Code as one of several pluggable providers.
 */

import { claudeCodeProvider as discoveryProvider } from "../discovery/claude-code.js";
import { readJsonlTailLines } from "../jsonl/parser.js";
import { deriveRefinedStatus } from "../sessions/refinedStatus.js";
import { suggestNext as defaultSuggestNext } from "../sessions/suggest.js";
import { findPaneForPid, sendKeys } from "../tmux/tmuxMap.js";
import { appendAudit } from "../tmux/audit.js";

import type { AgentProvider, InjectResult, TranscriptTurnShape } from "./types.js";
import type { LocalSession } from "../types/local-session.js";
import type { RefinedStatus, Suggestion } from "../types/sessions.js";

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",
  displayName: "Claude Code",
  description:
    "Anthropic's Claude Code CLI. JSONL transcripts under ~/.claude/projects/, tmux send-keys for inject.",

  async discover(): Promise<LocalSession[]> {
    return discoveryProvider.discover();
  },

  async readTranscript(
    session: LocalSession,
    limit: number,
  ): Promise<TranscriptTurnShape[] | null> {
    if (!session.transcriptPath) return null;
    const lines = await readJsonlTailLines(session.transcriptPath, 256_000);
    const turns: TranscriptTurnShape[] = [];
    for (const raw of lines) {
      try {
        const obj = JSON.parse(raw) as {
          type?: string;
          message?: {
            role?: "assistant" | "user";
            content?: unknown;
            stop_reason?: string | null;
          };
          timestamp?: string;
          uuid?: string;
        };
        if (obj.type !== "assistant" && obj.type !== "user") continue;
        const role = obj.message?.role;
        if (role !== "assistant" && role !== "user") continue;
        let content: TranscriptTurnShape["content"];
        if (typeof obj.message?.content === "string") {
          content = [{ type: "text", text: obj.message.content }];
        } else if (Array.isArray(obj.message?.content)) {
          content = obj.message!.content as TranscriptTurnShape["content"];
        } else {
          content = [];
        }
        turns.push({
          role,
          content,
          stop_reason: obj.message?.stop_reason ?? null,
          timestamp: obj.timestamp ?? "",
          uuid: obj.uuid ?? "",
        });
      } catch {
        /* skip malformed */
      }
    }
    return turns.slice(Math.max(0, turns.length - limit));
  },

  async deriveStatus(session: LocalSession): Promise<RefinedStatus> {
    return deriveRefinedStatus(session);
  },

  suggestNext(
    _session: LocalSession,
    lastAssistantSummary: string | null,
    refinedStatus: RefinedStatus,
  ): Suggestion {
    return defaultSuggestNext({ refinedStatus, lastAssistantSummary });
  },

  async inject(session: LocalSession, text: string): Promise<InjectResult> {
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
      source: "user-approved",
    });
    return {
      ok: true,
      audit: { ts, pid: session.pid, text, method: "tmux:send-keys" },
    };
  },
};

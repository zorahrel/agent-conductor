/**
 * Agent provider interface — the multi-provider contract.
 *
 * An `AgentProvider` knows how to:
 *   1. **Discover** live sessions of its CLI agent (e.g. `claude`, `aider`, `cursor`)
 *   2. **Read** transcripts produced by that agent (each provider stores them differently)
 *   3. **Derive** a refined status from process state + transcript tail
 *   4. **Suggest** a next-step action (provider-specific because tool semantics differ)
 *   5. **Inject** input back into the session (tmux send-keys for terminal-based agents;
 *      could be HTTP POST for web-based agents; could be applescript for Electron apps)
 *
 * v0.4 ships:
 *   - `claudeCodeProvider` — full implementation (default)
 *   - `aiderProvider` — discovery + transcript reader (stub for inject/suggest)
 *   - `cursorCliProvider` — discovery stub only
 *
 * Roadmap:
 *   - v0.5: full Aider implementation (parse `.aider.chat.history.md`)
 *   - v0.5: Cursor CLI transcript parser
 *   - v0.6: ChatGPT CLI (shell-gpt, chatblade) adapter
 *
 * Custom providers: implement this interface and call `registerProvider(yours)`.
 */

import type { LocalSession } from "../types/local-session.js";
import type { RefinedStatus, Suggestion } from "../types/sessions.js";

export interface TranscriptTurnShape {
  role: "user" | "assistant";
  content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  timestamp: string;
  uuid: string;
}

export interface InjectResult {
  ok: boolean;
  reason?: string;
  audit?: {
    ts: number;
    pid: number;
    text: string;
    method: string;
  };
}

export interface AgentProvider {
  /** Stable machine-readable identifier — used as `--provider <name>` flag value. */
  readonly name: string;

  /** Human-friendly display name shown in UIs (sidebar, dashboard tables, etc.). */
  readonly displayName: string;

  /** Short description — what does this provider's CLI agent do? */
  readonly description: string;

  /** Discover every live session of this provider's CLI agent on the local machine. */
  discover(): Promise<LocalSession[]>;

  /**
   * Read up to `limit` recent turns from a session's transcript. Returns null
   * if the transcript path isn't known yet (session hasn't generated output).
   *
   * Implementations should be cheap — tail the file, parse last N lines.
   * Do NOT read the entire transcript in one shot.
   */
  readTranscript(
    session: LocalSession,
    limit: number,
  ): Promise<TranscriptTurnShape[] | null>;

  /**
   * Derive a refined status from process state + transcript tail.
   *
   * Default behaviour is shared across providers (in `sessions/refinedStatus.ts`);
   * a provider that needs different state semantics overrides here.
   */
  deriveStatus(session: LocalSession): Promise<RefinedStatus>;

  /**
   * Deterministic next-step suggestion — no LLM calls. Each provider has
   * different "stuck patterns" so this is provider-specific.
   */
  suggestNext(
    session: LocalSession,
    lastAssistantSummary: string | null,
    refinedStatus: RefinedStatus,
  ): Suggestion;

  /**
   * Send input to the session. Implementations choose the channel:
   *   - tmux send-keys for terminal-based agents
   *   - HTTP POST for web-based agents (Cursor IDE-attached)
   *   - AppleScript for native apps (Claude.app, ChatGPT.app)
   *
   * Returns `{ ok: false, reason: "no_channel" }` if the session is read-only
   * (e.g., bare TTY without tmux).
   */
  inject(session: LocalSession, text: string): Promise<InjectResult>;
}

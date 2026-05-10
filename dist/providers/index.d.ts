import { L as LocalSession } from '../local-session-D0z943pW.js';
import { R as RefinedStatus, a as Suggestion } from '../sessions-CdTstnnc.js';

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

interface TranscriptTurnShape {
    role: "user" | "assistant";
    content: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
    }>;
    stop_reason: string | null;
    timestamp: string;
    uuid: string;
}
interface InjectResult {
    ok: boolean;
    reason?: string;
    audit?: {
        ts: number;
        pid: number;
        text: string;
        method: string;
    };
}
interface AgentProvider {
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
    readTranscript(session: LocalSession, limit: number): Promise<TranscriptTurnShape[] | null>;
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
    suggestNext(session: LocalSession, lastAssistantSummary: string | null, refinedStatus: RefinedStatus): Suggestion;
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

/**
 * Provider registry — central lookup so the CLI and library consumers can
 * resolve providers by name. Defaults to Claude Code; consumers can register
 * additional providers at startup.
 *
 * Usage:
 *
 *   import { registerProvider, getProvider, allProviders } from "agent-conductor";
 *
 *   // Built-ins (Claude Code, Aider stub, Cursor CLI stub) are pre-registered.
 *
 *   // Custom provider:
 *   registerProvider(myCustomProvider);
 *
 *   // Lookup:
 *   const p = getProvider("aider"); // → AiderProvider
 *   const all = allProviders();     // → AgentProvider[]
 */

/** Register or replace a provider in the global registry. */
declare function registerProvider(provider: AgentProvider): void;
/** Look up a provider by its `name` (the value of `--provider <name>` flag). */
declare function getProvider(name: string): AgentProvider | undefined;
/** All currently registered providers, in registration order. */
declare function allProviders(): AgentProvider[];
/** The default provider used when none is explicitly specified. */
declare const DEFAULT_PROVIDER_NAME = "claude-code";

/**
 * Claude Code provider — full implementation. The default provider.
 *
 * Wraps the existing discovery + transcript + status + suggest + tmux primitives
 * into a single `AgentProvider` so the multi-provider CLI and library can treat
 * Claude Code as one of several pluggable providers.
 */

declare const claudeCodeProvider: AgentProvider;

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

declare const aiderProvider: AgentProvider;

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

declare const cursorCliProvider: AgentProvider;

export { type AgentProvider, DEFAULT_PROVIDER_NAME, type InjectResult, type TranscriptTurnShape, aiderProvider, allProviders, claudeCodeProvider, cursorCliProvider, getProvider, registerProvider };

import { R as RefinedStatus, a as Suggestion, O as OrchestratorSnapshot } from './sessions-CdTstnnc.js';

type LocalSessionStatus = "working" | "idle" | "waiting" | "finished" | "errored" | "unknown";
interface LocalSession {
    pid: number;
    cwd: string;
    repoName: string;
    branch: string | null;
    status: LocalSessionStatus;
    hookEvent: string | null;
    sessionId: string | null;
    transcriptPath: string | null;
    lastActivity: number;
    tty: string | null;
    parentCommand: string | null;
    preview: {
        lastUserMessage: string | null;
        lastAssistantText: string | null;
    };
    isRouterSpawned: boolean;
    /** Live token count if known (router-spawned: from SDK task_progress; bare CLI: from JSONL tail). */
    liveTokens?: number;
    /** Source signal that produced liveTokens. */
    liveTokensSource?: "sdk-task-progress" | "sdk-result" | "jsonl-tail" | "unknown";
    /** Wall-clock ms when liveTokens was captured. */
    liveTokensAt?: number;
    /** Model context window in tokens (e.g. 200000). */
    contextWindow?: number;
    /** Cost in USD of the most recent completed turn. */
    lastTurnCostUsd?: number;
    /** Resolved Claude model id (e.g. "claude-sonnet-4-6"). */
    model?: string;
    /** Compaction count for the current session (router-spawned only). 0 if unknown. */
    compactionCount?: number;
    /** Router session key (e.g. "telegram:123456:jarvis") if router-spawned and sidecar resolved. */
    sessionKey?: string;
    /** Agent name (resolved from sidecar if router-spawned). */
    agent?: string;
    /** fullAccess flag for the agent (resolved from sidecar). */
    fullAccess?: boolean;
    /** inheritUserScope flag for the agent (resolved from sidecar). */
    inheritUserScope?: boolean;
    /** Refined 5-state status (awaiting_user_input | tool_pending | crashed | working | idle). */
    refinedStatus?: RefinedStatus;
    /** Resolved tmux pane mapping (Plan 02-04 wires the resolver — Plan 02-01 always emits null). */
    tmux?: {
        session: string;
        pane: string;
    } | null;
    /** Other session pid that conflicts on this cwd (sub-path with same git root). */
    lockConflict?: number | null;
}

declare function deriveRefinedStatus(s: LocalSession, opts?: {
    pidAlive?: boolean;
}): Promise<RefinedStatus>;
declare function refinedStatusFor(sessions: LocalSession[]): Promise<Map<number, RefinedStatus>>;
/** Test helper: reset the in-module cache. */
declare function _resetCacheForTests(): void;

/**
 * Cwd lock detection — Phase 2 Plan 02-01 (ORC-05).
 *
 * Two Claude Code sessions targeting the same repo (or nested paths inside
 * the same repo) MUST NOT both be approved for inject simultaneously — they
 * would clobber each other's edits. Two sibling worktrees of the same repo
 * (e.g. `~/.omnara/worktrees/A` and `~/.omnara/worktrees/B`) live under a
 * shared parent but are independent git roots, so they DO NOT conflict.
 *
 * Decision rules:
 *  - Identical realpath → conflict.
 *  - One realpath is a strict subpath of the other:
 *      * same git root (or no git roots resolved) → conflict.
 *      * different git roots → independent worktrees → no conflict.
 *  - Otherwise (siblings or unrelated paths) → no conflict.
 *
 * `findGitRoot` walks up from the canonicalized cwd looking for a `.git`
 * entry (file marker for worktree, or directory for primary checkout).
 * Returns null if none is found before hitting the filesystem root.
 */
declare function findGitRoot(p: string): Promise<string | null>;
declare function detectConflict(a: string, b: string): Promise<boolean>;

interface SuggestInput {
    refinedStatus: RefinedStatus;
    lastAssistantSummary: string | null;
}
declare function suggestNext(s: SuggestInput): Suggestion;

interface TranscriptBlock {
    type: string;
    text?: string;
    name?: string;
    id?: string;
    input?: unknown;
    tool_use_id?: string;
}
interface TranscriptTurn {
    role: "assistant" | "user";
    content: TranscriptBlock[];
    stop_reason: string | null;
    timestamp: string;
    uuid: string;
}
interface TranscriptResponse {
    pid: number;
    turns: TranscriptTurn[];
}
/**
 * Read the JSONL tail and project to last-N {role, content, ...} turns.
 * Skips `attachment` and `last-prompt` rows. User content strings are
 * normalized to a single `{type:"text"}` block so the consumer always sees
 * an array.
 */
declare function buildTranscript(transcriptPath: string, pid: number, limit: number): Promise<TranscriptResponse>;
declare function composeSnapshot(sessions: LocalSession[], statusMap: Map<number, RefinedStatus>, lastByPid: Map<number, string | null>, conflictMap: Map<number, number | null>, tmuxByPid?: Map<number, {
    session: string;
    pane: string;
} | null>): OrchestratorSnapshot;
declare function buildSnapshot(sessions: LocalSession[]): Promise<OrchestratorSnapshot>;

export { type LocalSession as L, type SuggestInput as S, type TranscriptBlock as T, _resetCacheForTests as _, type LocalSessionStatus as a, type TranscriptResponse as b, type TranscriptTurn as c, buildSnapshot as d, buildTranscript as e, composeSnapshot as f, deriveRefinedStatus as g, detectConflict as h, findGitRoot as i, refinedStatusFor as r, suggestNext as s };

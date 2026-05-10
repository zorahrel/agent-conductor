import { L as LocalSession } from '../local-session-D0z943pW.js';
import { R as RefinedStatus, a as Suggestion, O as OrchestratorSnapshot } from '../sessions-CdTstnnc.js';

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

export { type SuggestInput, type TranscriptBlock, type TranscriptResponse, type TranscriptTurn, _resetCacheForTests as _resetRefinedStatusCache, buildSnapshot, buildTranscript, composeSnapshot, deriveRefinedStatus, detectConflict, findGitRoot, refinedStatusFor, suggestNext };

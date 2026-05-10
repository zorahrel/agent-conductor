interface ToolUseRecord {
    name: string;
    inputKeys: string[];
    turnIndex: number;
}
interface TokenSummary {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    total: number;
}
/**
 * Read the trailing `maxBytes` of a JSONL file and split into lines.
 * On any error returns []. Skips empty trailing lines.
 */
declare function readJsonlTailLines(path: string, maxBytes?: number): Promise<string[]>;
/**
 * Walk JSONL tail and return tool_use records from the last `lastNTurns` assistant turns.
 * Each `assistant` line increments `turnIndex`. We keep only entries where
 * `turnIndex >= totalTurns - lastNTurns`.
 */
declare function extractToolUseEvents(path: string, lastNTurns?: number): Promise<ToolUseRecord[]>;
/**
 * Sum token usage fields across all `assistant` lines in the tail.
 * Missing fields default to 0.
 */
declare function sumTokens(path: string): Promise<TokenSummary>;
/** Count assistant lines (one per turn, approximately). */
declare function countTurns(path: string): Promise<number>;
/**
 * Walk the JSONL tail in reverse and return the last `assistant`-typed turn.
 * Returns null if no assistant turn is found (empty file, malformed-only, or
 * file lacks any assistant rows).
 *
 * Used by:
 *  - refinedStatus.ts (decide awaiting_user_input vs crashed via stop_reason)
 *  - snapshot.ts (last_assistant_summary projection — first text block)
 *  - dashboard/api.ts /api/sessions/:pid/transcript handler
 */
declare function extractLastAssistantTurn(transcriptPath: string): Promise<{
    stop_reason: string | null;
    content: Array<{
        type: string;
        text?: string;
        name?: string;
        id?: string;
        input?: unknown;
    }>;
    timestamp: string;
    uuid: string;
} | null>;
/**
 * Walk the JSONL tail and return the set of `tool_use` blocks emitted by
 * `assistant` turns that do NOT yet have a matching `tool_result` block in a
 * subsequent `user` turn. A non-empty result means the session is in
 * "tool_pending" state — Claude is waiting for a tool result before continuing.
 *
 * Matching is by `tool_use.id` ↔ `tool_result.tool_use_id`. Order within the
 * tail does not matter; we collect all tool_uses then subtract matched ids.
 */
declare function extractPendingToolUses(transcriptPath: string): Promise<Array<{
    id: string;
    name: string;
    input: unknown;
}>>;
/**
 * Convenience wrapper around extractLastAssistantTurn that returns just the
 * stop_reason (or null when missing). Used by refinedStatus crashed-detection
 * — a transcript whose last assistant has stop_reason==null AND whose process
 * is gone from `ps` is "crashed".
 */
declare function getStopReason(transcriptPath: string): Promise<string | null>;

export { countTurns, extractLastAssistantTurn, extractPendingToolUses, extractToolUseEvents, getStopReason, readJsonlTailLines, sumTokens };

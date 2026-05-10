/**
 * JSONL transcript parser for Claude Code session files.
 *
 * Reads from `~/.claude/projects/-Users-.../<uuid>.jsonl` style transcripts
 * (or any equivalent layout) without loading the full file — tails the last
 * N bytes and parses line-by-line.
 */

export {
  readJsonlTailLines,
  extractLastAssistantTurn,
  extractPendingToolUses,
  getStopReason,
  extractToolUseEvents,
  sumTokens,
  countTurns,
} from "./parser.js";

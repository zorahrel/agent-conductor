/**
 * Sessions sub-module: pure logic for observing N concurrent Claude Code sessions.
 *
 * Pure here means: doesn't own its data source. Caller provides the
 * `sessions: LocalSession[]` (discovered however they want — ps+lsof, registry,
 * fixture). This package only derives status, composes snapshots, detects
 * cwd-collision locks, and emits deterministic suggestions.
 */

export {
  deriveRefinedStatus,
  refinedStatusFor,
  _resetCacheForTests as _resetRefinedStatusCache,
} from "./refinedStatus.js";

export {
  findGitRoot,
  detectConflict,
} from "./lock.js";

export {
  suggestNext,
  type SuggestInput,
} from "./suggest.js";

export {
  composeSnapshot,
  buildSnapshot,
  buildTranscript,
  type TranscriptBlock,
  type TranscriptTurn,
  type TranscriptResponse,
} from "./snapshot.js";

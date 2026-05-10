/**
 * agent-conductor — root barrel.
 *
 * Re-exports the most common API surface. For specific imports use the
 * sub-paths instead:
 *
 *   import { buildSnapshot } from "agent-conductor/sessions";
 *   import { listTodos } from "agent-conductor/reminders";
 *   import { sendKeys } from "agent-conductor/tmux";
 *   import { readJsonlTailLines } from "agent-conductor/jsonl";
 */

// JSONL parser
export {
  readJsonlTailLines,
  extractLastAssistantTurn,
  extractPendingToolUses,
  getStopReason,
  extractToolUseEvents,
  sumTokens,
  countTurns,
} from "./jsonl/parser.js";

// Sessions (observe + suggest + lock)
export {
  deriveRefinedStatus,
  refinedStatusFor,
} from "./sessions/refinedStatus.js";

export {
  findGitRoot,
  detectConflict,
} from "./sessions/lock.js";

export {
  suggestNext,
  type SuggestInput,
} from "./sessions/suggest.js";

export {
  composeSnapshot,
  buildSnapshot,
  buildTranscript,
  type TranscriptBlock,
  type TranscriptTurn,
  type TranscriptResponse,
} from "./sessions/snapshot.js";

// tmux (inject + audit)
export {
  listAllPanes,
  findPaneForPid,
  sendKeys,
  capturePane,
  type PaneRow,
} from "./tmux/tmuxMap.js";

export {
  appendAudit,
  AUDIT_DIR,
  AUDIT_FILE_PATH,
  ROTATE_BYTES,
} from "./tmux/audit.js";

// Reminders (intent layer)
export {
  getActiveCli,
  probeAuth,
  listTodos,
  addTodo,
  completeTodo,
  type ExecFn,
} from "./reminders/cli.js";

export {
  parseTodoMetadata,
  formatTodoMetadata,
} from "./reminders/metadata.js";

export {
  diffTodos,
  startReminderPolling,
  stopReminderPolling,
  type PollOptions,
} from "./reminders/poll.js";

// Types (re-exports for consumers)
export type {
  RefinedStatus,
  Confidence,
  Suggestion,
  AuditEntry,
  SnapshotEntry,
  OrchestratorSnapshot,
} from "./types/sessions.js";

export type {
  ReminderTodo,
  RemindersCli,
  CliProbe,
  TodoMetadata,
  TodoPhase,
  TodoEvent,
} from "./types/reminders.js";

export type {
  LocalSession,
  LocalSessionStatus,
} from "./types/local-session.js";

// Providers (multi-provider architecture)
export type {
  AgentProvider,
  InjectResult,
  TranscriptTurnShape,
} from "./providers/types.js";

export {
  registerProvider,
  getProvider,
  allProviders,
  DEFAULT_PROVIDER_NAME,
} from "./providers/registry.js";

export { claudeCodeProvider as claudeCodeAgentProvider } from "./providers/claude-code.js";
export { aiderProvider } from "./providers/aider.js";
export { cursorCliProvider } from "./providers/cursor-cli.js";

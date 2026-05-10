/**
 * Reminders sub-module: macOS Apple Reminders as intent layer.
 *
 * Primary CLI is `remindctl` (steipete tap); falls back to `apple-reminders-cli`
 * (`reminder` binary) and `ekctl` with shape adapters + console.warn.
 * Authorization gate: `probeAuth()` reports `{authorized, banner}` so the
 * consumer can surface a banner instead of crashing.
 *
 * Polling diff loop emits `todo:added` / `todo:completed` / `todo:updated`
 * via your event emitter of choice.
 */

export {
  getActiveCli,
  probeAuth,
  listTodos,
  addTodo,
  completeTodo,
  type ExecFn,
} from "./cli.js";

export {
  parseTodoMetadata,
  formatTodoMetadata,
} from "./metadata.js";

export {
  diffTodos,
  startReminderPolling,
  stopReminderPolling,
  type PollOptions,
} from "./poll.js";

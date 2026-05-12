/**
 * Reminders bridge — type contracts (Phase 2 Plan 02-02).
 *
 * Single source of truth for the reminder bridge primitives. The CLI wrapper
 * (`cli.ts`), the metadata parser (`metadata.ts`), the polling loop
 * (`poll.ts`), the dashboard API (`/api/todos`), and the React Todos tab
 * all import from here.
 *
 * Locked decisions (CONTEXT.md):
 *   - Apple Reminders is the intent layer (single source of truth for
 *     "what should be worked on"). EventKit-backed CLIs surface the data.
 *   - Body schema: `pid:NNNN repo:<name> phase:<plan|exec|review>` is the
 *     LAST line of the notes blob, separated from user prose by `\n\n`.
 *   - Three CLIs are probed in priority order (RESEARCH.md lines 122-148):
 *     remindctl (steipete tap, primary) > apple-reminders-cli (`reminder`)
 *     > ekctl. If none are installed/authorized, the bridge falls back to
 *     a local file at `~/.claude/jarvis/todos.json`.
 */
/** Active CLI selected via `getActiveCli()`. */
type RemindersCli = "remindctl" | "apple-reminders-cli" | "ekctl" | "fallback-file";
/** Phase tag for a todo's metadata — maps to the orchestrator suggestion engine. */
type TodoPhase = "plan" | "exec" | "review";
/** Parsed metadata extracted from the notes body. */
interface TodoMetadata {
    pid?: number;
    repo?: string;
    phase?: TodoPhase;
}
/**
 * Single reminder (todo) shape returned by the CLI. Mirrors `remindctl show
 * --json` output 1:1 with one addition: parsed metadata exposed alongside the
 * raw `notes` string.
 *
 * @see router/src/services/reminders/__fixtures__/sample-show-active.json for
 * the canonical shape captured live.
 */
interface ReminderTodo {
    id: string;
    title: string;
    list: string;
    notes: string | null;
    due: string | null;
    priority: number;
    completed: boolean;
    metadata: TodoMetadata;
}
/** Result of probing the active CLI for authorization (Pitfall 2 in RESEARCH.md). */
interface CliProbe {
    active: RemindersCli;
    authorized: boolean;
    version?: string;
}
/**
 * Diff event emitted by `startReminderPolling` whenever the 3s tick detects a
 * change. Deletions are intentionally NOT emitted — ORC-07 only tracks
 * added/completed/updated.
 */
type TodoEvent = {
    type: "todo:added";
    todo: ReminderTodo;
} | {
    type: "todo:completed";
    todo: ReminderTodo;
} | {
    type: "todo:updated";
    todo: ReminderTodo;
    previous: ReminderTodo;
};

/**
 * Reminders polling loop — Phase 2 Plan 02-02 (ORC-07).
 *
 * Every 3s by default the loop calls `listTodos()` and computes a diff
 * against the previous snapshot. Three event types fire through the caller-
 * supplied `onEvent` callback:
 *
 *   - todo:added     — id appears in next, was absent in prev
 *   - todo:completed — same id, completed flips false → true
 *   - todo:updated   — same id, title/notes/due changed
 *
 * Deletions are intentionally NOT emitted (CONTEXT.md decision + ORC-07).
 *
 * 3s polling cadence accepts the iCloud Reminders eventual-consistency lag
 * (3-15s) called out in CONTEXT.md and Pitfall 5 of RESEARCH.md.
 */

/**
 * Pure diff function — given two snapshots, return the list of TodoEvents
 * to emit. Used by the polling loop and unit-tested directly so we don't
 * need fake timers.
 *
 * Iteration order: `next` order. The diff is stable across ticks — same
 * inputs always yield the same event sequence.
 */
declare function diffTodos(prev: ReminderTodo[], next: ReminderTodo[]): TodoEvent[];
interface PollOptions {
    intervalMs?: number;
    list?: string;
    onEvent: (e: TodoEvent) => void;
    /** Optional error sink — called with any exec/parse failure during a tick. */
    onError?: (err: unknown) => void;
}
/**
 * Start the polling loop. Idempotent: calling twice without `stop` first is
 * a no-op (we don't restart). Returns immediately; the first tick fires
 * asynchronously.
 */
declare function startReminderPolling(opts: PollOptions): void;
/** Stop polling and clear cached state. Idempotent. */
declare function stopReminderPolling(): void;

export { type CliProbe as C, type PollOptions as P, type ReminderTodo as R, type TodoEvent as T, type RemindersCli as a, type TodoMetadata as b, type TodoPhase as c, diffTodos as d, stopReminderPolling as e, startReminderPolling as s };

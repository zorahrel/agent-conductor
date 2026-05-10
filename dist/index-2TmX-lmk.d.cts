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
 * Reminders CLI wrapper — Phase 2 Plan 02-02 (ORC-06).
 *
 * Wraps three macOS Apple Reminders CLIs in priority order:
 *   1. remindctl                (steipete tap — primary, locked in CONTEXT.md)
 *   2. apple-reminders-cli      (`reminder` binary, AungMyoKyaw — fallback #1)
 *   3. ekctl                    (schappim — fallback #2)
 *   4. fallback-file            (~/.claude/jarvis/todos.json) when no CLI present
 *
 * Why dependency-injected execFile: the spec passes a stub so we can verify
 * argv shapes + JSON parsing without spawning a real binary. Production code
 * uses the default promisified `execFile` from `child_process`.
 *
 * Pitfall 2 (RESEARCH.md line 324): EventKit returns empty / authorized:false
 * on first run until the user grants Reminders access. probeAuth() catches
 * the rejection and returns `{authorized: false}` so the dashboard can render
 * an "Authorize Reminders" banner instead of crashing.
 *
 * Anti-pattern alert (RESEARCH.md line 295): all CLI invocations go through
 * THIS module. Never spawn `remindctl` from another file directly. Swap-in
 * to apple-reminders-cli or ekctl is a one-line probe change here.
 */

/** Minimal exec contract — return shape mirrors `promisify(execFile)`. */
type ExecFn = (cmd: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
/**
 * Probe each CLI in priority order; return the first that responds to
 * `--version`. If none answer, return "fallback-file" so callers can
 * gracefully degrade to local-file persistence.
 *
 * Important: we map the binary name `reminder` to the cli identifier
 * `apple-reminders-cli` because the npm package and its docs use the
 * longer name (and we want the type-level union to match CONTEXT.md).
 */
declare function getActiveCli(execFn?: ExecFn): Promise<RemindersCli>;
/**
 * Probe authorization status. Returns `{authorized: false}` on any error
 * including the EventKit "not authorized" stderr — we DO NOT throw, because
 * the dashboard banner relies on this returning truthy in both states.
 *
 * For "fallback-file" mode we report authorized:true unconditionally (the
 * local JSON file doesn't need OS permissions).
 */
declare function probeAuth(cli?: RemindersCli, execFn?: ExecFn): Promise<CliProbe>;
/**
 * List open + completed reminders for a given list. Each entry returns its
 * raw JSON shape PLUS parsed metadata so consumers (dashboard, polling
 * diff, snapshot enrichment) don't have to re-parse.
 */
declare function listTodos(list?: string, cli?: RemindersCli, execFn?: ExecFn): Promise<ReminderTodo[]>;
interface AddTodoInput {
    title: string;
    notes?: string;
    due?: string;
    metadata?: {
        pid: number;
        repo: string;
        phase: "plan" | "exec" | "review";
    };
}
/**
 * Add a new reminder. When `metadata` is provided we append the canonical
 * `pid:N repo:R phase:P` line to the notes blob (separated by a blank line
 * from any user prose). The polling loop and the snapshot enricher rely on
 * this format being present.
 *
 * Round-trip note: the response from remindctl includes the same notes we
 * sent, so parseTodoMetadata on the response will produce the same metadata
 * object the caller passed in (verified in cli.spec.ts).
 */
declare function addTodo(input: AddTodoInput, list?: string, cli?: RemindersCli, execFn?: ExecFn): Promise<ReminderTodo>;
/**
 * Mark a reminder as completed. `id` accepts either the full UUID or a
 * unique prefix (remindctl resolves prefixes; the apple-reminders-cli +
 * ekctl fallbacks accept the full UUID).
 */
declare function completeTodo(id: string, cli?: RemindersCli, execFn?: ExecFn): Promise<{
    ok: boolean;
}>;

/**
 * Reminders metadata parser/formatter — Phase 2 Plan 02-02 (ORC-08).
 *
 * Each Jarvis-managed Reminder ends its body with the canonical line
 * `pid:NNNN repo:<name> phase:<plan|exec|review>`. This module is the
 * bidirectional bridge: parseTodoMetadata extracts, formatTodoMetadata
 * rebuilds. Round-trip parity is required so user prose survives our
 * write-backs.
 *
 * Locked schema (CONTEXT.md `<decisions>` + RESEARCH.md lines 460-475):
 *   - Position: LAST line of the notes blob, separated from prose by `\n\n`
 *   - Format:   pid:<digits> repo:<word> phase:<plan|exec|review>
 *   - Regex:    /^pid:(\d+)\s+repo:([^\s]+)\s+phase:(plan|exec|review)\s*$/m
 */

/**
 * Extract pid/repo/phase from a notes blob.
 *
 * Returns `{}` for null/undefined/empty input or if no metadata line is
 * present — never throws. Callers should distinguish "untracked todo"
 * (returned `{}`) from "tracked but unparseable" (which we treat as `{}`
 * so the bridge stays resilient to user-edited notes).
 */
declare function parseTodoMetadata(notes: string | null | undefined): TodoMetadata;
/**
 * Build the canonical metadata line. Caller is responsible for prepending
 * user prose + `\n\n` if any (see cli.ts addTodo).
 */
declare function formatTodoMetadata(meta: {
    pid: number;
    repo: string;
    phase: TodoPhase;
}): string;

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

export { type CliProbe as C, type ExecFn as E, type PollOptions as P, type ReminderTodo as R, type TodoEvent as T, type RemindersCli as a, type TodoMetadata as b, type TodoPhase as c, addTodo as d, completeTodo as e, diffTodos as f, formatTodoMetadata as g, getActiveCli as h, probeAuth as i, stopReminderPolling as j, listTodos as l, parseTodoMetadata as p, startReminderPolling as s };

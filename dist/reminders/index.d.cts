import { a as RemindersCli, R as ReminderTodo, C as CliProbe, c as TodoPhase, b as TodoMetadata } from '../poll-BrgFV9zk.cjs';
export { P as PollOptions, d as diffTodos, s as startReminderPolling, e as stopReminderPolling } from '../poll-BrgFV9zk.cjs';

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

export { type ExecFn, addTodo, completeTodo, formatTodoMetadata, getActiveCli, listTodos, parseTodoMetadata, probeAuth };

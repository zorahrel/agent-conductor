import { A as AuditEntry } from '../sessions-CdTstnnc.cjs';

type ExecFn = (cmd: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
interface PaneRow {
    pid: number;
    session: string;
    pane: string;
    windowIndex: number;
    active: boolean;
}
/**
 * One shell-out to `tmux list-panes -aF` covering ALL sessions.
 *
 * Returns [] on any error (tmux not running, no panes, exec failed) so
 * callers can treat "no tmux" as a normal degraded state rather than an
 * exception. Bare-TTY semantics live in CONTEXT.md.
 */
declare function listAllPanes(execFn?: ExecFn): Promise<PaneRow[]>;
/**
 * Resolve a session PID to its pane via parent-walking.
 *
 * Why walk parents: Claude CLI under tmux runs as a *child* of the shell,
 * which is the pane's foreground process. So the pid we observe in
 * `discoverLocalSessions()` (the Claude CLI) won't match the pane_pid
 * directly — we have to walk up the ppid chain until we hit either a
 * matching pane_pid or PID 1 (give up).
 *
 * `cachedPanes` (W4 FIX): snapshot.ts builds a single pid→paneInfo map
 * once per snapshot and passes it here so we don't shell out to `tmux`
 * on every call when polling many sessions. When supplied, listAllPanes
 * is skipped entirely — only `ps -o ppid=` shell-outs remain (one per
 * level of the parent chain).
 */
declare function findPaneForPid(targetPid: number, execFn?: ExecFn, cachedPanes?: Map<number, {
    session: string;
    pane: string;
}>): Promise<{
    session: string;
    pane: string;
} | null>;
/**
 * Send keystrokes to a tmux pane.
 *
 * - Always uses execFile + arg-array (NEVER shell strings). RESEARCH.md
 *   Pitfall 4 — `\n` is literal in send-keys, multi-line text needs each
 *   line as its own argument with `Enter` literals between them.
 * - The `--` terminator neutralizes user-supplied text that starts with
 *   `-` (would otherwise be parsed as a tmux flag).
 * - Single send-keys invocation per call — atomic from tmux's POV.
 */
declare function sendKeys(paneId: string, text: string, execFn?: ExecFn): Promise<void>;
/**
 * Capture the last N lines of a pane for echo verification / audit aid.
 * Non-fatal — callers should swallow exceptions.
 */
declare function capturePane(paneId: string, lines?: number, execFn?: ExecFn): Promise<string>;

/** Module-load resolution — kept for back-compat exports. Runtime uses getAuditDir(). */
declare const AUDIT_DIR: string;
declare const AUDIT_FILE_PATH: string;
declare const ROTATE_BYTES: number;
declare function appendAudit(entry: AuditEntry): Promise<void>;

export { AUDIT_DIR, AUDIT_FILE_PATH, type PaneRow, ROTATE_BYTES, appendAudit, capturePane, findPaneForPid, listAllPanes, sendKeys };

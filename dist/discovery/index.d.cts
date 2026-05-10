import { L as LocalSession } from '../local-session-CkYcDh7W.cjs';
import '../sessions-CdTstnnc.cjs';

/**
 * Discovery — find live AI coding agent CLI sessions on the local machine.
 *
 * The core library is data-source-agnostic: `buildSnapshot(sessions)` accepts
 * sessions from any provider. This module ships a default discovery strategy
 * (best-effort `ps` parsing for Claude Code today; provider adapters in v0.3+).
 *
 * Consumers that already track session metadata (Jarvis router, Topics App)
 * should ignore this module and provide their own `LocalSession[]` instead.
 */

interface DiscoveryProvider {
    /** Human-friendly name shown in `agent-conductor sessions --provider <name>`. */
    name: string;
    /** Returns every live session matching this provider's CLI signature. */
    discover(): Promise<LocalSession[]>;
}
/** Default `ps -axwo` columns we parse — kept tight for portability. */
interface PsRow {
    pid: number;
    ppid: number;
    command: string;
}

/**
 * Cross-platform `ps` wrapper — list every running process with pid/ppid/command.
 *
 * Uses POSIX `ps -axwo pid=,ppid=,command=` which works on macOS, Linux, and BSD
 * variants. Each output line is `<pid> <ppid> <command...>`.
 */

declare function listAllProcesses(): Promise<PsRow[]>;
declare function parsePsOutput(stdout: string): PsRow[];

/**
 * Claude Code CLI discovery — best-effort.
 *
 * Strategy: scan `ps` for processes whose command line includes the Claude
 * Code binary path or the `claude` invocation, then enrich each match with
 * the most recently modified JSONL transcript under `~/.claude/projects/`
 * that shares the inferred cwd.
 *
 * This is intentionally simpler than a full hook-event-aware discovery
 * (such as Jarvis's router): it doesn't track router-spawn vs bare-CLI,
 * doesn't read sidecar metadata, and falls back to `unknown` status when
 * unsure. Production consumers should plug their own provider instead.
 */

declare const claudeCodeProvider: DiscoveryProvider;

export { type DiscoveryProvider, type PsRow, claudeCodeProvider, listAllProcesses, parsePsOutput };

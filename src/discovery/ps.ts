/**
 * Cross-platform `ps` wrapper — list every running process with pid/ppid/command.
 *
 * Uses POSIX `ps -axwo pid=,ppid=,command=` which works on macOS, Linux, and BSD
 * variants. Each output line is `<pid> <ppid> <command...>`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PsRow } from "./types.js";

const execFileAsync = promisify(execFile);

export async function listAllProcesses(): Promise<PsRow[]> {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-axwo",
      "pid=,ppid=,command=",
    ], { maxBuffer: 8 * 1024 * 1024 });
    return parsePsOutput(stdout);
  } catch {
    return [];
  }
}

export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Greedy split: pid<spaces>ppid<spaces>command(rest)
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, command });
    }
  }
  return rows;
}

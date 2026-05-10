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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

import type { LocalSession } from "../types/local-session.js";
import { listAllProcesses } from "./ps.js";
import type { DiscoveryProvider } from "./types.js";

const execFileAsync = promisify(execFile);

const CLAUDE_PATTERNS = [
  /\/claude\b/,
  /[/ ]node\b.+\bclaude\b/,
  /[/ ]claude --print/,
  /Claude\.app/,
];

function looksLikeClaude(command: string): boolean {
  return CLAUDE_PATTERNS.some((re) => re.test(command));
}

/** Resolve cwd of a pid using `lsof -a -d cwd -p <pid>` (POSIX). */
async function cwdOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { timeout: 1500 },
    );
    // -Fn output: lines starting with "n/path/...". We pick the first n-line.
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1) || null;
    }
  } catch {
    /* ignore — pid may have vanished or lsof not installed */
  }
  return null;
}

/** Encode a filesystem path the way Claude Code does for `~/.claude/projects/<encoded>`. */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function findTranscriptForCwd(cwd: string): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects", encodeProjectPath(cwd));
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(root, name);
    try {
      const st = await fs.stat(path);
      if (!newest || st.mtimeMs > newest.mtime) {
        newest = { path, mtime: st.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }
  return newest?.path ?? null;
}

async function gitBranchOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 1500 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export const claudeCodeProvider: DiscoveryProvider = {
  name: "claude-code",

  async discover(): Promise<LocalSession[]> {
    const processes = await listAllProcesses();
    const candidates = processes.filter((p) => looksLikeClaude(p.command));
    const out: LocalSession[] = [];

    for (const p of candidates) {
      const cwd = (await cwdOf(p.pid)) ?? process.cwd();
      const branch = await gitBranchOf(cwd);
      const transcriptPath = await findTranscriptForCwd(cwd);
      out.push({
        pid: p.pid,
        cwd,
        repoName: basename(cwd),
        branch,
        status: "unknown",
        hookEvent: null,
        sessionId: null,
        transcriptPath,
        lastActivity: Date.now(),
        tty: null,
        parentCommand: null,
        preview: { lastUserMessage: null, lastAssistantText: null },
        isRouterSpawned: false,
      });
    }
    return out;
  },
};

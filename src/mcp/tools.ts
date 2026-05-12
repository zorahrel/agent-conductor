/**
 * MCP tool registry — the canonical list of tools agent-conductor exposes
 * over MCP. Each tool maps to an existing library function so there is
 * exactly one implementation of business logic per capability.
 *
 * Naming: `snake_case` to match Claude Code's tool conventions
 * (see docs/v0.5-spec.md §6 D2).
 *
 * Safety: `inject` requires an explicit `approve: true` in arguments.
 * Mirrors the `confidence === "high"` gate used by the auto-pilot path.
 * Re-evaluable per docs/v0.5-spec.md §6 D3.
 */

import { promises as fs } from "node:fs";
import {
  buildSnapshot,
  readJsonlTailLines,
  extractLastAssistantTurn,
  listTodos,
  addTodo,
  completeTodo,
  sendKeys,
  appendAudit,
  findPaneForPid,
  detectConflict,
  AUDIT_FILE_PATH,
} from "../index.js";
import {
  getProvider,
  allProviders,
  DEFAULT_PROVIDER_NAME,
} from "../providers/registry.js";
import { claudeCodeProvider } from "../providers/claude-code.js";
import type { McpToolDescriptor } from "./protocol.js";

/**
 * Tool handler signature — takes the JSON-RPC `arguments` object and returns
 * an arbitrary payload that the server will JSON-stringify into a `text`
 * content block.
 *
 * Handlers throw on protocol-level errors (the server maps them to
 * `isError: true` tool responses).
 */
export type McpToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface McpTool {
  descriptor: McpToolDescriptor;
  handler: McpToolHandler;
}

const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
};

const numberArg = (args: Record<string, unknown>, key: string): number | undefined => {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

const boolArg = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
};

// ---- snapshot --------------------------------------------------------------

const snapshotTool: McpTool = {
  descriptor: {
    name: "snapshot",
    description:
      "Build an OrchestratorSnapshot for every live AI coding session: pid, repo, branch, refinedStatus, last assistant summary, deterministic suggestion + action, tmux pane mapping, cwd-collision conflict marker.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "Provider name (claude-code | aider | cursor-cli). Default: claude-code. Use --all-providers semantics by passing 'all'.",
        },
      },
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const providerName = stringArg(args, "provider") ?? DEFAULT_PROVIDER_NAME;
    let sessions;
    if (providerName === "all") {
      const merged = await Promise.all(
        allProviders().map(async (p) => {
          try {
            return await p.discover();
          } catch {
            return [];
          }
        }),
      );
      sessions = merged.flat();
    } else {
      const p = getProvider(providerName);
      if (!p) {
        throw new Error(
          `unknown provider '${providerName}'. Available: ${allProviders().map((x) => x.name).join(", ")}`,
        );
      }
      sessions = await p.discover();
    }
    return await buildSnapshot(sessions);
  },
};

// ---- sessions --------------------------------------------------------------

const sessionsTool: McpTool = {
  descriptor: {
    name: "sessions",
    description:
      "Discover live AI coding sessions (cheaper than snapshot — no transcript tail, no suggestion, no tmux lookup).",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider name. Default: claude-code. Use 'all' for every provider.",
        },
      },
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const providerName = stringArg(args, "provider") ?? DEFAULT_PROVIDER_NAME;
    if (providerName === "all") {
      const merged = await Promise.all(
        allProviders().map(async (p) => {
          try {
            return await p.discover();
          } catch {
            return [];
          }
        }),
      );
      return merged.flat();
    }
    const p = getProvider(providerName);
    if (!p) {
      throw new Error(
        `unknown provider '${providerName}'. Available: ${allProviders().map((x) => x.name).join(", ")}`,
      );
    }
    return await p.discover();
  },
};

// ---- transcript ------------------------------------------------------------

const transcriptTool: McpTool = {
  descriptor: {
    name: "transcript",
    description:
      "Read the last N turns from a JSONL transcript at the given path (tails the last few KB rather than reading the whole file).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the .jsonl transcript file.",
        },
        limit: {
          type: "number",
          description: "Number of recent lines to return (default: 5).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const path = stringArg(args, "path");
    if (!path) throw new Error("missing required arg: path");
    const limit = numberArg(args, "limit") ?? 5;
    const lines = await readJsonlTailLines(path, limit);
    const lastAssistant = await extractLastAssistantTurn(path);
    return { path, limit, lines, lastAssistant };
  },
};

// ---- todos_list ------------------------------------------------------------

const todosListTool: McpTool = {
  descriptor: {
    name: "todos_list",
    description:
      "List todos from the Apple Reminders intent layer. macOS only; returns {authorized:false} on other platforms or when remindctl is missing.",
    inputSchema: {
      type: "object",
      properties: {
        list: {
          type: "string",
          description: "Reminders list name (default: AgentTasks).",
        },
      },
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const list = stringArg(args, "list") ?? "AgentTasks";
    return await listTodos(list);
  },
};

// ---- todos_add -------------------------------------------------------------

const todosAddTool: McpTool = {
  descriptor: {
    name: "todos_add",
    description: "Create a new todo in the Apple Reminders intent layer.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Todo title." },
        body: {
          type: "string",
          description:
            "Optional body. Use 'pid:NNNN repo:foo phase:plan' metadata format.",
        },
        list: { type: "string", description: "List name (default: AgentTasks)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const title = stringArg(args, "title");
    if (!title) throw new Error("missing required arg: title");
    const body = stringArg(args, "body");
    const list = stringArg(args, "list") ?? "AgentTasks";
    return await addTodo({ title, notes: body }, list);
  },
};

// ---- todos_complete --------------------------------------------------------

const todosCompleteTool: McpTool = {
  descriptor: {
    name: "todos_complete",
    description: "Mark a todo completed in the Apple Reminders intent layer.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Reminder ID — full UUID or a unique prefix (remindctl resolves prefixes).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const id = stringArg(args, "id");
    if (!id) throw new Error("missing required arg: id");
    return await completeTodo(id);
  },
};

// ---- inject ----------------------------------------------------------------

const injectTool: McpTool = {
  descriptor: {
    name: "inject",
    description:
      "Send keystrokes to the tmux pane owning the given pid (with audit log). REQUIRES `approve: true` in arguments — mirrors the auto-pilot 'confidence === high' gate. Cwd-collision lock is enforced unless `force: true`.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Target process pid." },
        text: { type: "string", description: "Keystrokes to send (newline appended by sendKeys)." },
        approve: {
          type: "boolean",
          description:
            "Must be `true`. Explicit safety gate so MCP clients cannot inject without intent.",
        },
        force: {
          type: "boolean",
          description: "Bypass the cwd-collision lock. Default false.",
        },
        dryRun: {
          type: "boolean",
          description: "Audit-only, do not actually call tmux send-keys.",
        },
        source: {
          type: "string",
          description:
            "Audit log `source` tag. Constrained to 'user-approved' | 'auto' | 'skill'; anything else (or omitted) is normalised to 'skill' since MCP callers are typically other agents invoking on the user's behalf.",
        },
      },
      required: ["pid", "text", "approve"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const pid = numberArg(args, "pid");
    const text = stringArg(args, "text");
    const approve = boolArg(args, "approve");
    if (pid === undefined) throw new Error("missing required arg: pid (number)");
    if (text === undefined) throw new Error("missing required arg: text (string)");
    if (approve !== true) {
      throw new Error("missing required arg: approve === true (explicit safety gate)");
    }
    const force = boolArg(args, "force") ?? false;
    const dryRun = boolArg(args, "dryRun") ?? false;
    // Audit source is constrained to {user-approved | auto | skill} (AuditEntry).
    // Default MCP callers to "skill" — they are typically other agents invoking
    // agent-conductor as a skill on the user's behalf. Explicit override allowed.
    const sourceRaw = stringArg(args, "source");
    const source: "user-approved" | "auto" | "skill" =
      sourceRaw === "user-approved" || sourceRaw === "auto" ? sourceRaw : "skill";

    // Resolve pane.
    const pane = await findPaneForPid(pid);
    if (!pane) {
      throw new Error(`precondition: pid ${pid} is not running under tmux (bare TTY sessions are read-only)`);
    }

    // Look up the session for repo metadata + cwd-collision check.
    const sessions = await claudeCodeProvider.discover();
    const me = sessions.find((s) => s.pid === pid);
    const repoSlug = me?.repoName ?? "unknown";

    // Cwd-collision check (unless --force). Mirrors injectCmd in cli/commands/inject.ts.
    if (!force && me) {
      for (const other of sessions) {
        if (other.pid === pid) continue;
        if (await detectConflict(me.cwd, other.cwd)) {
          throw new Error(
            `precondition: cwd_collision with pid ${other.pid} on path ${me.cwd} (use force:true to bypass)`,
          );
        }
      }
    }

    // Dry-run: do not call tmux send-keys AND do not write the audit log —
    // mirrors the CLI's `--dry-run` behaviour in cli/commands/inject.ts.
    if (dryRun) {
      return {
        ok: true,
        pid,
        pane: pane.pane,
        session: pane.session,
        repo: repoSlug,
        dryRun: true,
      };
    }

    const ts = Date.now();
    await sendKeys(pane.pane, text);
    await appendAudit({ pid, repo: repoSlug, action: "inject", text, source, ts });
    return {
      ok: true,
      pid,
      pane: pane.pane,
      session: pane.session,
      repo: repoSlug,
      dryRun: false,
      audit: { ts, pid, repo: repoSlug, action: "inject" as const, text, source },
    };
  },
};

// ---- audit_tail ------------------------------------------------------------

const auditTailTool: McpTool = {
  descriptor: {
    name: "audit_tail",
    description: "Return the last N entries from the inject audit log.",
    inputSchema: {
      type: "object",
      properties: {
        tail: { type: "number", description: "Number of entries (default: 20)." },
      },
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const tail = numberArg(args, "tail") ?? 20;
    let raw: string;
    try {
      raw = await fs.readFile(AUDIT_FILE_PATH, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: AUDIT_FILE_PATH, total: 0, entries: [] };
      }
      throw err;
    }
    const entries: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    const slice = entries.slice(-tail);
    return { path: AUDIT_FILE_PATH, total: entries.length, entries: slice };
  },
};

// ---- registry --------------------------------------------------------------

/**
 * The canonical tool registry. Order is preserved by `tools/list`.
 * Keep alphabetical-by-category for predictability.
 */
export const MCP_TOOLS: readonly McpTool[] = [
  snapshotTool,
  sessionsTool,
  transcriptTool,
  todosListTool,
  todosAddTool,
  todosCompleteTool,
  injectTool,
  auditTailTool,
];

/** Find a tool by name. */
export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.descriptor.name === name);
}

/** All tool descriptors (for `tools/list`). */
export function allToolDescriptors(): McpToolDescriptor[] {
  return MCP_TOOLS.map((t) => t.descriptor);
}

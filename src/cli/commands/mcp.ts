/**
 * `agent-conductor mcp` — start the MCP stdio server.
 *
 * Wires stdin/stdout/stderr to the dispatcher in src/mcp/server.ts. Exits 0
 * on stdin EOF (the client closed the pipe). Errors emitted by individual
 * tool calls become `isError: true` content blocks, NOT a process crash.
 *
 * Usage:
 *   agent-conductor mcp
 *
 * Wire as an MCP server in a Claude Code / Codex / Tessera client config:
 *   {
 *     "mcpServers": {
 *       "agent-conductor": {
 *         "command": "agent-conductor",
 *         "args": ["mcp"]
 *       }
 *     }
 *   }
 *
 * See docs/v0.5-spec.md for the full surface and acceptance criteria.
 */

import { runStdioServer } from "../../mcp/index.js";
import type { ParsedArgs } from "../args.js";
import { flagBool } from "../args.js";

const HELP = `Usage: agent-conductor mcp

Start the MCP stdio server. Reads JSON-RPC 2.0 messages on stdin, writes
responses on stdout. Exits 0 when stdin closes.

This is the side-car / observability surface intended to be consumed by
MCP clients (Claude Code, Codex, Tessera, custom dashboards) so they can
see and pilot AI coding sessions the client did not spawn itself.

Flags:
  -h, --help          Show this help

Examples:
  # As a server in an MCP client config (claude desktop, etc.):
  # {
  #   "mcpServers": {
  #     "agent-conductor": { "command": "agent-conductor", "args": ["mcp"] }
  #   }
  # }

  # Quick stdio handshake test:
  printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \\
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | agent-conductor mcp
`;

export async function mcpCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  await runStdioServer();
  return 0;
}

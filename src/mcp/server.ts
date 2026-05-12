/**
 * MCP stdio server for agent-conductor.
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from stdin, writes responses
 * to stdout. Conforms to MCP protocol version 2024-11-05.
 *
 * Why hand-rolled: the v0.5 spec (docs/v0.5-spec.md §6 D1) calls for keeping
 * runtime deps at zero unless a hand-roll proves unmaintainable. This file is
 * ~150 LOC of pure stdio framing + dispatch — nothing the official SDK gives
 * us that we'd actually use.
 *
 * Surface:
 *   - `dispatch(req)` is pure: takes a JSON-RPC request, returns a response
 *     (or null for notifications). Unit-testable without spawning anything.
 *   - `runStdioServer({ stdin, stdout, stderr })` wires `dispatch` to streams.
 *     Defaults to process.* but accepts mocks for tests.
 */

import { createInterface, type Interface } from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  jsonRpcError,
  jsonRpcSuccess,
  toolCallError,
  toolCallSuccess,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolsCallParams,
  type ToolsCallResult,
  type ToolsListResult,
} from "./protocol.js";
import { allToolDescriptors, findTool } from "./tools.js";

/** Server version — replaced at build time by tsup `define`. */
function serverVersion(): string {
  return (
    (globalThis as { __AGENT_CONDUCTOR_VERSION__?: string })
      .__AGENT_CONDUCTOR_VERSION__ ?? "dev"
  );
}

/**
 * Pure-functional dispatcher. Given a parsed JSON-RPC request, returns either:
 *   - a `JsonRpcResponse` (request)
 *   - `null` (notification — no response per JSON-RPC spec)
 *
 * Used by both `runStdioServer` and `server.spec.ts`.
 */
export async function dispatch(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  // Validate envelope.
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return jsonRpcError(
      req.id ?? null,
      JsonRpcErrorCode.InvalidRequest,
      "invalid JSON-RPC envelope",
    );
  }

  const id: JsonRpcId = req.id ?? null;
  const isNotification = req.id === undefined;

  switch (req.method) {
    case "initialize": {
      const _params = (req.params as InitializeParams | undefined) ?? {};
      const result: InitializeResult = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: serverVersion() },
      };
      return isNotification ? null : jsonRpcSuccess<InitializeResult>(id, result);
    }

    case "notifications/initialized":
    case "initialized":
      // Notification — no response per JSON-RPC.
      return null;

    case "ping":
      return isNotification ? null : jsonRpcSuccess(id, {});

    case "tools/list": {
      const result: ToolsListResult = { tools: allToolDescriptors() };
      return jsonRpcSuccess<ToolsListResult>(id, result);
    }

    case "tools/call": {
      const params = req.params as ToolsCallParams | undefined;
      if (!params || typeof params.name !== "string") {
        return jsonRpcError(
          id,
          JsonRpcErrorCode.InvalidParams,
          "tools/call requires { name: string, arguments?: object }",
        );
      }
      const tool = findTool(params.name);
      if (!tool) {
        return jsonRpcError(
          id,
          JsonRpcErrorCode.MethodNotFound,
          `unknown tool '${params.name}'`,
        );
      }
      try {
        const payload = await tool.handler(params.arguments ?? {});
        return toolCallSuccess(id, payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Tool-level errors are returned as `isError: true` content blocks,
        // NOT JSON-RPC errors — the JSON-RPC call itself succeeded. This is
        // how MCP separates "the protocol broke" from "the tool reported an
        // error to the model".
        return toolCallError(id, msg);
      }
    }

    default:
      return jsonRpcError(
        id,
        JsonRpcErrorCode.MethodNotFound,
        `unknown method '${req.method}'`,
      );
  }
}

export interface RunStdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

/**
 * Wire `dispatch` to newline-delimited JSON over stdio. Returns a Promise that
 * resolves when stdin closes (EOF). The caller (`agent-conductor mcp`)
 * forwards that resolution into process.exit(0).
 */
export function runStdioServer(opts: RunStdioOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const rl: Interface = createInterface({
    input: stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  const writeLine = (obj: unknown): void => {
    stdout.write(JSON.stringify(obj) + "\n");
  };

  return new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch (err) {
        writeLine(
          jsonRpcError(
            null,
            JsonRpcErrorCode.ParseError,
            `parse error: ${(err as Error).message}`,
          ),
        );
        return;
      }
      void (async () => {
        try {
          const res = await dispatch(req);
          if (res !== null) writeLine(res);
        } catch (err) {
          stderr.write(
            `agent-conductor mcp: dispatch crash: ${(err as Error).stack ?? String(err)}\n`,
          );
          writeLine(
            jsonRpcError(
              req.id ?? null,
              JsonRpcErrorCode.InternalError,
              `internal error: ${(err as Error).message}`,
            ),
          );
        }
      })();
    });
    rl.on("close", () => resolve());
  });
}

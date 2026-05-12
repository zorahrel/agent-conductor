/**
 * MCP (Model Context Protocol) — minimal JSON-RPC 2.0 types.
 *
 * Hand-rolled, zero deps. Aligned with MCP protocol version 2024-11-05.
 *
 * We model only the subset we use:
 *   - `initialize` / `notifications/initialized`
 *   - `tools/list`
 *   - `tools/call`
 *
 * If the surface grows beyond ~5 methods, reconsider pulling in
 * `@modelcontextprotocol/sdk` (see docs/v0.5-spec.md §6 D1).
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "agent-conductor";

/** JSON-RPC 2.0 standard error codes we use. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

/** MCP `initialize` request params. */
export interface InitializeParams {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, never>;
  };
  serverInfo: { name: string; version: string };
}

/** MCP tool descriptor returned by `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolsListResult {
  tools: McpToolDescriptor[];
}

/** MCP `tools/call` params. */
export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** MCP content block — text only for v0.5. */
export interface McpTextContent {
  type: "text";
  text: string;
}

export interface ToolsCallResult {
  content: McpTextContent[];
  isError?: boolean;
}

/** Helper: build a successful response. */
export function jsonRpcSuccess<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: "2.0", id, result };
}

/** Helper: build an error response. */
export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcError["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** Helper: wrap a tool error as a successful response with `isError:true`. */
export function toolCallError(id: JsonRpcId, message: string): JsonRpcSuccess<ToolsCallResult> {
  return jsonRpcSuccess<ToolsCallResult>(id, {
    isError: true,
    content: [{ type: "text", text: message }],
  });
}

/** Helper: wrap a tool result as a successful response. */
export function toolCallSuccess(
  id: JsonRpcId,
  payload: unknown,
): JsonRpcSuccess<ToolsCallResult> {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return jsonRpcSuccess<ToolsCallResult>(id, {
    content: [{ type: "text", text }],
  });
}

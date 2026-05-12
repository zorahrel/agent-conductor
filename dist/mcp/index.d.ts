import { Readable, Writable } from 'node:stream';

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
declare const MCP_PROTOCOL_VERSION = "2024-11-05";
declare const MCP_SERVER_NAME = "agent-conductor";
/** JSON-RPC 2.0 standard error codes we use. */
declare const JsonRpcErrorCode: {
    readonly ParseError: -32700;
    readonly InvalidRequest: -32600;
    readonly MethodNotFound: -32601;
    readonly InvalidParams: -32602;
    readonly InternalError: -32603;
};
type JsonRpcId = string | number | null;
interface JsonRpcRequest<P = unknown> {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method: string;
    params?: P;
}
interface JsonRpcSuccess<R = unknown> {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result: R;
}
interface JsonRpcError {
    jsonrpc: "2.0";
    id: JsonRpcId;
    error: {
        code: number;
        message: string;
        data?: unknown;
    };
}
type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;
/** MCP `initialize` request params. */
interface InitializeParams {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    clientInfo?: {
        name: string;
        version: string;
    };
}
interface InitializeResult {
    protocolVersion: string;
    capabilities: {
        tools: Record<string, never>;
    };
    serverInfo: {
        name: string;
        version: string;
    };
}
/** MCP tool descriptor returned by `tools/list`. */
interface McpToolDescriptor {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}
interface ToolsListResult {
    tools: McpToolDescriptor[];
}
/** MCP `tools/call` params. */
interface ToolsCallParams {
    name: string;
    arguments?: Record<string, unknown>;
}
/** MCP content block — text only for v0.5. */
interface McpTextContent {
    type: "text";
    text: string;
}
interface ToolsCallResult {
    content: McpTextContent[];
    isError?: boolean;
}

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

/**
 * Pure-functional dispatcher. Given a parsed JSON-RPC request, returns either:
 *   - a `JsonRpcResponse` (request)
 *   - `null` (notification — no response per JSON-RPC spec)
 *
 * Used by both `runStdioServer` and `server.spec.ts`.
 */
declare function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null>;
interface RunStdioOptions {
    stdin?: Readable;
    stdout?: Writable;
    stderr?: Writable;
}
/**
 * Wire `dispatch` to newline-delimited JSON over stdio. Returns a Promise that
 * resolves when stdin closes (EOF). The caller (`agent-conductor mcp`)
 * forwards that resolution into process.exit(0).
 */
declare function runStdioServer(opts?: RunStdioOptions): Promise<void>;

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

/**
 * Tool handler signature — takes the JSON-RPC `arguments` object and returns
 * an arbitrary payload that the server will JSON-stringify into a `text`
 * content block.
 *
 * Handlers throw on protocol-level errors (the server maps them to
 * `isError: true` tool responses).
 */
type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface McpTool {
    descriptor: McpToolDescriptor;
    handler: McpToolHandler;
}
/**
 * The canonical tool registry. Order is preserved by `tools/list`.
 * Keep alphabetical-by-category for predictability.
 */
declare const MCP_TOOLS: readonly McpTool[];
/** Find a tool by name. */
declare function findTool(name: string): McpTool | undefined;
/** All tool descriptors (for `tools/list`). */
declare function allToolDescriptors(): McpToolDescriptor[];

export { type InitializeParams, type InitializeResult, type JsonRpcError, JsonRpcErrorCode, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcSuccess, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_TOOLS, type McpTextContent, type McpTool, type McpToolDescriptor, type McpToolHandler, type RunStdioOptions, type ToolsCallParams, type ToolsCallResult, type ToolsListResult, allToolDescriptors, dispatch, findTool, runStdioServer };

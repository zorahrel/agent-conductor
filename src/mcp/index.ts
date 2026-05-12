/**
 * agent-conductor MCP server — public surface.
 *
 * Library consumers can:
 *   - `runStdioServer()` to embed the server in their own process
 *   - `dispatch(req)` to unit-test or proxy individual JSON-RPC calls
 *   - `MCP_TOOLS` / `findTool` / `allToolDescriptors` to introspect the
 *     advertised tool catalog (e.g. to render documentation)
 *
 * The CLI binary `agent-conductor mcp` is the canonical entry point.
 */

export {
  runStdioServer,
  dispatch,
  type RunStdioOptions,
} from "./server.js";

export {
  MCP_TOOLS,
  findTool,
  allToolDescriptors,
  type McpTool,
  type McpToolHandler,
} from "./tools.js";

export {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type JsonRpcError,
  type JsonRpcId,
  type InitializeParams,
  type InitializeResult,
  type McpToolDescriptor,
  type ToolsListResult,
  type ToolsCallParams,
  type ToolsCallResult,
  type McpTextContent,
} from "./protocol.js";

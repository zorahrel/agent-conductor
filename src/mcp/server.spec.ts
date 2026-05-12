/**
 * MCP server — smoke tests for the dispatcher.
 *
 * Covers AC1 (initialize handshake shape) and partial AC2 (tools/list returns
 * the canonical set) from docs/v0.5-spec.md. The remaining ACs (full
 * tools/call coverage with fixtures, cwd-collision error path) land alongside
 * the per-tool implementation work in subsequent commits.
 *
 * Test framework: node:test + node:assert/strict, matching the rest of the
 * repo. No external test deps.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dispatch,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  type InitializeResult,
  type JsonRpcSuccess,
  type ToolsListResult,
  type ToolsCallResult,
} from "./index.js";
import { allToolDescriptors } from "./tools.js";

describe("mcp/server dispatch", () => {
  it("AC1 — initialize returns server info + protocol version", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
    assert.ok(res, "initialize must return a response (it has an id)");
    assert.equal((res as JsonRpcSuccess).jsonrpc, "2.0");
    assert.equal((res as JsonRpcSuccess).id, 1);
    const result = (res as JsonRpcSuccess<InitializeResult>).result;
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(result.serverInfo.name, MCP_SERVER_NAME);
    assert.equal(typeof result.serverInfo.version, "string");
    assert.deepEqual(result.capabilities.tools, {});
  });

  it("notifications/initialized returns null (no response per JSON-RPC notification)", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(res, null);
  });

  it("AC2 — tools/list returns the canonical set with non-empty descriptions and inputSchemas", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.ok(res, "tools/list must return a response");
    const result = (res as JsonRpcSuccess<ToolsListResult>).result;
    const names = result.tools.map((t) => t.name).sort();
    // Canonical v0.5 surface — must stay stable until v0.6 unless the spec
    // is updated. If you change this list, update docs/v0.5-spec.md §3 AC2.
    assert.deepEqual(
      names,
      [
        "audit_tail",
        "inject",
        "sessions",
        "snapshot",
        "todos_add",
        "todos_complete",
        "todos_list",
        "transcript",
      ],
      "canonical tool set",
    );
    for (const tool of result.tools) {
      assert.ok(tool.description.length > 0, `${tool.name} has a description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema.type==='object'`);
    }
  });

  it("tools/list descriptors match the in-process registry order", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const result = (res as JsonRpcSuccess<ToolsListResult>).result;
    assert.deepEqual(
      result.tools.map((t) => t.name),
      allToolDescriptors().map((t) => t.name),
      "tools/list order matches MCP_TOOLS registration order",
    );
  });

  it("tools/call with unknown name → MethodNotFound JSON-RPC error", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    assert.ok(res);
    assert.ok("error" in (res as object), "must be JSON-RPC error envelope");
    if ("error" in res!) {
      assert.equal(res.error.code, -32601);
    }
  });

  it("AC3 (partial) — inject without `approve: true` returns isError content (NOT a JSON-RPC error)", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "inject",
        arguments: { pid: 99999, text: "y" }, // missing approve
      },
    });
    assert.ok(res);
    assert.ok("result" in (res as object), "JSON-RPC succeeds; the tool reports an error inside content");
    const result = (res as JsonRpcSuccess<ToolsCallResult>).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /approve/);
  });

  it("invalid JSON-RPC envelope → InvalidRequest error", async () => {
    const res = await dispatch({
      // @ts-expect-error — deliberately bad
      jsonrpc: "1.0",
      id: 6,
      method: "anything",
    });
    assert.ok(res);
    assert.ok("error" in (res as object));
    if ("error" in res!) {
      assert.equal(res.error.code, -32600);
    }
  });

  it("unknown method → MethodNotFound", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "does/not/exist",
    });
    assert.ok(res);
    assert.ok("error" in (res as object));
    if ("error" in res!) {
      assert.equal(res.error.code, -32601);
    }
  });

  it("ping → empty success result", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 8, method: "ping" });
    assert.ok(res);
    assert.ok("result" in (res as object));
    if ("result" in res!) {
      assert.deepEqual(res.result, {});
    }
  });
});

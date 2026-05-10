import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getProvider,
  allProviders,
  registerProvider,
  DEFAULT_PROVIDER_NAME,
} from "./registry.js";
import type { AgentProvider } from "./types.js";

test("DEFAULT_PROVIDER_NAME is claude-code", () => {
  assert.equal(DEFAULT_PROVIDER_NAME, "claude-code");
});

test("registry has claude-code, aider, cursor-cli pre-registered", () => {
  const names = allProviders().map((p) => p.name).sort();
  assert.ok(names.includes("claude-code"));
  assert.ok(names.includes("aider"));
  assert.ok(names.includes("cursor-cli"));
});

test("getProvider('claude-code') returns the default provider", () => {
  const p = getProvider("claude-code");
  assert.ok(p, "claude-code provider should resolve");
  assert.equal(p!.name, "claude-code");
  assert.equal(p!.displayName, "Claude Code");
});

test("getProvider('aider') returns aider stub", () => {
  const p = getProvider("aider");
  assert.ok(p);
  assert.equal(p!.name, "aider");
});

test("getProvider('does-not-exist') returns undefined", () => {
  assert.equal(getProvider("does-not-exist"), undefined);
});

test("registerProvider adds a custom provider and getProvider finds it", () => {
  const custom: AgentProvider = {
    name: "my-test-provider",
    displayName: "Test",
    description: "test",
    discover: async () => [],
    readTranscript: async () => null,
    deriveStatus: async () => "idle" as const,
    suggestNext: () => ({
      text: "test",
      action: { type: "none" as const },
      confidence: "low" as const,
      reason: "test",
    }),
    inject: async () => ({ ok: false, reason: "test" }),
  };
  registerProvider(custom);
  assert.equal(getProvider("my-test-provider"), custom);
});

test("each provider exposes name + displayName + description as non-empty strings", () => {
  for (const p of allProviders()) {
    assert.ok(p.name.length > 0, `${p.name} must have non-empty name`);
    assert.ok(p.displayName.length > 0, `${p.name} must have non-empty displayName`);
    assert.ok(p.description.length > 0, `${p.name} must have non-empty description`);
  }
});

test("each provider implements all required AgentProvider methods", () => {
  for (const p of allProviders()) {
    assert.equal(typeof p.discover, "function", `${p.name}.discover`);
    assert.equal(typeof p.readTranscript, "function", `${p.name}.readTranscript`);
    assert.equal(typeof p.deriveStatus, "function", `${p.name}.deriveStatus`);
    assert.equal(typeof p.suggestNext, "function", `${p.name}.suggestNext`);
    assert.equal(typeof p.inject, "function", `${p.name}.inject`);
  }
});

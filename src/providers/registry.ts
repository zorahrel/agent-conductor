/**
 * Provider registry — central lookup so the CLI and library consumers can
 * resolve providers by name. Defaults to Claude Code; consumers can register
 * additional providers at startup.
 *
 * Usage:
 *
 *   import { registerProvider, getProvider, allProviders } from "agent-conductor";
 *
 *   // Built-ins (Claude Code, Aider stub, Cursor CLI stub) are pre-registered.
 *
 *   // Custom provider:
 *   registerProvider(myCustomProvider);
 *
 *   // Lookup:
 *   const p = getProvider("aider"); // → AiderProvider
 *   const all = allProviders();     // → AgentProvider[]
 */

import type { AgentProvider } from "./types.js";
import { claudeCodeProvider } from "./claude-code.js";
import { aiderProvider } from "./aider.js";
import { cursorCliProvider } from "./cursor-cli.js";

const registry = new Map<string, AgentProvider>();

/** Register or replace a provider in the global registry. */
export function registerProvider(provider: AgentProvider): void {
  registry.set(provider.name, provider);
}

/** Look up a provider by its `name` (the value of `--provider <name>` flag). */
export function getProvider(name: string): AgentProvider | undefined {
  return registry.get(name);
}

/** All currently registered providers, in registration order. */
export function allProviders(): AgentProvider[] {
  return Array.from(registry.values());
}

/** The default provider used when none is explicitly specified. */
export const DEFAULT_PROVIDER_NAME = "claude-code";

// Pre-register built-ins.
registerProvider(claudeCodeProvider);
registerProvider(aiderProvider);
registerProvider(cursorCliProvider);

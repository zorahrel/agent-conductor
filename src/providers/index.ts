/**
 * Provider sub-module — multi-provider barrel.
 *
 * Treats every AI coding agent CLI as a pluggable backend. v0.4 ships
 * Claude Code (full), Aider (discovery+inject only), Cursor CLI (discovery only).
 * Roadmap: ChatGPT CLI, Continue.dev, custom-built agents.
 */

export type {
  AgentProvider,
  InjectResult,
  TranscriptTurnShape,
} from "./types.js";

export {
  registerProvider,
  getProvider,
  allProviders,
  DEFAULT_PROVIDER_NAME,
} from "./registry.js";

export { claudeCodeProvider } from "./claude-code.js";
export { aiderProvider } from "./aider.js";
export { cursorCliProvider } from "./cursor-cli.js";

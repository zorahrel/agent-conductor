/**
 * Discovery barrel.
 *
 * Provides best-effort default providers so the CLI works headless. Library
 * consumers (Jarvis, Topics) typically supply their own session list and can
 * ignore this module.
 */

export { listAllProcesses, parsePsOutput } from "./ps.js";
export { claudeCodeProvider } from "./claude-code.js";
export type { DiscoveryProvider, PsRow } from "./types.js";

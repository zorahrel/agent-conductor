/**
 * Discovery — find live AI coding agent CLI sessions on the local machine.
 *
 * The core library is data-source-agnostic: `buildSnapshot(sessions)` accepts
 * sessions from any provider. This module ships a default discovery strategy
 * (best-effort `ps` parsing for Claude Code today; provider adapters in v0.3+).
 *
 * Consumers that already track session metadata (Jarvis router, Topics App)
 * should ignore this module and provide their own `LocalSession[]` instead.
 */

import type { LocalSession } from "../types/local-session.js";

export interface DiscoveryProvider {
  /** Human-friendly name shown in `agent-conductor sessions --provider <name>`. */
  name: string;

  /** Returns every live session matching this provider's CLI signature. */
  discover(): Promise<LocalSession[]>;
}

/** Default `ps -axwo` columns we parse — kept tight for portability. */
export interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

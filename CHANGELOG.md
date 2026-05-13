# Changelog

All notable changes to `agent-conductor` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-13

The "side-car becomes consumable" release. `agent-conductor` was always a Node library, but v0.4 callers had to write their own glue to bridge to anything outside the Node ecosystem. v0.5 ships **three standard surfaces** — MCP stdio, HTTP, WebSocket — plus a SQLite samples store and a Prometheus `/metrics` exposition. Host-mode workspaces (Tessera, custom dashboards, the user's own notch/tray/router) can now consume the side-car view of every live AI coding session on the machine without re-implementing discovery, JSONL tail, or Reminders integration.

### Added

- **MCP stdio server** — `agent-conductor mcp` advertises 8 tools (`snapshot`, `sessions`, `transcript`, `todos_list`, `todos_add`, `todos_complete`, `inject`, `audit_tail`) over JSON-RPC 2.0. Hand-rolled, zero new deps. Wire as `mcpServers.agent-conductor.command="agent-conductor"` in any MCP client config.
- **HTTP + WebSocket daemon** — `agent-conductor serve` binds 127.0.0.1 (loopback only, DNS-rebinding guard rejects any non-loopback `Host:` header with 403). Routes: `GET /health`, `GET /snapshot`, `GET /sessions`, `GET /audit`, `GET /metrics`, `WS /events`. Default port 32140, scans upward on EADDRINUSE.
- **WebSocket event stream** — clients receive a `hello` frame on connect, then live `todo:added`/`todo:completed`/`todo:updated` (from the Reminders bridge) and `sessions:update` (refinedStatus delta). Pollers wake on first connect, sleep on last disconnect — idle daemon = zero background work.
- **SQLite timeseries store** — opt-in via `--timeseries` flag or `AGENT_CONDUCTOR_TIMESERIES=1`. Stores `(ts, provider, pid, refinedStatus, turnCount, toolCount, lastWriteAge)` samples at `~/.local/share/agent-conductor/timeseries.db` (override via `AGENT_CONDUCTOR_STATE_DIR`). WAL mode, retention via row-count cap (100k default ≈ 6.4 MB).
- **Prometheus `/metrics` exporter** — text/plain version 0.0.4. Emits `agent_conductor_build_info`, `agent_conductor_sessions_total{provider, status}`, `agent_conductor_samples_total`, `agent_conductor_audit_bytes_total`, `agent_conductor_todos_total{state}`.
- **Graceful shutdown** — SIGINT/SIGTERM drains in-flight HTTP requests within 2 s, sends `1001 ("going away")` WS close frames, then exits 0. Structured `ShutdownReport` logged: `closed clean in 4ms (http inflight 0→0, ws clients 1)`.
- **Compose-with-Tessera doc** — `docs/compose-with-tessera.md` walks any host-mode workspace through wiring agent-conductor as a side-car: launchd unit → `/snapshot` polling → WS subscription → optional MCP-server-in-agent. Includes a "what NOT to do" section.
- **Backward-compat smoke** — `npm run test:backcompat` exercises every v0.4 public export against the built dist; catches signature drift before it lands.
- **New subpaths**: `agent-conductor/mcp`, `agent-conductor/http`, `agent-conductor/timeseries`.

### Changed

- README repositioned: explicit "Side-car, not host — when NOT to use this" section names `horang-labs/tessera` as the complementary host-mode workspace. Roadmap updated through v0.6.
- Test suite: 100 (v0.4) → 152 specs.

### Dependencies

- Added runtime: `ws@^8.20.0` (WebSocket server) and `better-sqlite3@^12.10.0` (timeseries store). Both single-purpose, zero/minimal transitives. Total runtime deps: 2 (was 0).
- Added dev: `@types/ws`, `@types/better-sqlite3`.
- `engines.node` remains `>=20`. `server.closeAllConnections()` (used by graceful shutdown) requires Node 18.2+ which the engine pin already covers.

### Security

- HTTP daemon binds `127.0.0.1` only. No remote bind, no auth layer in this release — remote access requires a reverse proxy you control. The DNS-rebinding guard (loopback-Host check) prevents browser-driven attacks where a remote page tries to hit the daemon via attacker-controlled DNS.
- MCP `inject` tool requires explicit `approve: true` argument — auto-pilot gate parity with the CLI's `--force`.

### Notes

- The 10 acceptance criteria from `docs/v0.5-spec.md` are all closed. AC6 (timeseries) and AC7 (Prometheus) ship in this release; AC1–AC5 + AC8–AC10 shipped in the v0.5 work-in-progress PRs (#6, #7, #8) merged into `main` since v0.4.0.
- `dist/` continues to be committed (consumers install via `npm install github:zorahrel/agent-conductor#v0.5.0`).

## [0.4.0] — 2026-05-11

### Added

- **Multi-provider architecture** — every command now accepts `--provider <name>`. The library exposes an `AgentProvider` interface (`discover` + `readTranscript` + `deriveStatus` + `suggestNext` + `inject`) and a registry consumers can extend.
- **3 built-in providers**:
  - `claude-code` ★ — full implementation, default
  - `aider` — discovery + tmux inject (transcript parser planned for v0.5)
  - `cursor-cli` — discovery only (`cursor-agent` process pattern; full impl planned for v0.5)
- **`agent-conductor providers <list|info>` CLI subcommand** to inspect the registry.
- **`--all-providers` flag** on `snapshot` and `sessions` to merge results across every registered provider.
- **8 new provider registry tests** (`src/providers/registry.spec.ts`).

### Changed

- `agent-conductor snapshot` and `agent-conductor sessions` route through the provider registry instead of importing `discovery/claude-code.js` directly.
- README and CHANGELOG now lead with multi-provider as a first-class feature.

### Notes

- Aider and Cursor CLI providers are intentionally honest stubs: discovery works, but transcript parsing requires per-provider format support that lands in v0.5 (markdown for Aider, JSONL-like for Cursor).
- The provider registry is global (process-wide). For library consumers that need multiple registries, this can be parameterised in a future minor.

## [0.3.0] — 2026-05-11

### Added

- **`agent-conductor` CLI binary** — terminal-driven workflows. Subcommands:
  - `snapshot` — full OrchestratorSnapshot for live sessions
  - `sessions` — discover only (cheaper than snapshot)
  - `transcript <path>` — project last-N turns from a JSONL transcript
  - `todos list | add | complete` — Apple Reminders intent layer
  - `tmux panes | find <pid>` — pane mapping inspection
  - `inject --pid N --text "y"` — write-side controller with audit + cwd-lock check
  - `audit [--tail N]` — view recent audit log entries
- **Best-effort discovery** (`src/discovery/`) — `ps`-based scanner that finds Claude Code CLI processes without requiring an orchestrator host. Cross-platform (macOS today, Linux uses same `ps -axwo`).
- **Zero-deps argparse** (`src/cli/args.ts`) — kept the runtime dependency tree empty.
- **CI** — GitHub Actions matrix on Node 20 + 22 with typecheck + tests + bash CLI integration tests.
- **Community docs** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- **Examples** — `examples/standalone-script.mjs` and `examples/express-dashboard.mjs`.

### Changed

- Default Reminders list renamed to `AgentTasks` (was `Jarvis/ActiveTasks`). Consumers can still pass any list name via the `list` parameter.
- README rewritten with logo, badges, install/quickstart, design principles, roadmap.

### Notes

- The `agent-conductor` binary is exposed via the `bin` field. After installing the package, you can run `npx agent-conductor snapshot` or, if globally installed, just `agent-conductor`.
- Runtime dependencies remain at **zero** — only `tsup`, `tsx`, `typescript`, `@types/node` are dev-time.

## [0.2.0] — 2026-05-10

### Added

- Public release under MIT license.
- Logo SVG (`assets/logo.svg`).
- Roadmap section in README.
- GitHub topics for discoverability.

### Changed

- All Italian docs / comments translated to English.
- Brand-neutral wording across source comments.

### Removed

- All personally identifiable information (PII) from fixtures:
  - User-specific paths replaced with `/Users/example/projects/demo-app`.
  - Private Reminders list names sanitized.
  - Real-name author replaced with GitHub username.

## [0.1.1] — 2026-05-10

### Changed

- `dist/` is now committed (was previously gitignored) so consumers can install via `github:zorahrel/agent-conductor#vX.Y.Z` without a `prepare` lifecycle hook.

## [0.1.0] — 2026-05-10

### Added

- Initial extraction from `jarvis-claudecode` Phase 2 (Orchestrator Multi-Session).
- Public API surfaces:
  - `agent-conductor/jsonl` — Claude Code JSONL transcript parser
  - `agent-conductor/sessions` — `refinedStatus`, `lock`, `suggest`, `snapshot`
  - `agent-conductor/tmux` — `tmuxMap`, `audit`
  - `agent-conductor/reminders` — `remindctl` wrapper, metadata, polling
- 68 tests with `node:test` + `node:assert/strict`.
- TypeScript 5.7 strict mode + `tsup` dual ESM+CJS build.

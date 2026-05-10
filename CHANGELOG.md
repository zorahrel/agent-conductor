# Changelog

All notable changes to `agent-conductor` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

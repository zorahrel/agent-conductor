# Contributing to agent-conductor

Thanks for considering a contribution. This is a small, focused toolkit — the contribution surface is correspondingly narrow, which makes review fast.

## Quick start

```bash
git clone https://github.com/zorahrel/agent-conductor.git
cd agent-conductor
npm install
npm test                # 83+ specs via node:test (zero test deps)
npm run typecheck       # TypeScript 5.7 strict
npm run build           # tsup ESM+CJS dual + CLI binary
bash tests/cli.bats.sh  # CLI integration tests (requires built dist/)
```

## How to propose changes

1. **Open an issue first** for anything non-trivial. A bug report + reproduction (or a feature proposal with a use case) gets faster feedback than an unsolicited PR.
2. **Branch from `main`** with a descriptive name: `fix/audit-rotation-race`, `feat/aider-provider`, `docs/clarify-tmux-fallback`.
3. **Write tests.** Every PR that touches behaviour adds or updates specs under `src/**/*.spec.ts`. CLI-affecting changes also update `tests/cli.bats.sh`.
4. **Keep runtime deps at zero.** This is a hard rule. Dev deps are fine in moderation. If you genuinely need a runtime dep, open an issue with the trade-off analysis first.
5. **Match existing style.** TypeScript strict, single quotes inside template literals, named exports (no default exports), explicit return types on exported functions, `node:` prefix on Node standard imports.
6. **One concern per PR.** Refactor + feature in the same PR slows everyone down. Split them.

## What gets merged faster

- **New discovery providers** (Aider, Cursor CLI, ChatGPT CLI). The interface is `DiscoveryProvider` in `src/discovery/types.ts`. Submit one provider per PR with a fixture + spec.
- **Cross-platform fixes** for Linux. Today the package targets macOS first; PRs that add Linux paths (without breaking macOS) are very welcome.
- **CLI ergonomics**: clearer help text, missing flag aliases, better error messages with exit codes.
- **Docs**: typo fixes, clarifications, examples in the `examples/` folder.

## What needs discussion before code

- Anything that adds a runtime dependency.
- Anything that changes a public API in a backward-incompatible way.
- Anything that ships a network call by default (no telemetry / silent reporting).
- Provider adapters for non-local services (cloud, multi-machine federation).

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) loosely:

```
feat: add Aider provider
fix(cli): inject exits 3 when no tmux instead of 1
docs(readme): clarify list parameter default
refactor(sessions): extract conflict map to its own module
test(tmux): cover detached-pane fallback
chore(deps): bump tsx to 4.20
```

Squash-merge is the default — keep commit messages focused; the PR title becomes the merged message.

## Code review

Maintainers look for:

- Tests cover the new behaviour (red→green→refactor where possible).
- No regression in CI (typecheck + unit + CLI bash tests).
- Public API surface didn't grow accidentally (check `src/index.ts` diff).
- No PII or user-specific paths in any new fixtures.

Expect a turn-around within a week. If it's been longer, ping the issue/PR with a polite bump.

## Security

Please don't open public issues for security findings. See [SECURITY.md](./SECURITY.md) for the disclosure path.

## License

By contributing you agree your changes are released under the [MIT License](./LICENSE).

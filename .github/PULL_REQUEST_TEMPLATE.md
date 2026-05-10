<!-- Thanks for the PR! A few checks before submitting: -->

## What does this change

<!-- A one-paragraph description. What problem does it solve? -->

## How to verify

<!-- Concrete steps a reviewer can run. -->

```bash
npm test
npm run typecheck
npm run build
bash tests/cli.bats.sh
```

## Checklist

- [ ] Tests added/updated under `src/**/*.spec.ts` (and `tests/cli.bats.sh` if CLI behaviour changed)
- [ ] `npm test` passes locally
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds and `dist/cli/bin.js` is runnable (`node dist/cli/bin.js --version`)
- [ ] No new runtime dependencies (open an issue first if you genuinely need one)
- [ ] No PII or user-specific paths in any new fixtures
- [ ] If the public API surface changed, `src/index.ts` re-exports are updated
- [ ] If commands or flags changed, README + `--help` text are updated

## Related issues

<!-- Closes #N, refs #M -->

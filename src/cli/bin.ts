#!/usr/bin/env node
/**
 * agent-conductor — CLI binary entry. Built with tsup with the shebang banner
 * preserved so `npx agent-conductor` / `./node_modules/.bin/agent-conductor`
 * just work on POSIX systems.
 *
 * Keep this file tiny: it only forwards to `run(argv)` and translates the
 * returned exit code into `process.exit`. Easier to test against.
 */
import { run } from "./index.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`agent-conductor: fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);

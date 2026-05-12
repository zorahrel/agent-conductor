import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * Single tsup config — both library subpaths and the CLI binary build in one
 * pass. The CLI source file already includes a `#!/usr/bin/env node` shebang
 * (so `tsx src/cli/bin.ts` works during development); tsup preserves it in
 * the emitted output, so no `banner` option is needed.
 *
 * Multi-config array (returning `[lib, cli]` from defineConfig) was tried first
 * and dropped because tsup's array form intermittently skipped the second
 * config in CI environments.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "jsonl/index": "src/jsonl/index.ts",
    "sessions/index": "src/sessions/index.ts",
    "tmux/index": "src/tmux/index.ts",
    "reminders/index": "src/reminders/index.ts",
    "discovery/index": "src/discovery/index.ts",
    "providers/index": "src/providers/index.ts",
    "mcp/index": "src/mcp/index.ts",
    "http/index": "src/http/index.ts",
    "cli/bin": "src/cli/bin.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  outDir: "dist",
  define: {
    "globalThis.__AGENT_CONDUCTOR_VERSION__": JSON.stringify(pkg.version),
  },
});

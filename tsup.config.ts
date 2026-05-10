import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "jsonl/index": "src/jsonl/index.ts",
    "sessions/index": "src/sessions/index.ts",
    "tmux/index": "src/tmux/index.ts",
    "reminders/index": "src/reminders/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node20",
  outDir: "dist",
});

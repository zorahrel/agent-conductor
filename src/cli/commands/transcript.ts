/**
 * `agent-conductor transcript <path>` — project last-N turns from a JSONL file.
 */

import { buildTranscript } from "../../sessions/snapshot.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagInt } from "../args.js";
import { renderJson } from "./_render.js";

const HELP = `Usage: agent-conductor transcript <path> [--limit N] [--json]

Project the last N turns from a Claude Code JSONL transcript. Skips
attachment + last-prompt rows. User content strings are normalized to
[{type:"text"}] for consistency.

Flags:
  --limit N           Max turns (default 10)
  --json              Output raw TranscriptResponse
  -h, --help          Show this help
`;

export async function transcriptCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const path = args._[0];
  if (!path) {
    process.stderr.write("transcript: missing <path>\n\n");
    process.stderr.write(HELP);
    return 2;
  }
  const limit = flagInt(args, "limit") ?? 10;
  const tx = await buildTranscript(path, 0, limit);

  if (flagBool(args, "json")) {
    renderJson(tx);
    return 0;
  }
  if (tx.turns.length === 0) {
    process.stdout.write("(no turns)\n");
    return 0;
  }
  for (const turn of tx.turns) {
    const text = turn.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
    const toolUses = turn.content.filter((b) => b.type === "tool_use");
    process.stdout.write(`\n── ${turn.role.toUpperCase()}  ${turn.timestamp}\n`);
    if (text) process.stdout.write(text.slice(0, 500) + (text.length > 500 ? "…" : "") + "\n");
    for (const tu of toolUses) {
      process.stdout.write(`   [tool_use ${tu.name ?? "?"}  id=${tu.id ?? "?"}]\n`);
    }
    if (turn.stop_reason) {
      process.stdout.write(`   (stop_reason: ${turn.stop_reason})\n`);
    }
  }
  return 0;
}

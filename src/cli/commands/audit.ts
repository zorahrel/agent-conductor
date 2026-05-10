/**
 * `agent-conductor audit` — show last N entries from the audit log.
 */

import { promises as fs } from "node:fs";
import { AUDIT_FILE_PATH } from "../../tmux/audit.js";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagInt } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor audit [--tail N] [--json]

Show the tail of the audit log (default: 20 entries).
Audit path is overridable via the AGENT_CONDUCTOR_AUDIT_DIR env var.

Flags:
  --tail N            How many entries (default 20)
  --json              JSON output (one array)
  -h, --help          Show this help
`;

interface AuditRow {
  ts: number;
  pid: number;
  repo: string;
  action: string;
  text?: string;
  source: string;
}

export async function auditCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const tail = flagInt(args, "tail") ?? 20;

  let raw: string;
  try {
    raw = await fs.readFile(AUDIT_FILE_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (flagBool(args, "json")) renderJson([]);
      else process.stdout.write(`(no audit log yet at ${AUDIT_FILE_PATH})\n`);
      return 0;
    }
    process.stderr.write(`audit: ${(err as Error).message}\n`);
    return 1;
  }

  const rows: AuditRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as AuditRow);
    } catch {
      /* skip malformed line */
    }
  }
  const slice = rows.slice(-tail);

  if (flagBool(args, "json")) {
    renderJson(slice);
    return 0;
  }
  if (slice.length === 0) {
    process.stdout.write("(audit log empty)\n");
    return 0;
  }
  const cols: Column<AuditRow>[] = [
    { header: "WHEN", get: (r) => new Date(r.ts).toISOString() },
    { header: "PID", get: (r) => String(r.pid) },
    { header: "REPO", get: (r) => r.repo, max: 18 },
    { header: "ACTION", get: (r) => r.action },
    { header: "SOURCE", get: (r) => r.source },
    { header: "TEXT", get: (r) => r.text ?? "—", max: 32 },
  ];
  renderTable(slice, cols);
  process.stdout.write(`\nShowing last ${slice.length} of ${rows.length} entries from ${AUDIT_FILE_PATH}\n`);
  return 0;
}

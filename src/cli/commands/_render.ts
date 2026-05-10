/**
 * Shared rendering helpers for CLI subcommands.
 * - `renderJson(value)`     stable JSON output, no trailing newline games
 * - `renderTable(rows, cols)` pretty table with column max-width clamping
 */

export interface Column<T = unknown> {
  header: string;
  get: (row: T) => string;
  /** Optional max width — values longer get truncated with `…` */
  max?: number;
}

export function renderJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function clamp(s: string, max?: number): string {
  if (!max || s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function renderTable<T>(rows: T[], cols: Column<T>[]): void {
  if (rows.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }

  const cells = rows.map((row) => cols.map((c) => clamp(c.get(row), c.max)));
  const widths = cols.map((c, i) =>
    Math.max(c.header.length, ...cells.map((r) => r[i].length)),
  );

  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const header = cols.map((c, i) => c.header.padEnd(widths[i])).join(" │ ");
  process.stdout.write(header + "\n");
  process.stdout.write(sep + "\n");
  for (const r of cells) {
    process.stdout.write(r.map((v, i) => v.padEnd(widths[i])).join(" │ ") + "\n");
  }
}

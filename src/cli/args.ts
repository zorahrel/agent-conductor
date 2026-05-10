/**
 * Tiny zero-deps argv parser. We intentionally avoid `commander`/`yargs`/`cac`
 * to keep the runtime dependency tree at zero.
 *
 * Conventions:
 *   - First positional becomes `_[0]` (often the subcommand)
 *   - Long flags: `--flag` (boolean), `--flag value` or `--flag=value`
 *   - Short flags: `-f` (boolean), `-f value` or `-fvalue`
 *   - `--` ends option parsing; remaining args go to `_`
 *   - Unknown flags don't throw — they're collected in `flags` (caller validates)
 *
 * The parser intentionally does NOT auto-coerce values. Callers handle
 * `String → number/boolean` themselves so error messages are domain-specific.
 */

export interface ParsedArgs {
  /** Positional arguments in order, excluding the subcommand if `extractSubcommand` is used. */
  _: string[];
  /** Long + short flag values. Boolean flags map to `true`. Repeated flags become arrays. */
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let i = 0;
  let endOfOptions = false;

  const set = (key: string, value: string | boolean): void => {
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[key] = [String(existing), String(value)];
    }
  };

  while (i < argv.length) {
    const tok = argv[i];

    if (endOfOptions) {
      positional.push(tok);
      i++;
      continue;
    }

    if (tok === "--") {
      endOfOptions = true;
      i++;
      continue;
    }

    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        const key = tok.slice(2, eq);
        const value = tok.slice(eq + 1);
        set(key, value);
        i++;
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          set(key, next);
          i += 2;
        } else {
          set(key, true);
          i++;
        }
      }
    } else if (tok.startsWith("-") && tok.length > 1) {
      // `-f` or `-fvalue`
      const key = tok.slice(1, 2);
      const inline = tok.slice(2);
      if (inline) {
        set(key, inline);
        i++;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          set(key, next);
          i += 2;
        } else {
          set(key, true);
          i++;
        }
      }
    } else {
      positional.push(tok);
      i++;
    }
  }

  return { _: positional, flags };
}

/** Read a flag as string-or-undefined. Multi-value flags return the first value. */
export function flagString(
  args: ParsedArgs,
  ...names: string[]
): string | undefined {
  for (const n of names) {
    const v = args.flags[n];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v[0];
  }
  return undefined;
}

/** Read a flag as boolean (presence-based). */
export function flagBool(args: ParsedArgs, ...names: string[]): boolean {
  for (const n of names) {
    const v = args.flags[n];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v !== "false" && v !== "0";
  }
  return false;
}

/** Read a flag as integer; returns `undefined` if missing or unparseable. */
export function flagInt(
  args: ParsedArgs,
  ...names: string[]
): number | undefined {
  const s = flagString(args, ...names);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

/**
 * `agent-conductor providers <list>` — inspect the provider registry.
 *
 * v0.4 exposes the multi-provider architecture explicitly: every CLI command
 * accepts `--provider <name>` and the registry advertises which providers
 * are registered + which support which capabilities.
 */

import { allProviders, getProvider, DEFAULT_PROVIDER_NAME } from "../../providers/registry.js";
import type { ParsedArgs } from "../args.js";
import { flagBool } from "../args.js";
import { renderJson, renderTable, type Column } from "./_render.js";

const HELP = `Usage: agent-conductor providers <subcommand> [flags]

Subcommands:
  list                List every registered AgentProvider
  info <name>         Show full description + capabilities for one provider

Flags:
  --json              JSON output
  -h, --help          Show this help

Examples:
  agent-conductor providers list
  agent-conductor providers info aider
  agent-conductor providers list --json
`;

export async function providersCmd(args: ParsedArgs): Promise<number> {
  if (flagBool(args, "h", "help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = args._[0];
  switch (sub) {
    case "list":
      return runList(args);
    case "info":
      return runInfo(args);
    default:
      process.stderr.write(`providers: unknown subcommand '${sub ?? ""}'\n\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

function runList(args: ParsedArgs): number {
  const providers = allProviders();
  if (flagBool(args, "json")) {
    renderJson(
      providers.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        isDefault: p.name === DEFAULT_PROVIDER_NAME,
      })),
    );
    return 0;
  }
  const cols: Column<typeof providers[number]>[] = [
    { header: "NAME", get: (p) => p.name },
    { header: "DISPLAY", get: (p) => p.displayName, max: 18 },
    { header: "DEFAULT", get: (p) => (p.name === DEFAULT_PROVIDER_NAME ? "★" : "") },
    { header: "DESCRIPTION", get: (p) => p.description, max: 72 },
  ];
  renderTable(providers, cols);
  process.stdout.write(`\nRegistered: ${providers.length} provider(s). Default: ${DEFAULT_PROVIDER_NAME}\n`);
  return 0;
}

function runInfo(args: ParsedArgs): number {
  const name = args._[1];
  if (!name) {
    process.stderr.write("providers info: missing <name>\n");
    return 2;
  }
  const p = getProvider(name);
  if (!p) {
    process.stderr.write(
      `providers info: '${name}' not registered. Run 'agent-conductor providers list' to see available providers.\n`,
    );
    return 2;
  }
  if (flagBool(args, "json")) {
    renderJson({
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      isDefault: p.name === DEFAULT_PROVIDER_NAME,
      capabilities: {
        discover: true,
        readTranscript: typeof p.readTranscript === "function",
        deriveStatus: typeof p.deriveStatus === "function",
        suggestNext: typeof p.suggestNext === "function",
        inject: typeof p.inject === "function",
      },
    });
    return 0;
  }
  process.stdout.write(`Provider:    ${p.displayName} (${p.name})${p.name === DEFAULT_PROVIDER_NAME ? "  ★ default" : ""}\n`);
  process.stdout.write(`Description: ${p.description}\n\n`);
  process.stdout.write(`Capabilities (all providers implement the AgentProvider interface;\n`);
  process.stdout.write(`stub providers may return null / no-op until full implementation lands):\n`);
  process.stdout.write(`  - discover()        : best-effort 'ps'-based scan\n`);
  process.stdout.write(`  - readTranscript()  : reads provider-specific transcript format\n`);
  process.stdout.write(`  - deriveStatus()    : awaiting_user_input | tool_pending | crashed | working | idle\n`);
  process.stdout.write(`  - suggestNext()     : deterministic next-step (no LLM calls)\n`);
  process.stdout.write(`  - inject()          : tmux send-keys (or provider-specific channel)\n`);
  return 0;
}

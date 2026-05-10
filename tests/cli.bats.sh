#!/usr/bin/env bash
# Native bash test runner for the CLI (no bats-core dep). Pure shell —
# checks exit codes, stdout contains expected strings, JSON output is parsable.
#
# Run: bash tests/cli.bats.sh
# Exit: 0 if all pass, 1 otherwise.

set -uo pipefail

CLI="node $(dirname "$0")/../dist/cli/bin.js"
PASS=0
FAIL=0

check() {
  local name="$1"
  local expected_code="$2"
  local cmd="$3"
  local grep_pattern="${4:-}"

  local actual_output
  actual_output=$(eval "$cmd" 2>&1)
  local actual_code=$?

  if [[ "$actual_code" != "$expected_code" ]]; then
    echo "✘ $name  (expected exit $expected_code, got $actual_code)"
    echo "    cmd:    $cmd"
    echo "    output: ${actual_output:0:200}"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ -n "$grep_pattern" ]]; then
    if ! echo "$actual_output" | grep -qE "$grep_pattern"; then
      echo "✘ $name  (output did not match /$grep_pattern/)"
      echo "    cmd:    $cmd"
      echo "    output: ${actual_output:0:200}"
      FAIL=$((FAIL + 1))
      return
    fi
  fi

  echo "✔ $name"
  PASS=$((PASS + 1))
}

# Discovery / general flags
check "help (no args shows banner)" 0 "$CLI" "agent-conductor — pilot"
check "--help" 0 "$CLI --help" "Usage:"
check "--version" 0 "$CLI --version" "agent-conductor v"
check "unknown command exits 2" 2 "$CLI does-not-exist" "unknown command"

# Subcommand help
check "snapshot --help" 0 "$CLI snapshot --help" "snapshot \\[--json\\]"
check "sessions --help" 0 "$CLI sessions --help" "Discover live"
check "transcript --help" 0 "$CLI transcript --help" "Project the last"
check "todos --help" 0 "$CLI todos --help" "Subcommands:"
check "tmux --help" 0 "$CLI tmux --help" "Subcommands:"
check "inject --help" 0 "$CLI inject --help" "Send keystrokes"
check "audit --help" 0 "$CLI audit --help" "Show the tail"

# Snapshot smoke (may be empty if no sessions)
check "snapshot --json produces valid JSON" 0 "$CLI snapshot --json | node -e 'JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"))'" ""

# Sessions smoke
check "sessions --json produces valid JSON array" 0 "$CLI sessions --json | node -e 'const a=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(Array.isArray(a)?0:1)'" ""

# Transcript: missing path → exit 2
check "transcript without path exits 2" 2 "$CLI transcript" "missing <path>"

# Inject: missing required flags → exit 2
check "inject without flags exits 2" 2 "$CLI inject" "are required"

# Inject: nonexistent pid → exit 3 (not under tmux)
check "inject for fake pid 999999 exits 3" 3 "$CLI inject --pid 999999 --text x" "not running under tmux|tmux not available"

# Audit: should not crash even with empty log
check "audit doesn't crash" 0 "$CLI audit --tail 5" ""

# Tmux find: bogus pid
check "tmux find with non-numeric exits 2" 2 "$CLI tmux find abc" "invalid or missing"

echo ""
echo "═══════════════════════════════════════"
echo "  PASSED: $PASS    FAILED: $FAIL"
echo "═══════════════════════════════════════"
exit $((FAIL > 0 ? 1 : 0))

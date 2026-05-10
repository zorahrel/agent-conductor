# Security Policy

## Supported Versions

| Version  | Supported          |
| -------- | ------------------ |
| 0.3.x    | ✅ Active           |
| 0.2.x    | ⚠️ Security fixes only until 2026-08 |
| < 0.2    | ❌ Not supported    |

## Reporting a Vulnerability

If you find a security issue, **please do not open a public GitHub issue**.

Instead, use [GitHub Private Vulnerability Reporting](https://github.com/zorahrel/agent-conductor/security/advisories/new) to disclose the issue confidentially.

When reporting, please include:

- A description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- Any suggested mitigation, if you have one
- Your preferred attribution in a future advisory (name, handle, or anonymous)

You can expect:

- An acknowledgement within **3 business days**
- A triage decision within **7 business days**
- A patch released or a clear timeline within **30 business days** for high-severity issues

## Threat model

`agent-conductor` operates locally on the user's machine. The main attack surfaces:

1. **`tmux send-keys` injection** — the CLI sends keystrokes to other terminal panes. Mitigations:
   - `execFile` with arg-arrays (never shell strings)
   - Cwd-collision lock blocks accidental cross-session injection
   - All inject events written to an audit log
2. **Reminders body parsing** — metadata lines like `pid:N repo:X phase:Y` come from user-controlled Reminders entries. Mitigations:
   - Strict regex parsing (numeric pid, alnum-dash repo, enum phase)
   - Malformed lines are silently ignored (no exception bubbles to caller)
3. **JSONL transcript reading** — files come from `~/.claude/projects/`. Mitigations:
   - Last-256KB tail read (DoS-bounded)
   - JSON.parse wrapped in try/catch per line
   - No code is `eval`ed; transcripts are data only

We do not currently ship code-signing or SBOM. Both are on the v0.5 roadmap.

## Out of scope

- Issues in dependencies' dependencies (file those upstream)
- Anything requiring physical access to an already-compromised machine
- Theoretical issues without a proof-of-concept

Thank you for helping keep `agent-conductor` and its users safe.

# agent-conductor

Toolkit per **osservare, suggerire next-step, e iniettare comandi** attraverso N sessioni concorrenti di AI coding agent CLI da un singolo punto di controllo.

Estratto da [jarvis-claudecode](https://github.com/zorahrel/jarvis-claudecode) Phase 2 (Orchestrator Multi-Session) per essere riusabile come libreria in Jarvis, Topics App, e potenziali altri consumer.

## Cosa fa

- **Read-only observatory**: legge i transcript JSONL delle sessioni Claude Code (`~/.claude/projects/`) e deriva uno stato raffinato per sessione (`awaiting_user_input` / `tool_pending` / `crashed` / `working` / `idle`)
- **Deterministic suggestion engine**: produce un `next-step` ragionato per ogni sessione senza chiamare LLM
- **Cwd-collision lock**: rileva conflitti tra sessioni che lavorano sullo stesso path (worktree-aware via `.git` root walk)
- **tmux inject control**: mappa `pid → pane`, esegue `tmux send-keys` con audit log JSONL append-only (rotation a 10 MB)
- **macOS Reminders bridge**: wrapper attorno a `remindctl` (con fallback `apple-reminders-cli` / `ekctl`) come "intent layer" sincronizzato con iPhone/Watch/Siri; polling diff a 3s + metadata schema `pid:N repo:X phase:Y`

## Roadmap provider

v0.1 è Claude Code only. La sezione `sessions/` è già strutturata come libreria pura (legge JSONL standard, deriva stato) → v0.2 prevista per Aider, Cursor CLI, e altri tool che salvano transcript on disk.

## Installazione

Privato, distribuito via git URL:

```bash
npm install github:zorahrel/agent-conductor#v0.1.0
# o pinning sul commit
npm install github:zorahrel/agent-conductor#<sha>
```

## Uso base

```typescript
import { buildSnapshot, listTodos, sendKeys } from "agent-conductor";

// Snapshot di tutte le sessioni live
const snapshot = await buildSnapshot();
console.log(snapshot.sessions);
// [{ pid, repo, branch, status, last_assistant_summary, suggestion, action, todo_link, tmux }]

// Lettura todo Reminders
const todos = await listTodos({ list: "Jarvis/ActiveTasks" });

// Inject su una sessione (con audit)
await sendKeys({
  paneId: "%17",
  text: "y",
  source: "user-approved",
  audit: { pid: 1234, repo: "topics", action: "approve" },
});
```

## API entry points

| Import path | Cosa esporta |
|---|---|
| `agent-conductor` | API pubblica completa (re-exports da sub-paths) |
| `agent-conductor/jsonl` | Parser JSONL transcript (last-N turn extraction, tool_use pending detection, stop_reason) |
| `agent-conductor/sessions` | `refinedStatus`, `lock`, `suggest`, `snapshot` (logica osservativa pura) |
| `agent-conductor/tmux` | `findPaneForPid`, `getTmuxPanesOnce`, `sendKeys`, `appendAudit` |
| `agent-conductor/reminders` | `listTodos`, `addTodo`, `completeTodo`, `pollTodos`, `parseMetadata`/`formatMetadata` |

## Design principles

1. **No fs writes outside opt-in paths**: audit log scrive solo a `~/.claude/jarvis/orchestrator/audit.jsonl` (override-able), niente magia
2. **No LLM calls**: la suggestion engine è una lookup-table deterministica; nessun token speso
3. **Pure functions where possible**: `composeSnapshot(sessions, statusMap, lastByPid, conflictMap)` è sync+pure e unit-testabile
4. **Graceful degradation**: se `remindctl` manca o non è autorizzato → API ritorna `{authorized: false, banner}` invece di crashare; fallback `~/.claude/jarvis/todos.json` locale
5. **execFile arg-array everywhere**: nessuna shell string per tmux/CLI (security + portability)

## Stato

- v0.1.0 (2026-05-10): estrazione iniziale da Jarvis Phase 2. ~127 test GREEN, dual ESM/CJS build via tsup, TypeScript 5.7 strict mode.
- v0.2 (planned): provider adapters (Aider, Cursor CLI), local-file fallback Reminders, optional HTTP server bundled.

## License

UNLICENSED (private). Per ora distribuito solo a consumers interni (Jarvis, Topics App).

## Source projects

- `jarvis-claudecode/router/` — primo consumer, espone endpoint HTTP `/api/sessions/...`, `/api/todos`, `/api/sessions/:pid/inject`
- `topics-app/` (TBD) — secondo consumer, integra orchestrator nei suoi project tabs

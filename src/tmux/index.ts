/**
 * tmux sub-module: pid→pane resolution and write-side controls.
 *
 * `findPaneForPid` is parent-walking aware — Claude CLI runs as a child of the
 * shell, not as the pane's foreground process. Cache via `listAllPanes` once
 * per snapshot pass to avoid O(N) tmux exec calls.
 *
 * Audit log is append-only JSONL at `~/.claude/jarvis/orchestrator/audit.jsonl`
 * (override via `AGENT_CONDUCTOR_AUDIT_DIR` env var). Single-writer Promise
 * queue + 10 MB rotation.
 */

export {
  listAllPanes,
  findPaneForPid,
  sendKeys,
  capturePane,
  type PaneRow,
} from "./tmuxMap.js";

export {
  appendAudit,
  AUDIT_DIR,
  AUDIT_FILE_PATH,
  ROTATE_BYTES,
} from "./audit.js";

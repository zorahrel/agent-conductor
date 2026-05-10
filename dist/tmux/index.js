import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// src/tmux/tmuxMap.ts
var execFileDefault = promisify(execFile);
async function listAllPanes(execFn = execFileDefault) {
  let stdout;
  try {
    const r = await execFn("tmux", [
      "list-panes",
      "-aF",
      "#{pane_pid} #{session_name} #{pane_id} #{window_index} #{pane_active}"
    ]);
    stdout = r.stdout;
  } catch {
    return [];
  }
  return stdout.trim().split("\n").filter((l) => l.length > 0).map((line) => {
    const parts = line.split(" ");
    return {
      pid: parseInt(parts[0] ?? "0", 10),
      session: parts[1] ?? "",
      pane: parts[2] ?? "",
      windowIndex: parseInt(parts[3] ?? "0", 10),
      active: parts[4] === "1"
    };
  });
}
async function findPaneForPid(targetPid, execFn = execFileDefault, cachedPanes) {
  const panes = cachedPanes ? Array.from(cachedPanes.entries()).map(
    ([pid, v]) => ({ pid, session: v.session, pane: v.pane, windowIndex: 0, active: false })
  ) : await listAllPanes(execFn);
  if (panes.length === 0) return null;
  let cur = targetPid;
  for (let i = 0; i < 50 && cur > 1; i++) {
    const hit = panes.find((p) => p.pid === cur);
    if (hit) return { session: hit.session, pane: hit.pane };
    try {
      const { stdout } = await execFn("ps", ["-o", "ppid=", "-p", String(cur)]);
      const ppid = parseInt(stdout.trim(), 10);
      if (!ppid || ppid === cur) break;
      cur = ppid;
    } catch {
      return null;
    }
  }
  return null;
}
async function sendKeys(paneId, text, execFn = execFileDefault) {
  const lines = text.split("\n");
  const args = ["send-keys", "-t", paneId, "--"];
  for (const line of lines) {
    args.push(line);
    args.push("Enter");
  }
  await execFn("tmux", args);
}
async function capturePane(paneId, lines = 50, execFn = execFileDefault) {
  const { stdout } = await execFn("tmux", [
    "capture-pane",
    "-t",
    paneId,
    "-p",
    "-S",
    `-${lines}`
  ]);
  return stdout;
}
function getAuditDir() {
  return process.env.JARVIS_AUDIT_DIR ?? join(homedir(), ".claude", "jarvis", "orchestrator");
}
var AUDIT_DIR = getAuditDir();
var AUDIT_FILE_PATH = join(getAuditDir(), "audit.jsonl");
var ROTATE_BYTES = 10 * 1024 * 1024;
var writeQueue = Promise.resolve();
function appendAudit(entry) {
  writeQueue = writeQueue.then(async () => {
    const dir = getAuditDir();
    const path = join(dir, "audit.jsonl");
    await promises.mkdir(dir, { recursive: true });
    try {
      const st = await promises.stat(path);
      if (st.size > ROTATE_BYTES) {
        const archive = `${path}.${Date.now()}`;
        await promises.rename(path, archive);
      }
    } catch {
    }
    await promises.appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  }).catch(() => void 0);
  return writeQueue;
}

export { AUDIT_DIR, AUDIT_FILE_PATH, ROTATE_BYTES, appendAudit, capturePane, findPaneForPid, listAllPanes, sendKeys };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map
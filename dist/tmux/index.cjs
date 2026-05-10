'use strict';

var child_process = require('child_process');
var util = require('util');
var fs = require('fs');
var path = require('path');
var os = require('os');

// src/tmux/tmuxMap.ts
var execFileDefault = util.promisify(child_process.execFile);
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
  return process.env.JARVIS_AUDIT_DIR ?? path.join(os.homedir(), ".claude", "jarvis", "orchestrator");
}
var AUDIT_DIR = getAuditDir();
var AUDIT_FILE_PATH = path.join(getAuditDir(), "audit.jsonl");
var ROTATE_BYTES = 10 * 1024 * 1024;
var writeQueue = Promise.resolve();
function appendAudit(entry) {
  writeQueue = writeQueue.then(async () => {
    const dir = getAuditDir();
    const path$1 = path.join(dir, "audit.jsonl");
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      const st = await fs.promises.stat(path$1);
      if (st.size > ROTATE_BYTES) {
        const archive = `${path$1}.${Date.now()}`;
        await fs.promises.rename(path$1, archive);
      }
    } catch {
    }
    await fs.promises.appendFile(path$1, JSON.stringify(entry) + "\n", "utf8");
  }).catch(() => void 0);
  return writeQueue;
}

exports.AUDIT_DIR = AUDIT_DIR;
exports.AUDIT_FILE_PATH = AUDIT_FILE_PATH;
exports.ROTATE_BYTES = ROTATE_BYTES;
exports.appendAudit = appendAudit;
exports.capturePane = capturePane;
exports.findPaneForPid = findPaneForPid;
exports.listAllPanes = listAllPanes;
exports.sendKeys = sendKeys;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map
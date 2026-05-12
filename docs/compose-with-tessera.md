# Composing agent-conductor with a host-mode workspace (Tessera et al.)

This walkthrough shows how a host-mode AI coding workspace — [Tessera](https://github.com/horang-labs/tessera) is the archetype, but the pattern fits any IDE-style consumer — can consume `agent-conductor` as a **side-car** observability layer.

The two systems do different things on purpose. Tessera (or any host workspace) **owns** the CLI processes it spawned. agent-conductor **observes** sessions the human or another tool launched independently. Together, the workspace sees both: the agents it spawned via its own ChildProcess, plus the Claude Code session the human started three hours ago in a stray tmux pane.

---

## Why compose at all

A host-mode workspace already has a perfect view of its own sessions. The gap is everything else on the machine:

- A `claude` session the user launched in iTerm before opening the workspace.
- A `codex` session running in a `tmux` pane the workspace didn't open.
- An `aider` session another tool spawned.
- The user's intent layer — todos on the iPhone, dictated to Siri, or carried over from yesterday's Watch complications.

agent-conductor surfaces all of those without taking process ownership. Wire it as a data source and the host workspace inherits a complete picture without rewriting discovery, JSONL parsing, or Reminders integration.

---

## 1. Run agent-conductor as a launchd service

agent-conductor is opt-in. For a workspace integration you want it always-on. The simplest way on macOS is launchd.

`~/Library/LaunchAgents/io.agent-conductor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.agent-conductor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/path/to/agent-conductor/dist/cli/bin.js</string>
    <string>serve</string>
    <string>--port</string>
    <string>32140</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/agent-conductor.log</string>
  <key>StandardErrorPath</key><string>/tmp/agent-conductor.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/io.agent-conductor.plist
launchctl list | grep agent-conductor
curl http://127.0.0.1:32140/health
```

`KeepAlive=true` restarts the daemon if it crashes. The loopback bind + DNS-rebinding guard means the daemon is safe to keep running on a shared machine — no port a remote attacker can hit, and nothing leaks to the LAN.

Linux equivalent: a `~/.config/systemd/user/agent-conductor.service` unit file. Same shape (`ExecStart=node /path/to/dist/cli/bin.js serve --port 32140`, `Restart=always`).

---

## 2. Pull periodic snapshots from the workspace

The workspace polls `GET /snapshot` whenever it refreshes its session list:

```typescript
async function fetchSidecarSnapshot(): Promise<OrchestratorSnapshot | null> {
  try {
    const r = await fetch("http://127.0.0.1:32140/snapshot?provider=all", {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    return (await r.json()) as OrchestratorSnapshot;
  } catch {
    // Daemon not running, or 403 / 404 — degrade silently. The workspace
    // still shows its own sessions; we just lose the side-car view.
    return null;
  }
}
```

A few notes the host workspace UI should respect:

- Merge by pid. Sessions the workspace spawned **also** appear in `agent-conductor`'s discovery (it walks `ps`). Deduplicate so the user sees one row per session — prefer the workspace's own metadata when both views exist.
- `entry.tmux` tells you whether the session is under tmux. The workspace can hide its "inject" UI for sessions where tmux is `null` (they're bare TTYs the side-car cannot pilot).
- `entry.suggestion` is text. `entry.action` is structured: `{type: "inject", text: "y"}`, `{type: "none"}`, etc. The workspace UI should honor the `action.type` rather than re-parsing the human-readable suggestion.
- `entry.conflict` flags cwd-collision with another pid. Render it as a warning; the workspace should refuse to inject without the user explicitly overriding.

---

## 3. Subscribe to the event stream

Polling `/snapshot` every N seconds works, but it adds latency to "this session just hit `awaiting_user_input`". The WebSocket stream is the fix:

```typescript
const ws = new WebSocket("ws://127.0.0.1:32140/events");

ws.addEventListener("message", (evt) => {
  const frame = JSON.parse(evt.data) as
    | { type: "hello"; payload: { name: string; version: string; serverTime: string } }
    | { type: "todo:added" | "todo:completed" | "todo:updated"; payload: TodoEvent }
    | { type: "sessions:update"; payload: { pid: number; refinedStatus: RefinedStatus; previous: RefinedStatus | null } };

  switch (frame.type) {
    case "hello":
      console.log("[agent-conductor] connected:", frame.payload);
      break;
    case "sessions:update":
      // The workspace's session row for this pid needs a status refresh.
      onSessionStatusChanged(frame.payload.pid, frame.payload.refinedStatus);
      break;
    case "todo:added":
    case "todo:updated":
    case "todo:completed":
      // Surface in the workspace's task list. Round-trip through the
      // canonical /snapshot if you need full session→todo linkage.
      onTodoEvent(frame.type, frame.payload);
      break;
  }
});

ws.addEventListener("close", (e) => {
  // 1001 = "going away" (server is shutting down — common during dev rebuilds)
  // 1006 = abnormal (network blip)
  console.log("[agent-conductor] disconnected:", e.code, e.reason);
  scheduleReconnect();
});
```

There is no built-in reconnect helper as of v0.5. A 30-second exponential backoff with jitter is a safe default for the host workspace.

**Backpressure**: the broadcaster fans events out synchronously, but each socket has its own send buffer. If your client falls behind (rare on a single-user machine), `ws` will buffer up to its internal high-water mark and then drop. Treat WS as a "live deltas" channel and `/snapshot` as the source of truth.

---

## 4. (Optional) Use the MCP server from inside an agent

If the workspace spawns Claude Code or Codex itself, those agents can be given agent-conductor as an MCP server. The agent now sees every session on the machine (its own + the workspace's + bare-tmux ones) and can react.

Wire it as an MCP server in the agent's config — e.g. `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "agent-conductor": {
      "command": "agent-conductor",
      "args": ["mcp"]
    }
  }
}
```

The agent can now call `snapshot`, `sessions`, `transcript`, `todos_*`, `inject`, and `audit_tail` as MCP tools. `inject` requires an explicit `approve: true` argument, so the workspace's permission UI gets the chance to intercept.

This is the path where Tessera and agent-conductor are **most** complementary: Tessera owns the agent process; that agent reaches out through MCP to see/pilot sessions Tessera doesn't own.

---

## 5. Graceful shutdown contract

The daemon honors `SIGINT` and `SIGTERM` with a 2 s drain budget:

1. WebSocket clients receive a `1001 ("going away")` close frame.
2. In-flight HTTP requests are allowed to finish.
3. Force-close after the budget expires (rare on a healthy box).
4. Process exits 0.

The workspace should treat `close code 1001` as a clean disconnect (the daemon is restarting — maybe the user upgraded it) and reconnect after a short backoff rather than surfacing an error toast.

If the workspace uses launchd / systemd with `KeepAlive=true`, the daemon will be back within a second or two. A 2–5 s reconnect timer hides the blip from the user entirely.

---

## 6. What NOT to do

- **Don't bind the daemon to anything other than `127.0.0.1`.** There is no auth layer. Remote access requires a reverse proxy with auth that you control. The DNS-rebinding guard catches the common attack but not a real reverse proxy.
- **Don't poll `/snapshot` faster than every 2 s.** Each poll re-walks `ps`, tails N transcripts, and runs the suggestion engine. Faster than 2 s wastes battery on laptops with no upside.
- **Don't treat WS events as authoritative.** Backpressure or a missed reconnect can drop events. Use `/snapshot` for canonical state, WS for "something changed, refresh now".
- **Don't bypass `entry.conflict` when wiring inject.** Two sessions on the same git root will clobber each other. The workspace UI should treat the conflict marker as a hard "no inject" gate unless the user explicitly clears it.

---

## Reference

| Surface | Endpoint |
|---|---|
| Snapshot | `GET http://127.0.0.1:32140/snapshot` |
| Sessions (discovery only) | `GET http://127.0.0.1:32140/sessions` |
| Audit log tail | `GET http://127.0.0.1:32140/audit?tail=20` |
| Health | `GET http://127.0.0.1:32140/health` |
| Event stream | `WS  ws://127.0.0.1:32140/events` |
| MCP server | `agent-conductor mcp` (stdio JSON-RPC) |

Spec for the daemon: [`docs/v0.5-spec.md`](./v0.5-spec.md).
README positioning: [side-car vs host](../README.md#side-car-not-host--when-not-to-use-this).

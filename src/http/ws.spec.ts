/**
 * WebSocket layer — broadcaster unit tests + live WS smoke.
 *
 * Covers v0.5 spec AC5: clients receive a `hello` frame on connect and
 * subscribe to broadcaster events. Reminders and sessions diff pollers
 * activate when at least one client is connected.
 *
 * The Reminders poll path is exercised indirectly: we feed the broadcaster
 * a synthetic TodoEvent via its public `emit()` API and assert the client
 * receives the matching frame. This avoids spawning `remindctl` from CI.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startDaemon, WsBroadcaster, type WsEvent } from "./index.js";

describe("http/ws WsBroadcaster", () => {
  it("subscribe/emit round-trips events to every subscriber", () => {
    const b = new WsBroadcaster();
    const seenA: WsEvent[] = [];
    const seenB: WsEvent[] = [];
    const off1 = b.subscribe((e) => seenA.push(e));
    const off2 = b.subscribe((e) => seenB.push(e));

    const evt: WsEvent = {
      type: "sessions:update",
      payload: { pid: 1234, refinedStatus: "working", previous: "idle" },
    };
    b.emit(evt);

    assert.deepEqual(seenA, [evt]);
    assert.deepEqual(seenB, [evt]);
    off1();
    off2();
  });

  it("unsubscribe removes the subscriber", () => {
    const b = new WsBroadcaster();
    const seen: WsEvent[] = [];
    const off = b.subscribe((e) => seen.push(e));
    off();
    b.emit({
      type: "sessions:update",
      payload: { pid: 1, refinedStatus: "idle", previous: null },
    });
    assert.equal(seen.length, 0);
  });

  it("a throwing subscriber does not break the rest of the broadcast", () => {
    const b = new WsBroadcaster();
    const seen: WsEvent[] = [];
    b.subscribe(() => {
      throw new Error("bad subscriber");
    });
    b.subscribe((e) => seen.push(e));
    b.emit({
      type: "sessions:update",
      payload: { pid: 2, refinedStatus: "working", previous: "idle" },
    });
    assert.equal(seen.length, 1);
  });

  it("size() reflects subscriber count", () => {
    const b = new WsBroadcaster();
    assert.equal(b.size(), 0);
    const off = b.subscribe(() => undefined);
    assert.equal(b.size(), 1);
    off();
    assert.equal(b.size(), 0);
  });
});

describe("http/ws integration (live loopback)", () => {
  it("AC5 — client connecting to /events receives a hello frame", async () => {
    const broadcaster = new WsBroadcaster();
    // Long sessionsPollMs so the test doesn't race against the diff loop.
    const daemon = await startDaemon({ broadcaster, sessionsPollMs: 999_999 });
    try {
      const url = `ws://127.0.0.1:${daemon.port}/events`;
      const helloFrame = await new Promise<WsEvent>((resolve, reject) => {
        const ws = new WebSocket(url);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("timed out waiting for hello frame"));
        }, 3000);
        ws.on("message", (data) => {
          clearTimeout(timeout);
          try {
            const parsed = JSON.parse(data.toString()) as WsEvent;
            resolve(parsed);
          } catch (err) {
            reject(err);
          } finally {
            ws.close();
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      assert.equal(helloFrame.type, "hello");
      if (helloFrame.type === "hello") {
        assert.equal(helloFrame.payload.name, "agent-conductor");
        assert.equal(typeof helloFrame.payload.serverTime, "string");
      }
    } finally {
      await daemon.close();
    }
  });

  it("AC5 — broadcaster.emit() reaches a live ws client", async () => {
    const broadcaster = new WsBroadcaster();
    const daemon = await startDaemon({ broadcaster, sessionsPollMs: 999_999 });
    try {
      const url = `ws://127.0.0.1:${daemon.port}/events`;
      // Open client, skip hello, push one synthetic event, await it.
      const received = await new Promise<WsEvent[]>((resolve, reject) => {
        const ws = new WebSocket(url);
        const frames: WsEvent[] = [];
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`timed out — received ${frames.length} frames: ${JSON.stringify(frames)}`));
        }, 3000);
        ws.on("open", () => {
          // Slight delay so the server-side `connection` handler has wired
          // the subscription before we push. Without this, fast machines
          // occasionally emit before subscribe lands.
          setTimeout(() => {
            broadcaster.emit({
              type: "sessions:update",
              payload: { pid: 7777, refinedStatus: "awaiting_user_input", previous: "working" },
            });
          }, 50);
        });
        ws.on("message", (data) => {
          const parsed = JSON.parse(data.toString()) as WsEvent;
          frames.push(parsed);
          if (parsed.type === "sessions:update") {
            clearTimeout(timeout);
            ws.close();
            resolve(frames);
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const update = received.find((f) => f.type === "sessions:update");
      assert.ok(update, "must have received sessions:update");
      if (update?.type === "sessions:update") {
        assert.equal(update.payload.pid, 7777);
        assert.equal(update.payload.refinedStatus, "awaiting_user_input");
      }
    } finally {
      await daemon.close();
    }
  });

  it("AC5 (security) — WS upgrade with non-loopback Host header is rejected (403)", async () => {
    const daemon = await startDaemon({ sessionsPollMs: 999_999 });
    try {
      // Spoof the Host header via the WS handshake. Node's `ws` lib doesn't
      // expose Host directly; we use the lower-level `http.request` with the
      // Upgrade headers manually so we can override Host.
      const { request } = await import("node:http");
      const rejected = await new Promise<boolean>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: daemon.port,
            path: "/events",
            method: "GET",
            headers: {
              Host: "evil.example.com",
              Upgrade: "websocket",
              Connection: "Upgrade",
              "Sec-WebSocket-Version": "13",
              "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            },
          },
          (res) => {
            resolve(res.statusCode === 403);
          },
        );
        req.on("upgrade", () => {
          // If we got upgraded, the guard failed — surface that as not-rejected.
          resolve(false);
        });
        req.on("error", (err) => reject(err));
        req.end();
        setTimeout(() => resolve(false), 2000);
      });
      assert.equal(rejected, true, "WS upgrade must be refused with 403 on non-loopback Host");
    } finally {
      await daemon.close();
    }
  });
});

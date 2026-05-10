import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePsOutput } from "./ps.js";

test("parsePsOutput: handles standard macOS `ps -axwo pid,ppid,command` output", () => {
  const sample = `
   1234  1200 /usr/local/bin/node /usr/local/lib/node_modules/foo/bin/cli --watch
   5678     1 -bash
   9999  1234 claude --print
  `.trim();
  const rows = parsePsOutput(sample);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    pid: 1234,
    ppid: 1200,
    command: "/usr/local/bin/node /usr/local/lib/node_modules/foo/bin/cli --watch",
  });
  assert.equal(rows[1].command, "-bash");
  assert.equal(rows[2].pid, 9999);
});

test("parsePsOutput: skips blank lines + malformed rows", () => {
  const sample = `
   42  1 /bin/launchd

   not-a-row
   abc def /missing/numeric
   100 50 /good
  `.trim();
  const rows = parsePsOutput(sample);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.pid),
    [42, 100],
  );
});

test("parsePsOutput: command can contain extra whitespace", () => {
  const sample = "  77  1  /usr/bin/program   --flag    arg1  arg2";
  const rows = parsePsOutput(sample);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, "/usr/bin/program   --flag    arg1  arg2");
});

test("parsePsOutput: empty input returns []", () => {
  assert.deepEqual(parsePsOutput(""), []);
});

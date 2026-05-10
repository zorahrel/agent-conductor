import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, flagString, flagBool, flagInt } from "./args.js";

test("parseArgs: positional only", () => {
  const r = parseArgs(["sub", "a", "b"]);
  assert.deepEqual(r._, ["sub", "a", "b"]);
  assert.deepEqual(r.flags, {});
});

test("parseArgs: long flag with =value", () => {
  const r = parseArgs(["--text=y"]);
  assert.equal(r.flags.text, "y");
});

test("parseArgs: long flag with space value", () => {
  const r = parseArgs(["--pid", "1234"]);
  assert.equal(r.flags.pid, "1234");
});

test("parseArgs: long flag boolean", () => {
  const r = parseArgs(["--force"]);
  assert.equal(r.flags.force, true);
});

test("parseArgs: short flag with space value", () => {
  const r = parseArgs(["-p", "42"]);
  assert.equal(r.flags.p, "42");
});

test("parseArgs: short flag inline (-fvalue)", () => {
  const r = parseArgs(["-l5"]);
  assert.equal(r.flags.l, "5");
});

test("parseArgs: -- ends option parsing", () => {
  const r = parseArgs(["--pid", "1", "--", "--literal-flag", "x"]);
  assert.equal(r.flags.pid, "1");
  assert.deepEqual(r._, ["--literal-flag", "x"]);
});

test("parseArgs: repeated flags become arrays", () => {
  const r = parseArgs(["--tag", "a", "--tag", "b", "--tag", "c"]);
  assert.deepEqual(r.flags.tag, ["a", "b", "c"]);
});

test("flagString: returns first matching alias", () => {
  const r = parseArgs(["--list", "Personal"]);
  assert.equal(flagString(r, "l", "list"), "Personal");
});

test("flagBool: missing → false, present → true", () => {
  const r = parseArgs(["--force"]);
  assert.equal(flagBool(r, "force"), true);
  assert.equal(flagBool(r, "missing"), false);
});

test("flagInt: parses or returns undefined", () => {
  const r = parseArgs(["--limit", "5", "--bad", "abc"]);
  assert.equal(flagInt(r, "limit"), 5);
  assert.equal(flagInt(r, "bad"), undefined);
  assert.equal(flagInt(r, "missing"), undefined);
});

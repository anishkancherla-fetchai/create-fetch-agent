import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  normalizeType,
  normalizeManager,
  parseAiTargets,
  flagsToOverrides,
  isSkillsOnly,
} from "../src/args.js";

test("parseArgs splits positionals and flags", () => {
  const { positionals, flags } = parseArgs([
    "my-bot",
    "--type",
    "payment",
    "--ai=cursor,claude",
    "--no-install",
    "-y",
  ]);
  assert.deepEqual(positionals, ["my-bot"]);
  assert.equal(flags.type, "payment");
  assert.equal(flags.ai, "cursor,claude");
  assert.equal(flags["no-install"], true);
  assert.equal(flags.yes, true);
});

test("parseArgs treats -h as help and -- as positional terminator", () => {
  assert.equal(parseArgs(["-h"]).flags.help, true);
  const { positionals } = parseArgs(["--", "--not-a-flag"]);
  assert.deepEqual(positionals, ["--not-a-flag"]);
});

test("parseArgs only consumes a value for known value-flags", () => {
  // --skills-only is boolean; the following positional must NOT be swallowed.
  const { positionals, flags } = parseArgs(["--skills-only", "somedir"]);
  assert.equal(flags["skills-only"], true);
  assert.deepEqual(positionals, ["somedir"]);
});

test("normalizeType accepts aliases and rejects junk", () => {
  assert.equal(normalizeType("payment"), "payment_agent");
  assert.equal(normalizeType("multi"), "multi_agent");
  assert.equal(normalizeType("chat_agent"), "chat_agent");
  assert.throws(() => normalizeType("nonsense"));
});

test("normalizeManager accepts aliases and rejects junk", () => {
  assert.equal(normalizeManager("uv"), "uv");
  assert.equal(normalizeManager("venv"), "pip");
  assert.throws(() => normalizeManager("conda"));
});

test("parseAiTargets parses lists, dedupes, and handles none", () => {
  assert.deepEqual(parseAiTargets("cursor,claude"), ["cursor", "claude"]);
  assert.deepEqual(parseAiTargets("cursor,cursor"), ["cursor"]);
  assert.deepEqual(parseAiTargets("none"), []);
  assert.deepEqual(parseAiTargets(""), []);
  assert.deepEqual(parseAiTargets("agents.md"), ["agents"]);
  assert.throws(() => parseAiTargets("copilot"));
});

test("flagsToOverrides only sets keys that were passed", () => {
  assert.deepEqual(flagsToOverrides({}), {});
  assert.deepEqual(
    flagsToOverrides({ type: "single", python: "poetry", ai: "none", "no-install": true }),
    { buildType: "single_agent", pythonManager: "poetry", aiTargets: [], installNow: false },
  );
});

test("flagsToOverrides ignores value-flags passed without a value", () => {
  // `--type` with no value shows up as boolean true; don't crash on it.
  assert.deepEqual(flagsToOverrides({ type: true }), {});
});

test("isSkillsOnly detects both aliases", () => {
  assert.equal(isSkillsOnly({ "skills-only": true }), true);
  assert.equal(isSkillsOnly({ "add-skills": true }), true);
  assert.equal(isSkillsOnly({}), false);
});

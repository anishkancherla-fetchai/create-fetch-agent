import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  runWizard,
  validateProjectName,
  normalizeWorkerName,
} from "../src/wizard.js";
import { makePrompts, silentLogger, tmpDir } from "./helpers.js";

test("validateProjectName rejects spaces and path separators", () => {
  assert.equal(validateProjectName("my app"), "Project name cannot contain spaces.");
  assert.equal(typeof validateProjectName("a/b"), "string");
  assert.equal(validateProjectName("my-app", tmpDir()), true);
});

test("validateProjectName rejects existing non-empty dir", () => {
  const dir = tmpDir();
  fs.mkdirSync(`${dir}/taken`);
  fs.writeFileSync(`${dir}/taken/file.txt`, "x");
  const result = validateProjectName("taken", dir);
  assert.match(result, /already exists/);
});

test("normalizeWorkerName produces identifier-safe names", () => {
  assert.equal(normalizeWorkerName("Alice"), "alice");
  assert.equal(normalizeWorkerName("My Worker!"), "my_worker");
  assert.equal(normalizeWorkerName("123go"), "w_123go");
});

test("wizard collects orchestrator answers headlessly", async () => {
  const prompts = makePrompts({
    input: ["alice", "bob"], // worker names (project name comes from argv)
    select: ["orchestrator_workers", "uv", false], // buildType, python, register
    number: [2],
    checkbox: [["cursor", "agents"]],
    confirm: [true],
  });

  const answers = await runWizard({
    argv: ["my-app"],
    prompts,
    logger: silentLogger,
    cwd: tmpDir(),
  });

  assert.equal(answers.projectName, "my-app");
  assert.equal(answers.buildType, "orchestrator_workers");
  assert.deepEqual(answers.workers, ["alice", "bob"]);
  assert.equal(answers.pythonManager, "uv");
  assert.deepEqual(answers.aiTargets, ["cursor", "agents"]);
  assert.equal(answers.registerNow, false);
  assert.equal(answers.installNow, true);
});

test("wizard collects single-agent answers and skips worker prompts", async () => {
  const prompts = makePrompts({
    input: ["cool-agent"], // project name (no argv)
    select: ["single_agent", "poetry", true],
    checkbox: [[]],
    confirm: [false],
  });

  const answers = await runWizard({
    argv: [],
    prompts,
    logger: silentLogger,
    cwd: tmpDir(),
  });

  assert.equal(answers.projectName, "cool-agent");
  assert.equal(answers.buildType, "single_agent");
  assert.deepEqual(answers.workers, []);
  assert.equal(answers.pythonManager, "poetry");
  assert.deepEqual(answers.aiTargets, []);
  assert.equal(answers.registerNow, true);
  assert.equal(answers.installNow, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { scaffold, toAgentName } from "../src/scaffold.js";
import { makeSeedFn, tmpDir } from "./helpers.js";

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}
function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}

test("scaffold orchestrator+workers writes the full tree", async () => {
  const cwd = tmpDir();
  const answers = {
    projectName: "my-app",
    buildType: "orchestrator_workers",
    workers: ["alice", "bob"],
    pythonManager: "uv",
    aiTargets: [],
    registerNow: false,
    installNow: false,
  };
  const { targetDir, written } = await scaffold(answers, { cwd, seedFn: makeSeedFn() });

  // Static files copied.
  for (const f of [
    "agents/__init__.py",
    "agents/models/__init__.py",
    "agents/models/models.py",
    "agents/services/__init__.py",
    "agents/services/state_service.py",
    "agents/orchestrator/__init__.py",
    "requirements.txt",
    ".gitignore",
  ]) {
    assert.ok(exists(targetDir, f), `missing static file ${f}`);
  }

  // Generated files.
  for (const f of [
    "agents/models/config.py",
    "agents/orchestrator/orchestrator_agent.py",
    "agents/orchestrator/chat_protocol.py",
    "agents/alice/__init__.py",
    "agents/alice/alice_agent.py",
    "agents/bob/__init__.py",
    "agents/bob/bob_agent.py",
    ".env",
    ".env.example",
    "Makefile",
    "README.md",
  ]) {
    assert.ok(exists(targetDir, f), `missing generated file ${f}`);
  }

  // No poetry file for uv.
  assert.ok(!exists(targetDir, "pyproject.toml"));

  // .env seeds match config agents.
  const env = read(targetDir, ".env");
  assert.match(env, /ORCHESTRATOR_SEED_PHRASE=seed-0/);
  assert.match(env, /ALICE_SEED_PHRASE=seed-1/);
  assert.match(env, /BOB_SEED_PHRASE=seed-2/);

  // Routing branches present.
  const chat = read(targetDir, "agents/orchestrator/chat_protocol.py");
  assert.match(chat, /if "alice" in text_lower:/);
  assert.match(chat, /if "bob" in text_lower:/);

  // Makefile targets.
  const mk = read(targetDir, "Makefile");
  assert.match(mk, /orchestrator:/);
  assert.match(mk, /alice:/);
  assert.match(mk, /bob:/);

  // Ports deterministic in worker files.
  assert.match(read(targetDir, "agents/alice/alice_agent.py"), /port=8001/);
  assert.match(read(targetDir, "agents/bob/bob_agent.py"), /port=8002/);

  assert.ok(written.length > 10);
});

test("scaffold respects custom worker count, names and port skipping", async () => {
  const cwd = tmpDir();
  const answers = {
    projectName: "three",
    buildType: "orchestrator_workers",
    workers: ["red", "green", "blue"],
    pythonManager: "pip",
    aiTargets: [],
    registerNow: false,
    installNow: false,
  };
  const { targetDir } = await scaffold(answers, { cwd, seedFn: makeSeedFn() });

  assert.match(read(targetDir, "agents/red/red_agent.py"), /port=8001/);
  assert.match(read(targetDir, "agents/green/green_agent.py"), /port=8002/);
  // 8003 reserved for orchestrator -> blue gets 8004.
  assert.match(read(targetDir, "agents/blue/blue_agent.py"), /port=8004/);

  const config = read(targetDir, "agents/models/config.py");
  for (const n of ["RED", "GREEN", "BLUE"]) {
    assert.match(config, new RegExp(`${n}_ADDRESS = Identity.from_seed`));
  }
});

test("scaffold poetry build emits pyproject.toml", async () => {
  const cwd = tmpDir();
  const { targetDir } = await scaffold(
    {
      projectName: "poetry-proj",
      buildType: "orchestrator_workers",
      workers: ["alice"],
      pythonManager: "poetry",
      aiTargets: [],
      registerNow: false,
      installNow: false,
    },
    { cwd, seedFn: makeSeedFn() },
  );
  assert.ok(exists(targetDir, "pyproject.toml"));
  const py = read(targetDir, "pyproject.toml");
  assert.match(py, /\[tool\.poetry\]/);
  assert.match(py, /uagents = "0\.22\.8"/);
  assert.match(py, /python = "\^3\.12"/);
});

test("scaffold single agent writes a flat chat-ready project", async () => {
  const cwd = tmpDir();
  const { targetDir } = await scaffold(
    {
      projectName: "Solo Bot",
      buildType: "single_agent",
      workers: [],
      pythonManager: "uv",
      aiTargets: [],
      registerNow: false,
      installNow: false,
    },
    { cwd, seedFn: makeSeedFn() },
  );

  assert.ok(exists(targetDir, "agent.py"));
  assert.ok(exists(targetDir, "requirements.txt"));
  assert.ok(exists(targetDir, "Makefile"));
  assert.ok(exists(targetDir, ".env"));

  const agent = read(targetDir, "agent.py");
  assert.match(agent, /def agent_workflow\(query: str\)/);
  assert.match(agent, /chat_protocol_spec/);
  assert.match(read(targetDir, ".env"), /AGENT_SEED_PHRASE=seed-0/);
  assert.match(read(targetDir, "Makefile"), /run:\n\tpython agent\.py/);
});

test("toAgentName sanitizes project names", () => {
  assert.equal(toAgentName("Solo Bot"), "solo_bot");
  assert.equal(toAgentName("my-cool-agent"), "my_cool_agent");
  assert.equal(toAgentName("9lives"), "agent_9lives");
});

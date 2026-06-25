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

test("scaffold multi-agent writes independent agents (no orchestrator)", async () => {
  const cwd = tmpDir();
  const answers = {
    projectName: "my-app",
    buildType: "multi_agent",
    workers: ["alice", "bob"],
    pythonManager: "uv",
    aiTargets: [],
    registerNow: false,
    installNow: false,
  };
  const { targetDir, written } = await scaffold(answers, { cwd, seedFn: makeSeedFn() });

  // Independent agent packages.
  for (const f of [
    "agents/__init__.py",
    "agents/alice/__init__.py",
    "agents/alice/alice_agent.py",
    "agents/bob/__init__.py",
    "agents/bob/bob_agent.py",
    ".env",
    ".env.example",
    "Makefile",
    "README.md",
    ".gitignore",
  ]) {
    assert.ok(exists(targetDir, f), `missing file ${f}`);
  }

  // No orchestrator / shared-state plumbing.
  assert.ok(!exists(targetDir, "agents/orchestrator/orchestrator_agent.py"));
  assert.ok(!exists(targetDir, "agents/orchestrator/chat_protocol.py"));
  assert.ok(!exists(targetDir, "agents/models/models.py"));
  assert.ok(!exists(targetDir, "agents/services/state_service.py"));

  // uv build is a real uv project: PEP 621 pyproject + pinned Python, no requirements.txt.
  assert.ok(exists(targetDir, "pyproject.toml"));
  assert.ok(exists(targetDir, ".python-version"));
  assert.ok(!exists(targetDir, "requirements.txt"));
  const pyproject = read(targetDir, "pyproject.toml");
  assert.match(pyproject, /\[project\]/);
  assert.match(pyproject, /package = false/);
  assert.match(read(targetDir, ".python-version"), /3\.12/);

  // One unique seed per agent, no orchestrator seed.
  const env = read(targetDir, ".env");
  assert.match(env, /ALICE_SEED_PHRASE=seed-0/);
  assert.match(env, /BOB_SEED_PHRASE=seed-1/);
  assert.doesNotMatch(env, /ORCHESTRATOR_SEED_PHRASE/);

  // Each agent is a standalone chat agent reading its own seed.
  const alice = read(targetDir, "agents/alice/alice_agent.py");
  assert.match(alice, /seed=os\.getenv\("ALICE_SEED_PHRASE"\)/);
  assert.match(alice, /chat_protocol_spec/);
  assert.doesNotMatch(alice, /SharedAgentState/);

  // Makefile has one target per agent, no orchestrator.
  const mk = read(targetDir, "Makefile");
  assert.match(mk, /alice:/);
  assert.match(mk, /bob:/);
  assert.doesNotMatch(mk, /orchestrator:/);

  // Ports sequential from 8001.
  assert.match(read(targetDir, "agents/alice/alice_agent.py"), /port=8001/);
  assert.match(read(targetDir, "agents/bob/bob_agent.py"), /port=8002/);

  assert.ok(written.length > 8);
});

test("scaffold respects custom agent count, names and sequential ports", async () => {
  const cwd = tmpDir();
  const answers = {
    projectName: "three",
    buildType: "multi_agent",
    workers: ["red", "green", "blue"],
    pythonManager: "pip",
    aiTargets: [],
    registerNow: false,
    installNow: false,
  };
  const { targetDir } = await scaffold(answers, { cwd, seedFn: makeSeedFn() });

  assert.match(read(targetDir, "agents/red/red_agent.py"), /port=8001/);
  assert.match(read(targetDir, "agents/green/green_agent.py"), /port=8002/);
  assert.match(read(targetDir, "agents/blue/blue_agent.py"), /port=8003/);
  // pip build gets requirements.txt.
  assert.ok(exists(targetDir, "requirements.txt"));
});

test("scaffold poetry build emits pyproject.toml", async () => {
  const cwd = tmpDir();
  const { targetDir } = await scaffold(
    {
      projectName: "poetry-proj",
      buildType: "multi_agent",
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
  // uv single agent => pyproject.toml (not requirements.txt).
  assert.ok(exists(targetDir, "pyproject.toml"));
  assert.ok(!exists(targetDir, "requirements.txt"));
  assert.ok(exists(targetDir, "Makefile"));
  assert.ok(exists(targetDir, ".env"));

  const agent = read(targetDir, "agent.py");
  assert.match(agent, /def solo_bot_workflow\(query: str\)/);
  assert.match(agent, /chat_protocol_spec/);
  // Session id is surfaced to the handler.
  assert.match(agent, /session_id = str\(ctx\.session\)/);
  assert.match(read(targetDir, ".env"), /AGENT_SEED_PHRASE=seed-0/);
  assert.match(read(targetDir, "Makefile"), /run:\n\tuv run python agent\.py/);
});

test("scaffold payment agent writes the Stripe + FET file tree", async () => {
  const cwd = tmpDir();
  const { targetDir } = await scaffold(
    {
      projectName: "pay-bot",
      buildType: "payment_agent",
      workers: [],
      pythonManager: "uv",
      aiTargets: [],
      registerNow: false,
      installNow: false,
    },
    { cwd, seedFn: makeSeedFn() },
  );

  // Single-concern file layout (verbatim code + generated env/manifest).
  for (const f of [
    "agent.py",
    "protocols/__init__.py",
    "protocols/chat_proto.py",
    "protocols/payment_proto.py",
    "stripe_payments/__init__.py",
    "stripe_payments/checkout.py",
    "fet_payments/__init__.py",
    "fet_payments/ledger.py",
    ".env",
    ".env.example",
    "Makefile",
    "README.md",
    ".gitignore",
  ]) {
    assert.ok(exists(targetDir, f), `missing file ${f}`);
  }

  // Both protocols are wired and dispatch by payment_method.
  const agent = read(targetDir, "agent.py");
  assert.match(agent, /agent\.include\(chat_proto/);
  assert.match(agent, /agent\.include\(payment_proto/);
  assert.match(agent, /seed=AGENT_SEED/);

  const pay = read(targetDir, "protocols/payment_proto.py");
  assert.match(pay, /payment_protocol_spec, role="seller"/);
  assert.match(pay, /payment_method == "stripe"/);
  assert.match(pay, /payment_method == "fet_direct"/);

  // The Stripe SDK and cosmpy stay isolated to their own modules.
  assert.match(read(targetDir, "stripe_payments/checkout.py"), /import stripe/);
  assert.match(read(targetDir, "fet_payments/ledger.py"), /from cosmpy\.aerial\.client/);

  // Pre-generated seed + Stripe test placeholders in .env.
  const env = read(targetDir, ".env");
  assert.match(env, /AGENT_SEED_PHRASE=seed-0/);
  assert.match(env, /STRIPE_SECRET_KEY=sk_test_/);
  assert.match(env, /ENABLE_FET_PAYMENTS=true/);
  // .env.example has no generated seed.
  assert.match(read(targetDir, ".env.example"), /AGENT_SEED_PHRASE=\n/);

  // uv manifest pins the payment-capable uagents + adds stripe/cosmpy/openai.
  const pyproject = read(targetDir, "pyproject.toml");
  assert.match(pyproject, /uagents==0\.23\.6/);
  assert.match(pyproject, /uagents-core==0\.4\.0/);
  assert.match(pyproject, /"stripe"/);
  assert.match(pyproject, /"cosmpy==0\.11\.1"/);
  assert.match(pyproject, /"openai"/);

  assert.match(read(targetDir, "Makefile"), /run:\n\tuv run python agent\.py/);
});

test("scaffold payment agent (pip) appends extra deps to requirements.txt", async () => {
  const cwd = tmpDir();
  const { targetDir } = await scaffold(
    {
      projectName: "pay-pip",
      buildType: "payment_agent",
      workers: [],
      pythonManager: "pip",
      aiTargets: [],
      registerNow: false,
      installNow: false,
    },
    { cwd, seedFn: makeSeedFn() },
  );
  assert.ok(exists(targetDir, "requirements.txt"));
  assert.ok(!exists(targetDir, "pyproject.toml"));
  const reqs = read(targetDir, "requirements.txt");
  assert.match(reqs, /uagents==0\.23\.6/);
  assert.match(reqs, /stripe/);
  assert.match(reqs, /cosmpy==0\.11\.1/);
  assert.match(reqs, /openai/);
});

test("toAgentName sanitizes project names", () => {
  assert.equal(toAgentName("Solo Bot"), "solo_bot");
  assert.equal(toAgentName("my-cool-agent"), "my_cool_agent");
  assert.equal(toAgentName("9lives"), "agent_9lives");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentPorts,
  pythonInvocation,
  renderChatAgent,
  renderMicroAgent,
  renderMultiAgentMakefile,
  renderMultiAgentEnv,
  renderSingleAgent,
  SINGLE_AGENT_PORT,
  MULTI_AGENT_BASE_PORT,
} from "../src/workers.js";
import { makeSeedFn } from "./helpers.js";

test("agentPorts assigns sequential ports from the base", () => {
  assert.equal(SINGLE_AGENT_PORT, 8000);
  assert.equal(MULTI_AGENT_BASE_PORT, 8001);
  assert.deepEqual(agentPorts(1), [8001]);
  assert.deepEqual(agentPorts(3), [8001, 8002, 8003]);
});

test("pythonInvocation matches the package manager", () => {
  assert.equal(pythonInvocation("uv"), "uv run python");
  assert.equal(pythonInvocation("poetry"), "poetry run python");
  assert.equal(pythonInvocation("pip"), ".venv/bin/python");
});

test("renderChatAgent builds an independent, ASI:One-ready agent", () => {
  const code = renderChatAgent("alice", 8001, { seedEnv: "ALICE_SEED_PHRASE" });
  assert.match(code, /name="alice"/);
  assert.match(code, /seed=os\.getenv\("ALICE_SEED_PHRASE"\)/);
  assert.match(code, /port=8001/);
  assert.match(code, /mailbox=True/);
  assert.match(code, /publish_agent_details=True/);
  assert.match(code, /chat_protocol_spec/);
  assert.match(code, /AGENT_DESCRIPTION = /);
  assert.match(code, /def alice_workflow\(query: str\)/);
  assert.match(code, /session_id = str\(ctx\.session\)/);
  // tz-aware everywhere; no naive datetime.now() calls.
  assert.match(code, /datetime\.now\(tz=timezone\.utc\)/);
  assert.doesNotMatch(code, /datetime\.now\(\)/);
  // No orchestrator/SharedAgentState coupling.
  assert.doesNotMatch(code, /SharedAgentState/);
});

test("renderMicroAgent reads a per-agent seed env var", () => {
  const code = renderMicroAgent("bob", 8002);
  assert.match(code, /seed=os\.getenv\("BOB_SEED_PHRASE"\)/);
  assert.match(code, /port=8002/);
  assert.match(code, /def bob_workflow\(query: str\)/);
});

test("renderSingleAgent uses the single AGENT_SEED_PHRASE", () => {
  const code = renderSingleAgent("solo", SINGLE_AGENT_PORT);
  assert.match(code, /seed=os\.getenv\("AGENT_SEED_PHRASE"\)/);
  assert.match(code, /port=8000/);
});

test("renderMultiAgentMakefile uses manager-correct interpreter, one target per agent", () => {
  const uv = renderMultiAgentMakefile(["alice", "bob"], "uv");
  assert.match(uv, /alice:\n\tuv run python -m agents\.alice\.alice_agent/);
  assert.match(uv, /bob:\n\tuv run python -m agents\.bob\.bob_agent/);
  // No orchestrator target.
  assert.doesNotMatch(uv, /orchestrator:/);

  const pip = renderMultiAgentMakefile(["alice"], "pip");
  assert.match(pip, /alice:\n\t\.venv\/bin\/python -m agents\.alice\.alice_agent/);
  assert.doesNotMatch(pip, /\n\tpython -m/);
});

test("renderMultiAgentEnv writes one unique seed per agent (no orchestrator)", () => {
  const env = renderMultiAgentEnv(["alice", "bob"], makeSeedFn());
  assert.match(env, /ALICE_SEED_PHRASE=seed-0/);
  assert.match(env, /BOB_SEED_PHRASE=seed-1/);
  assert.doesNotMatch(env, /ORCHESTRATOR_SEED_PHRASE/);
});

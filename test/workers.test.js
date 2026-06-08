import { test } from "node:test";
import assert from "node:assert/strict";

import {
  workerPorts,
  renderWorker,
  renderConfig,
  renderChatProtocol,
  renderMakefile,
  renderEnv,
  ORCHESTRATOR_PORT,
} from "../src/workers.js";
import { makeSeedFn } from "./helpers.js";

test("workerPorts skips the orchestrator port (8003)", () => {
  assert.equal(ORCHESTRATOR_PORT, 8003);
  assert.deepEqual(workerPorts(1), [8001]);
  assert.deepEqual(workerPorts(2), [8001, 8002]);
  assert.deepEqual(workerPorts(4), [8001, 8002, 8004, 8005]);
  assert.ok(!workerPorts(6).includes(8003));
});

test("renderWorker injects name, seed, port and a workflow extension point", () => {
  const code = renderWorker("alice", 8001);
  assert.match(code, /from agents\.models\.config import ALICE_SEED/);
  assert.match(code, /seed=ALICE_SEED/);
  assert.match(code, /port=8001/);
  assert.match(code, /def alice_workflow\(state: SharedAgentState\)/);
  assert.match(code, /@alice\.on_message\(SharedAgentState\)/);
});

test("renderConfig declares a seed and address per worker plus orchestrator", () => {
  const code = renderConfig(["alice", "bob"]);
  assert.match(code, /ALICE_SEED = os\.getenv\("ALICE_SEED_PHRASE"\)/);
  assert.match(code, /BOB_SEED = os\.getenv\("BOB_SEED_PHRASE"\)/);
  assert.match(code, /ORCHESTRATOR_SEED = os\.getenv\("ORCHESTRATOR_SEED_PHRASE"\)/);
  assert.match(code, /ALICE_ADDRESS = Identity\.from_seed\(seed=ALICE_SEED, index=0\)\.address/);
  assert.match(code, /BOB_ADDRESS = Identity\.from_seed\(seed=BOB_SEED, index=0\)\.address/);
});

test("renderChatProtocol generates a routing branch per worker and is tz-aware", () => {
  const code = renderChatProtocol(["alice", "bob"]);
  assert.match(code, /from agents\.models\.config import ALICE_ADDRESS, BOB_ADDRESS/);
  assert.match(code, /if "alice" in text_lower:/);
  assert.match(code, /await ctx\.send\(ALICE_ADDRESS, state\)/);
  assert.match(code, /if "bob" in text_lower:/);
  assert.match(code, /await ctx\.send\(BOB_ADDRESS, state\)/);
  // tz-aware everywhere; no naive datetime.now() calls.
  assert.match(code, /datetime\.now\(tz=timezone\.utc\)/);
  assert.doesNotMatch(code, /datetime\.now\(\)/);
});

test("renderMakefile emits orchestrator + per-worker targets with tab recipes", () => {
  const mk = renderMakefile(["alice", "bob"]);
  assert.match(mk, /orchestrator:\n\tpython -m agents\.orchestrator\.orchestrator_agent/);
  assert.match(mk, /alice:\n\tpython -m agents\.alice\.alice_agent/);
  assert.match(mk, /bob:\n\tpython -m agents\.bob\.bob_agent/);
});

test("renderEnv writes one unique seed per agent", () => {
  const env = renderEnv(["alice", "bob"], makeSeedFn());
  assert.match(env, /ORCHESTRATOR_SEED_PHRASE=seed-0/);
  assert.match(env, /ALICE_SEED_PHRASE=seed-1/);
  assert.match(env, /BOB_SEED_PHRASE=seed-2/);
});

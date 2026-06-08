import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";

import { scaffold } from "../src/scaffold.js";
import { ORCHESTRATOR_PORT } from "../src/workers.js";
import { makeSeedFn } from "./helpers.js";

// Gated: needs Python + dependency install + a live agent process. Enable with
// CFA_SMOKE=1. Skipped by default so CI without Python stays green.
const ENABLED = process.env.CFA_SMOKE === "1";

test(
  "orchestrator boots and /health returns ok healthy",
  { skip: !ENABLED, timeout: 180_000 },
  async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-smoke-"));
    const { targetDir } = await scaffold(
      {
        projectName: "smoke-app",
        buildType: "orchestrator_workers",
        workers: ["alice"],
        pythonManager: "pip",
        aiTargets: [],
        registerNow: false,
        installNow: false,
      },
      { cwd, seedFn: makeSeedFn() },
    );

    execFileSync("python3.12", ["-m", "venv", ".venv"], { cwd: targetDir });
    execFileSync(".venv/bin/pip", ["install", "-r", "requirements.txt"], {
      cwd: targetDir,
      stdio: "ignore",
    });

    const proc = spawn(".venv/bin/python", ["-m", "agents.orchestrator.orchestrator_agent"], {
      cwd: targetDir,
    });

    try {
      const body = await pollHealth(`http://localhost:${ORCHESTRATOR_PORT}/health`, 60_000);
      assert.match(body, /ok healthy/);
    } finally {
      proc.kill("SIGTERM");
    }
  },
);

async function pollHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`health never came up: ${lastErr && lastErr.message}`);
}

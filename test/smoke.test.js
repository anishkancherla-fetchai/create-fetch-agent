import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";

import { scaffold } from "../src/scaffold.js";
import { makeSeedFn } from "./helpers.js";

// Gated: needs Python + dependency install + a live agent process. Enable with
// CFA_SMOKE=1. Skipped by default so CI without Python stays green.
const ENABLED = process.env.CFA_SMOKE === "1";

test(
  "a generated agent boots and logs its address",
  { skip: !ENABLED, timeout: 180_000 },
  async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cfa-smoke-"));
    const { targetDir } = await scaffold(
      {
        projectName: "smoke-app",
        buildType: "multi_agent",
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

    const proc = spawn(".venv/bin/python", ["-m", "agents.alice.alice_agent"], {
      cwd: targetDir,
    });

    try {
      const log = await waitForLog(proc, /alice started with address/, 60_000);
      assert.match(log, /alice started with address/);
    } finally {
      proc.kill("SIGTERM");
    }
  },
);

function waitForLog(proc, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`log never matched: ${buf.slice(-500)}`)), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (pattern.test(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

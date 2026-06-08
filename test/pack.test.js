import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Gated: `npm pack` shells out and is slower than unit tests. Enable with
// CFA_PACK=1 to verify the *published* file set (catches missing `files`
// entries that `npm link` would hide).
const ENABLED = process.env.CFA_PACK === "1";

test("npm pack ships bin, src and templates", { skip: !ENABLED }, () => {
  const out = tmp("cfa-pack-");
  const json = execFileSync("npm", ["pack", "--json", "--pack-destination", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const meta = JSON.parse(json)[0];
  const tarball = path.join(out, meta.filename);
  assert.ok(fs.existsSync(tarball), "tarball not created");

  const extract = tmp("cfa-extract-");
  execFileSync("tar", ["-xzf", tarball, "-C", extract]);
  const pkgDir = path.join(extract, "package");

  for (const f of [
    "bin/cli.js",
    "src/wizard.js",
    "src/scaffold.js",
    "src/workers.js",
    "src/skills.js",
    "src/env.js",
    "src/seeds.js",
    "src/agentverse.js",
    "templates/orchestrator-workers/agents/models/models.py",
    "templates/orchestrator-workers/requirements.txt",
    "templates/single-agent/requirements.txt",
    "templates/gitignore",
  ]) {
    assert.ok(fs.existsSync(path.join(pkgDir, f)), `tarball missing ${f}`);
  }
});

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

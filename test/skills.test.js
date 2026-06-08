import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  selectedSkillNames,
  expectedSkillPaths,
  installSkills,
} from "../src/skills.js";
import { silentLogger, tmpDir } from "./helpers.js";

test("selectedSkillNames maps manager + build type to skills", () => {
  assert.deepEqual(
    selectedSkillNames({ pythonManager: "uv", buildType: "orchestrator_workers" }),
    ["uv-package", "chat-protocol"],
  );
  assert.deepEqual(
    selectedSkillNames({ pythonManager: "poetry", buildType: "chat_agent" }),
    ["poetry-package", "chat-protocol"],
  );
  assert.deepEqual(
    selectedSkillNames({ pythonManager: "pip", buildType: "single_agent" }),
    ["python-venv-package"],
  );
  assert.deepEqual(
    selectedSkillNames({ pythonManager: "uv", buildType: "payment_agent" }),
    ["uv-package", "payment-protocol", "fet-payment-protocol", "stripe-payment-protocol"],
  );
});

test("expectedSkillPaths uses real fetch-skills locations (not .cursor/rules)", () => {
  const paths = expectedSkillPaths({
    pythonManager: "uv",
    buildType: "orchestrator_workers",
    aiTargets: ["cursor", "claude", "antigravity", "agents"],
  });
  assert.ok(paths.includes(".cursor/skills/uv-package/SKILL.md"));
  assert.ok(paths.includes(".claude/skills/chat-protocol/SKILL.md"));
  assert.ok(paths.includes(".agent/skills/uv-package/SKILL.md"));
  assert.ok(paths.includes("AGENTS.md"));
  assert.ok(!paths.some((p) => p.includes(".cursor/rules")));
});

test("installSkills writes SKILL.md files and AGENTS.md to disk", async () => {
  const targetRoot = tmpDir();
  const answers = {
    pythonManager: "uv",
    buildType: "orchestrator_workers",
    aiTargets: ["cursor", "agents"],
  };
  const { paths } = await installSkills(answers, { targetRoot, logger: silentLogger });

  assert.ok(fs.existsSync(path.join(targetRoot, ".cursor/skills/uv-package/SKILL.md")));
  assert.ok(fs.existsSync(path.join(targetRoot, ".cursor/skills/chat-protocol/SKILL.md")));
  assert.ok(fs.existsSync(path.join(targetRoot, "AGENTS.md")));
  assert.ok(paths.length >= 3);
});

test("installSkills with no targets is a no-op", async () => {
  const targetRoot = tmpDir();
  const { paths } = await installSkills(
    { pythonManager: "uv", buildType: "single_agent", aiTargets: [] },
    { targetRoot, logger: silentLogger },
  );
  assert.deepEqual(paths, []);
  assert.deepEqual(fs.readdirSync(targetRoot), []);
});

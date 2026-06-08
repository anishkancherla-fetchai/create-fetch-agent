import {
  getAvailableSkills,
  partitionSkills,
  installSkillToCopyTarget,
  installAgentsMd,
  createSummary,
} from "fetch-skills/bin/install.js";

const PACKAGE_SKILL_BY_MANAGER = {
  uv: "uv-package",
  poetry: "poetry-package",
  pip: "python-venv-package",
};

const COPY_TARGET_DIRS = {
  cursor: ".cursor/skills",
  claude: ".claude/skills",
  antigravity: ".agent/skills",
};

// Auto-confirm stub: a freshly scaffolded project has no pre-existing skill
// files, but this guarantees we never block on a prompt in non-interactive runs.
const autoPrompts = { confirm: async () => true };

/**
 * Resolve the fetch-skills skill names implied by the wizard answers.
 *
 * @returns {string[]} skill names (package skill first, then protocol skills)
 */
export function selectedSkillNames(answers) {
  const names = [];
  const pkg = PACKAGE_SKILL_BY_MANAGER[answers.pythonManager];
  if (pkg) names.push(pkg);

  if (answers.buildType === "chat_agent" || answers.buildType === "orchestrator_workers") {
    names.push("chat-protocol");
  } else if (answers.buildType === "payment_agent") {
    names.push("payment-protocol", "fet-payment-protocol", "stripe-payment-protocol");
  }

  return names;
}

/**
 * Compute the paths fetch-skills will write for the chosen targets + skills,
 * so the CLI's final summary shows the real locations (NOT .cursor/rules/).
 */
export function expectedSkillPaths(answers) {
  const skillNames = selectedSkillNames(answers);
  const paths = [];
  for (const target of answers.aiTargets || []) {
    if (target === "agents") {
      paths.push("AGENTS.md");
    } else if (COPY_TARGET_DIRS[target]) {
      for (const name of skillNames) {
        paths.push(`${COPY_TARGET_DIRS[target]}/${name}/SKILL.md`);
      }
    }
  }
  return paths;
}

/**
 * Install the selected fetch-skills context into the generated project.
 *
 * Calls the fetch-skills install functions directly with the pre-collected
 * answers (no re-prompting, no shelling out to `npx fetch-skills`).
 *
 * @returns {Promise<{summary: object, paths: string[]}>}
 */
export async function installSkills(answers, { targetRoot, logger = console } = {}) {
  const targets = answers.aiTargets || [];
  const summary = createSummary();

  if (targets.length === 0 || (targets.length === 1 && targets[0] === "none")) {
    return { summary, paths: [] };
  }

  const wantedNames = new Set(selectedSkillNames(answers));
  const available = await getAvailableSkills();
  const skills = available.filter((s) => wantedNames.has(s.name));

  // Keep partition import meaningful (and surface package vs protocol if needed).
  partitionSkills(skills);

  if (skills.length === 0) {
    return { summary, paths: [] };
  }

  for (const target of targets) {
    if (target === "none") continue;
    if (target === "agents") {
      await installAgentsMd({
        skills,
        targetRoot,
        summary,
        prompts: autoPrompts,
        logger,
      });
    } else if (COPY_TARGET_DIRS[target]) {
      for (const skill of skills) {
        await installSkillToCopyTarget({
          target,
          skill,
          targetRoot,
          summary,
          prompts: autoPrompts,
          logger,
        });
      }
    }
  }

  return { summary, paths: expectedSkillPaths(answers) };
}

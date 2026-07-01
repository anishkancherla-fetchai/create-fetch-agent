#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import chalk from "chalk";

import { runWizard, defaultPrompts } from "../src/wizard.js";
import { scaffold } from "../src/scaffold.js";
import { installSkills } from "../src/skills.js";
import { bootstrap, manualInstallCommands } from "../src/env.js";
import { printAgentverseGuidance } from "../src/agentverse.js";
import {
  parseArgs,
  flagsToOverrides,
  parseAiTargets,
  normalizeType,
  normalizeManager,
  isSkillsOnly,
} from "../src/args.js";

function printBanner(logger) {
  logger.log("");
  logger.log(chalk.bold.hex("#1A6FE8")("  create-fetch-agent"));
  logger.log(chalk.dim("  Scaffold a runnable Fetch.ai uAgents project."));
  logger.log("");
}

function printHelp(logger) {
  printBanner(logger);
  logger.log(chalk.bold("Usage:"));
  logger.log("  npx create-fetch-agent [name] [options]");
  logger.log("");
  logger.log(chalk.bold("Options:"));
  logger.log("  --type <t>        single | chat | multi | payment");
  logger.log("  --agents <list>   multi only: agent names, e.g. alice,bob");
  logger.log("  --count <n>       multi only: N agents with default names");
  logger.log("  --python <m>      uv | poetry | pip");
  logger.log("  --ai <list>       cursor,claude,antigravity,agents (or none)");
  logger.log("  --no-install      skip installing Python dependencies");
  logger.log("  --no-register     skip the Agentverse registration prompt");
  logger.log("  --skills-only     add AI-editor context to an EXISTING project");
  logger.log("                    (no scaffolding; runs in the target dir / cwd)");
  logger.log("  -h, --help        show this help");
  logger.log("");
  logger.log(chalk.bold("Examples:"));
  logger.log(chalk.dim("  # fully interactive"));
  logger.log("  npx create-fetch-agent");
  logger.log(chalk.dim("  # non-interactive scaffold"));
  logger.log("  npx create-fetch-agent my-bot --type payment --python uv --ai cursor --no-install");
  logger.log(chalk.dim("  # just add Cursor + Claude context to the current project"));
  logger.log("  npx create-fetch-agent --skills-only --ai cursor,claude");
  logger.log("");
}

function printNextSteps(logger, { answers, targetDir, skillPaths }) {
  const rel = path.relative(process.cwd(), targetDir) || ".";

  logger.log("");
  logger.log(chalk.bold.green("✔ Project ready: ") + chalk.cyan(rel));
  logger.log("");
  logger.log(chalk.bold("Next steps:"));
  logger.log(`  ${chalk.cyan(`cd ${rel}`)}`);

  if (!answers.installNow) {
    for (const c of manualInstallCommands(answers.pythonManager)) {
      logger.log(`  ${chalk.cyan(c)}`);
    }
  }

  logger.log("");
  if (answers.buildType === "multi_agent") {
    logger.log(chalk.dim("  Start each agent in its own terminal:"));
    for (const n of answers.workers) {
      logger.log(`  ${chalk.cyan(`make ${n}`)}`);
    }
  } else if (answers.buildType === "payment_agent") {
    logger.log(chalk.dim("  No payment keys to configure — FET defaults to testnet. Just run:"));
    logger.log(`  ${chalk.cyan("make run")}`);
    logger.log(chalk.dim("  Then chat with it and pay the FET request from a testnet wallet."));
    logger.log(chalk.dim("  Add your paid logic in run_paid_action() in protocols/chat_proto.py."));
  } else {
    logger.log(`  ${chalk.cyan("make run")}`);
  }

  if (skillPaths && skillPaths.length) {
    logger.log("");
    logger.log(chalk.bold("AI-editor context ") + chalk.dim("(via fetch-skills)") + chalk.bold(" installed at:"));
    for (const p of skillPaths) logger.log(`  ${chalk.cyan(p)}`);
  }

  logger.log("");
}

async function runSkillsOnly({ positionals, flags, logger }) {
  const targetRoot = path.resolve(process.cwd(), positionals[0] || ".");
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    logger.error(chalk.red(`Target directory not found: ${targetRoot}`));
    process.exit(1);
  }

  const rel = path.relative(process.cwd(), targetRoot) || ".";
  logger.log(chalk.bold("Adding AI-editor context ") + chalk.dim(`(via fetch-skills) → ${rel}`));

  let aiTargets;
  if (flags.ai !== undefined && flags.ai !== true) {
    aiTargets = parseAiTargets(flags.ai);
  } else {
    aiTargets = await defaultPrompts.checkbox({
      message: "Add AI-editor context? (Space to select, Enter to confirm)",
      choices: [
        { name: "Cursor", value: "cursor" },
        { name: "Claude Code", value: "claude" },
        { name: "Antigravity", value: "antigravity" },
        { name: "AGENTS.md", value: "agents" },
      ],
      required: false,
    });
  }

  if (!aiTargets || aiTargets.length === 0) {
    logger.log(chalk.dim("No AI targets selected — nothing to install."));
    return;
  }

  // Build type drives which protocol skills get installed; default to the
  // chat-protocol context. `--python` optionally adds the package skill.
  const buildType = flags.type && flags.type !== true ? normalizeType(flags.type) : "chat_agent";
  const pythonManager =
    flags.python && flags.python !== true ? normalizeManager(flags.python) : undefined;

  logger.log(chalk.dim("─".repeat(40)));
  const { paths } = await installSkills(
    { aiTargets, buildType, pythonManager },
    { targetRoot, logger },
  );

  logger.log("");
  if (paths.length) {
    logger.log(chalk.bold.green("✔ AI-editor context installed:"));
    for (const p of paths) logger.log(`  ${chalk.cyan(path.join(rel, p))}`);
  } else {
    logger.log(chalk.yellow("No skills were installed."));
  }
  logger.log("");
}

async function main() {
  const logger = console;
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp(logger);
    return;
  }

  printBanner(logger);

  if (isSkillsOnly(flags)) {
    await runSkillsOnly({ positionals, flags, logger });
    return;
  }

  const overrides = flagsToOverrides(flags);
  const answers = await runWizard({ argv: positionals, overrides, logger });

  const { targetDir } = await scaffold(answers);
  logger.log(chalk.green(`\n✔ Generated project files in ${path.basename(targetDir)}/`));

  let skillPaths = [];
  if (answers.aiTargets && answers.aiTargets.length) {
    logger.log(chalk.bold("\n◆  Installing AI-editor context ") + chalk.dim("(via fetch-skills)"));
    logger.log(chalk.dim("─".repeat(40)));
    const { paths } = await installSkills(answers, { targetRoot: targetDir, logger });
    skillPaths = paths;
  }

  if (answers.installNow) {
    logger.log(chalk.bold("\n◆  Installing dependencies"));
    logger.log(chalk.dim("─".repeat(40)));
    await bootstrap(answers, { cwd: targetDir, logger });
  }

  printAgentverseGuidance(answers, { logger });
  printNextSteps(logger, { answers, targetDir, skillPaths });
}

main().catch((err) => {
  if (err && (err.name === "ExitPromptError" || err.name === "AbortPromptError")) {
    console.log("");
    console.log(chalk.dim("Aborted."));
    process.exit(130);
  }
  console.error("");
  console.error(chalk.red(`create-fetch-agent failed: ${err && err.message ? err.message : err}`));
  process.exit(1);
});

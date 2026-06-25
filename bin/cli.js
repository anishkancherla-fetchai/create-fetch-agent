#!/usr/bin/env node

import path from "node:path";
import chalk from "chalk";

import { runWizard } from "../src/wizard.js";
import { scaffold } from "../src/scaffold.js";
import { installSkills } from "../src/skills.js";
import { bootstrap, manualInstallCommands } from "../src/env.js";
import { printAgentverseGuidance } from "../src/agentverse.js";

function parseArgs(argv) {
  return argv.filter((a) => !a.startsWith("-"));
}

function printBanner(logger) {
  logger.log("");
  logger.log(chalk.bold.hex("#1A6FE8")("  create-fetch-agent"));
  logger.log(chalk.dim("  Scaffold a runnable Fetch.ai uAgents project."));
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
    logger.log(chalk.dim("  Paste your Stripe TEST keys into .env, then start the agent:"));
    logger.log(`  ${chalk.cyan("STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY in .env")}`);
    logger.log(`  ${chalk.cyan("make run")}`);
    logger.log(chalk.dim("  Then chat with it and pay with Stripe test card 4242 4242 4242 4242."));
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

async function main() {
  const logger = console;
  printBanner(logger);

  const positionals = parseArgs(process.argv.slice(2));
  const answers = await runWizard({ argv: positionals, logger });

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

import chalk from "chalk";

/**
 * Print honest Agentverse registration guidance.
 *
 * There is no programmatic registration in v1. The generated agents already set
 * mailbox=True and publish_agent_details=True, so "registration" is the browser
 * inspector + mailbox connect flow. Each agent logs its exact inspector URL on
 * startup; we print the steps and the URL pattern here.
 */
export function printAgentverseGuidance(answers, { logger = console } = {}) {
  const isMulti = answers.buildType === "multi_agent";
  const now = answers.registerNow;

  logger.log("");
  logger.log(chalk.bold.cyan("◆  Register on Agentverse"));
  logger.log(chalk.dim("─".repeat(40)));

  if (now) {
    logger.log("Let's connect your agent(s) to Agentverse now.");
  } else {
    logger.log("When you're ready to connect your agent(s) to Agentverse:");
  }
  logger.log("");

  const steps = [
    "Sign in at https://agentverse.ai (and https://asi1.ai to chat via ASI:One).",
    "Start your agent(s) — each logs its Agentverse inspector URL on startup.",
    isMulti
      ? "Open EACH agent's inspector URL in the browser (one per agent)."
      : "Open the inspector URL in the browser.",
    'Click "Connect", then choose "Mailbox".',
    isMulti
      ? "On each agent's profile, add a clear description + keywords — ASI:One uses these to route to it."
      : 'Click "Go to Agent Profile" → "Chat with Agent".',
  ];

  steps.forEach((s, i) => logger.log(`  ${chalk.cyan(`${i + 1}.`)} ${s}`));

  logger.log("");
  logger.log(chalk.bold("  ✅ Chat protocol: already wired for you."));
  logger.log(
    chalk.dim(
      "  Chat only works if the agent publishes the chat protocol manifest — this is the",
    ),
  );
  logger.log(
    chalk.dim(
      "  #1 thing builders forget. Your generated agent(s) already do it: look for",
    ),
  );
  logger.log(
    chalk.dim(
      '  `publish_manifest=True` in the code and "Manifest published successfully:',
    ),
  );
  logger.log(
    chalk.dim(
      '  AgentChatProtocol" in the startup logs. (So Agentverse\'s "Add Chat Protocol"',
    ),
  );
  logger.log(chalk.dim("  checklist item is done — connecting the mailbox alone is NOT enough.)"));

  logger.log("");
  logger.log(chalk.dim("  Inspector URL pattern (the agent logs the exact one):"));
  logger.log(
    chalk.dim(
      "  https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A<PORT>&address=<AGENT_ADDRESS>",
    ),
  );

  if (isMulti) {
    logger.log("");
    logger.log(
      chalk.dim(
        "  Tip: there's no orchestrator — ASI:One discovers your agents and routes to whichever",
      ),
    );
    logger.log(
      chalk.dim(
        "  best matches each request, based on the description on its Agentverse profile.",
      ),
    );
  }

  logger.log("");
  logger.log(
    chalk.dim(
      "  Programmatic registration (AGENTVERSE_API_KEY) is documented future work, not v1.",
    ),
  );
}

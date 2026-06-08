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
  const isOrchestrator = answers.buildType === "orchestrator_workers";
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
    isOrchestrator
      ? "Open EACH agent's inspector URL in the browser (one per agent)."
      : "Open the inspector URL in the browser.",
    'Click "Connect", then choose "Mailbox".',
    isOrchestrator
      ? 'On the ORCHESTRATOR inspector, click "Go to Agent Profile" → "Chat with Agent".'
      : 'Click "Go to Agent Profile" → "Chat with Agent".',
  ];

  steps.forEach((s, i) => logger.log(`  ${chalk.cyan(`${i + 1}.`)} ${s}`));

  logger.log("");
  logger.log(chalk.dim("  Inspector URL pattern (the agent logs the exact one):"));
  logger.log(
    chalk.dim(
      "  https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A<PORT>&address=<AGENT_ADDRESS>",
    ),
  );

  if (isOrchestrator) {
    logger.log("");
    logger.log(
      chalk.dim(
        "  Tip: only the orchestrator needs ASI:One chat — it routes to the workers.",
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

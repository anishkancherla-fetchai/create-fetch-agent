import { seed } from "./seeds.js";

export const SINGLE_AGENT_PORT = 8000;
export const MULTI_AGENT_BASE_PORT = 8001;

/**
 * Deterministic, sequential port assignment for a set of agents.
 *
 * In the ASI:One-native model every agent is independent (there is no
 * orchestrator that owns a reserved port), so ports are simply 8001, 8002, ...
 *
 * @param {number} count number of agents
 * @returns {number[]} ports, one per agent
 */
export function agentPorts(count) {
  const ports = [];
  for (let i = 0; i < count; i += 1) ports.push(MULTI_AGENT_BASE_PORT + i);
  return ports;
}

/**
 * Resolve how to invoke Python for a given package manager. The Makefile recipe
 * must call the right interpreter directly so `make` works regardless of how the
 * user's shell resolves a bare `python` (e.g. macOS only ships `python3`).
 */
export function pythonInvocation(pythonManager) {
  if (pythonManager === "uv") return "uv run python";
  if (pythonManager === "poetry") return "poetry run python";
  return ".venv/bin/python";
}

/**
 * Render an independent, ASI:One-ready chat agent.
 *
 * Every generated agent (single, or one of many micro-agents) is the same shape:
 * it speaks the Agent Chat Protocol, sets `mailbox=True` + `publish_agent_details
 * =True` so it registers on Agentverse, and exposes ONE workflow function as the
 * extension point. ASI:One discovers and routes to it based on its description —
 * there is no orchestrator agent.
 *
 * @param {string} name python-identifier-safe agent name
 * @param {number} port
 * @param {object} [opts]
 * @param {string} [opts.seedEnv] env var holding the seed phrase
 * @param {string} [opts.role] short hint used in the description placeholder
 */
export function renderChatAgent(name, port, opts = {}) {
  const seedEnv = opts.seedEnv || "AGENT_SEED_PHRASE";
  const role = opts.role || `what ${name} does`;
  return `import os
from datetime import datetime, timezone
from uuid import uuid4

from dotenv import find_dotenv, load_dotenv
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

load_dotenv(find_dotenv())

# ASI:One routes to this agent by matching the user's request against this
# description (plus the README/keywords on its Agentverse profile). Make it a
# specific, one-line summary of ${role} so discovery is accurate.
AGENT_DESCRIPTION = "TODO: one sentence describing ${role} so ASI:One knows when to call ${name}."

${name} = Agent(
    name="${name}",
    seed=os.getenv("${seedEnv}"),
    port=${port},
    mailbox=True,
    publish_agent_details=True,
)

chat_proto = Protocol(spec=chat_protocol_spec)


def ${name}_workflow(query: str) -> str:
    """
    ${name}'s task — the one extension point you own.

    Read the user's query, do the single thing ${name} is an expert at, and
    return a response string. In a real implementation this is where you'd call
    an LLM, run a RAG pipeline, hit an API, or use tools.

    TODO: replace the placeholder below with ${name}'s real logic.
    """
    return f"Hello from ${name}! You said: {query}"


@chat_proto.on_message(ChatMessage)
async def handle_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(
        sender,
        ChatAcknowledgement(
            timestamp=datetime.now(tz=timezone.utc),
            acknowledged_msg_id=msg.msg_id,
        ),
    )

    # ctx.session is the chat session id — stable across a multi-turn conversation
    # with the same user. Use it to key per-conversation memory/state if you need it.
    session_id = str(ctx.session)
    text = " ".join(item.text for item in msg.content if isinstance(item, TextContent))
    ctx.logger.info(f"Received (session={session_id}): {text!r}")

    answer = ${name}_workflow(text)

    await ctx.send(
        sender,
        ChatMessage(
            timestamp=datetime.now(tz=timezone.utc),
            msg_id=uuid4(),
            content=[
                TextContent(type="text", text=answer),
                EndSessionContent(type="end-session"),
            ],
        ),
    )


@chat_proto.on_message(ChatAcknowledgement)
async def handle_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


# ⚠️ REQUIRED for ASI:One / Agentverse chat. This publishes the chat protocol
# manifest on startup — it's what makes ${name} discoverable and chattable. An
# agent WITHOUT this line cannot be chatted with (the #1 reason agents silently
# fail to connect), even after you connect a mailbox in the inspector. Keep it.
${name}.include(chat_proto, publish_manifest=True)


@${name}.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"${name} started with address: {${name}.address}")
    ctx.logger.info("Chat protocol published — ${name} is ASI:One ready (chattable + discoverable).")


if __name__ == "__main__":
    ${name}.run()
`;
}

/**
 * Render a single-agent project's `agent.py`.
 */
export function renderSingleAgent(name, port = SINGLE_AGENT_PORT) {
  return renderChatAgent(name, port, { seedEnv: "AGENT_SEED_PHRASE" });
}

/**
 * Render one micro-agent file in a multi-agent project. Each agent lives in its
 * own package (`agents/<name>/<name>_agent.py`) and reads its own seed.
 */
export function renderMicroAgent(name, port) {
  return renderChatAgent(name, port, { seedEnv: `${name.toUpperCase()}_SEED_PHRASE` });
}

const MULTI_MAKEFILE_HEADER = `# Each target runs one agent in the foreground. Open a separate terminal per
# agent. Every agent is independent (no central router) and ASI:One discovers and
# routes to the right one based on its Agentverse description.
#
#   make <agent>
`;

/**
 * Render the Makefile for a multi-agent project: one target per agent. Recipe
 * lines MUST be tab-indented for GNU make, and call the manager-correct Python.
 */
export function renderMultiAgentMakefile(names, pythonManager) {
  const py = pythonInvocation(pythonManager);
  const targets = names
    .map((n) => `${n}:\n\t${py} -m agents.${n}.${n}_agent\n`)
    .join("\n");
  return `${MULTI_MAKEFILE_HEADER}\n.PHONY: ${names.join(" ")}\n\n${targets}`;
}

/**
 * Render the .env for a multi-agent project: one unique, pre-generated seed per
 * agent, matching the env var each agent reads.
 *
 * @param {string[]} names
 * @param {() => string} seedFn injectable for deterministic tests
 */
export function renderMultiAgentEnv(names, seedFn = seed) {
  const lines = [
    "# Seed phrases are pre-generated and unique per agent.",
    "# Keep this file private — each seed controls an agent's on-network identity.",
    "",
    ...names.map((n) => `${n.toUpperCase()}_SEED_PHRASE=${seedFn()}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Render the .env for a single agent.
 */
export function renderSingleEnv(seedFn = seed) {
  return [
    "# Seed phrase is pre-generated. Keep it private — it controls the agent's",
    "# on-network identity (and therefore its address).",
    "",
    `AGENT_SEED_PHRASE=${seedFn()}`,
    "",
  ].join("\n");
}

/**
 * Render the body of a payment agent's env file (shared by `.env` and
 * `.env.example`). Lists every variable the generated code reads — Stripe
 * is the primary rail (test keys), FET is the on-chain alternative, and the
 * LLM key is optional (the paid action degrades to a placeholder without it).
 *
 * @param {string} seedValue value for AGENT_SEED_PHRASE (generated, or "" for the example)
 */
export function renderPaymentEnvBody(seedValue) {
  return `# --- Agent identity (seed is pre-generated; keep it private) ---
AGENT_SEED_PHRASE=${seedValue}
AGENT_NAME=payment-agent
AGENT_PORT=${SINGLE_AGENT_PORT}
# "testnet" auto-funds the wallet + registers on the testnet Almanac.
# Switch to "mainnet" only for a real production deploy.
AGENT_NETWORK=testnet

# --- Stripe (card) — paste your Stripe TEST keys here ---
# Get them at https://dashboard.stripe.com/test/apikeys
ENABLE_STRIPE_PAYMENTS=true
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
# Optional: pin a pre-created Stripe Price; otherwise an inline price is used.
STRIPE_PRICE_ID=
# Amount charged, in cents. 100 = $1.00, 5000 = $50.00
STRIPE_AMOUNT_CENTS=100
STRIPE_CURRENCY=usd
STRIPE_PRODUCT_NAME=Agent service
STRIPE_SUCCESS_URL=https://agentverse.ai/payment-success

# --- FET on-chain payments (alternative rail; no extra keys needed) ---
ENABLE_FET_PAYMENTS=true
FET_AMOUNT_FET=0.001
# "true" -> stable-testnet (atestfet); "false" -> mainnet (afet)
FET_USE_TESTNET=true

# --- Shared payment UX knobs ---
CHECKOUT_DEADLINE_SECONDS=300

# --- Optional: power the paid action with ASI:One (OpenAI-compatible LLM) ---
# Leave blank to use the built-in placeholder paid action. Set it to route the
# user's prompt to ASI:One after payment. Get a key at https://asi1.ai
ASI_ONE_API_KEY=
ASI_ONE_MODEL=asi1
`;
}

/**
 * Render the payment agent's `.env` with a freshly generated seed.
 */
export function renderPaymentEnv(seedFn = seed) {
  return renderPaymentEnvBody(seedFn());
}

/**
 * Render the Makefile for a single agent.
 */
export function renderSingleMakefile(pythonManager) {
  const py = pythonInvocation(pythonManager);
  return `# Run the agent in the foreground.\n#\n#   make run\n\n.PHONY: run\n\nrun:\n\t${py} agent.py\n`;
}

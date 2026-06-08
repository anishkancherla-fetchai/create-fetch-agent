import { seed } from "./seeds.js";

export const ORCHESTRATOR_PORT = 8003;

/**
 * Deterministic port assignment.
 *
 * The orchestrator always owns 8003. Workers fill 8001, 8002, 8004, 8005, ...
 * (skipping 8003) in order. This keeps ports stable across regenerations.
 *
 * @param {number} count number of workers
 * @returns {number[]} ports, one per worker
 */
export function workerPorts(count) {
  const ports = [];
  let p = 8001;
  while (ports.length < count) {
    if (p !== ORCHESTRATOR_PORT) ports.push(p);
    p += 1;
  }
  return ports;
}

/**
 * Render a single worker agent file. The `<name>_workflow` function is the
 * explicit, pre-marked extension point an AI coding tool (or you) will fill in.
 */
export function renderWorker(name, port) {
  const U = name.toUpperCase();
  return `from agents.models.config import ${U}_SEED
from agents.models.models import SharedAgentState
from uagents import Agent, Context

${name} = Agent(
    name="${name}",
    seed=${U}_SEED,
    port=${port},
    mailbox=True,
    publish_agent_details=True,
)


def ${name}_workflow(state: SharedAgentState) -> SharedAgentState:
    """
    This is ${name}'s specialized workflow — the one extension point you own.

    In a real implementation this is where ${name}'s agentic logic lives:
    LangGraph state machines, LangChain pipelines, RAG retrieval, tool use,
    external API calls — whatever ${name} is an expert at. Read state.query,
    do the work, and write the answer to state.result before returning.

    TODO: replace the placeholder below with ${name}'s real logic.
    """
    state.result = f"Hello from ${name}: {state.query}"
    return state


@${name}.on_message(SharedAgentState)
async def handle_message(ctx: Context, sender: str, state: SharedAgentState):
    ctx.logger.info(f"Received state from orchestrator: query={state.query!r}")
    state = ${name}_workflow(state)
    await ctx.send(sender, state)


if __name__ == "__main__":
    ${name}.run()
`;
}

/**
 * Render agents/models/config.py: seed + derived address per worker, plus the
 * orchestrator seed. Addresses come from seeds via Identity.from_seed, so there
 * are no hardcoded addresses anywhere in the project.
 */
export function renderConfig(workerNames) {
  const seedLines = [
    ...workerNames.map((n) => `${n.toUpperCase()}_SEED = os.getenv("${n.toUpperCase()}_SEED_PHRASE")`),
    `ORCHESTRATOR_SEED = os.getenv("ORCHESTRATOR_SEED_PHRASE")`,
  ].join("\n");

  const addressLines = workerNames
    .map(
      (n) =>
        `${n.toUpperCase()}_ADDRESS = Identity.from_seed(seed=${n.toUpperCase()}_SEED, index=0).address`,
    )
    .join("\n");

  return `import os

from dotenv import find_dotenv, load_dotenv
from uagents_core.identity import Identity

load_dotenv(find_dotenv())

${seedLines}

${addressLines}
`;
}

/**
 * Render agents/orchestrator/chat_protocol.py. Routing branches are generated
 * from the worker name list; everything else (ack, session-keyed state, the
 * fallback) is preserved from the canonical template. All timestamps are
 * timezone-aware.
 */
export function renderChatProtocol(workerNames) {
  const addressImports = workerNames
    .map((n) => `${n.toUpperCase()}_ADDRESS`)
    .join(", ");

  const routing = workerNames
    .map(
      (n) =>
        `    if "${n}" in text_lower:\n        ctx.logger.info("Routing to ${n}")\n        await ctx.send(${n.toUpperCase()}_ADDRESS, state)\n        return`,
    )
    .join("\n\n");

  const nameList = workerNames.join(", ");

  return `from datetime import datetime, timezone
from uuid import uuid4

from agents.models.config import ${addressImports}
from agents.models.models import SharedAgentState
from agents.services.state_service import state_service
from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

chat_proto = Protocol(spec=chat_protocol_spec)


@chat_proto.on_message(ChatMessage)
async def handle_message(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(
        sender,
        ChatAcknowledgement(
            timestamp=datetime.now(tz=timezone.utc),
            acknowledged_msg_id=msg.msg_id,
        ),
    )

    text = " ".join(item.text for item in msg.content if isinstance(item, TextContent))
    ctx.logger.info(f"Received: {text!r}")

    chat_session_id = str(ctx.session)
    state = state_service.get_state(chat_session_id)
    if state is None:
        state = SharedAgentState(
            chat_session_id=chat_session_id,
            query=text,
            user_sender_address=sender,
        )
        state_service.set_state(chat_session_id, state)
    else:
        state.query = text
        state.user_sender_address = sender

    text_lower = text.lower()

${routing}

    # Fallback: no worker name matched the message.
    await ctx.send(
        sender,
        ChatMessage(
            timestamp=datetime.now(tz=timezone.utc),
            msg_id=uuid4(),
            content=[
                TextContent(
                    type="text",
                    text="Mention one of: ${nameList} and I'll route your message to them.",
                ),
                EndSessionContent(type="end-session"),
            ],
        ),
    )


@chat_proto.on_message(ChatAcknowledgement)
async def handle_acknowledgement(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


def generate_orchestrator_response_from_state(state: SharedAgentState) -> str:
    return state.result
`;
}

/**
 * Render agents/orchestrator/orchestrator_agent.py. One orchestrator: the sole
 * ASI:One bridge. It owns the chat protocol, relays worker results back to the
 * user, and exposes /health + /message REST stubs for a custom frontend.
 */
export function renderOrchestratorAgent() {
  return `from datetime import datetime, timezone
from uuid import uuid4

from agents.models.config import ORCHESTRATOR_SEED
from agents.models.models import SharedAgentState
from agents.orchestrator.chat_protocol import (
    chat_proto,
    generate_orchestrator_response_from_state,
)
from uagents import Agent, Context, Model
from uagents_core.contrib.protocols.chat import (
    ChatMessage,
    EndSessionContent,
    TextContent,
)

orchestrator = Agent(
    name="orchestrator",
    seed=ORCHESTRATOR_SEED,
    port=${ORCHESTRATOR_PORT},
    mailbox=True,
    publish_agent_details=True,
)

orchestrator.include(chat_proto, publish_manifest=True)


class HealthResponse(Model):
    status: str


class HttpMessagePost(Model):
    content: str


class HttpMessageResponse(Model):
    echo: str


@orchestrator.on_rest_get("/health", HealthResponse)
async def health(ctx: Context) -> HealthResponse:
    """
    REST health check. Visit http://localhost:${ORCHESTRATOR_PORT}/health

    Add more endpoints with @orchestrator.on_rest_get() /
    @orchestrator.on_rest_post() to build an API for a custom frontend.
    """
    return HealthResponse(status="ok healthy")


@orchestrator.on_rest_post("/message", HttpMessagePost, HttpMessageResponse)
async def message(ctx: Context, req: HttpMessagePost) -> HttpMessageResponse:
    """
    REST endpoint to send a message to the orchestrator from any HTTP client:

        curl -X POST http://localhost:${ORCHESTRATOR_PORT}/message \\
          -H "Content-Type: application/json" \\
          -d '{"content": "Hello, orchestrator!"}'

    Swap the echo for a call into the agent pipeline to get real responses.
    """
    return HttpMessageResponse(echo=req.content)


@orchestrator.on_message(SharedAgentState)
async def handle_agent_response(ctx: Context, sender: str, state: SharedAgentState):
    """
    Receives the completed SharedAgentState back from a worker. The orchestrator
    is the sole bridge between the internal agent flow and ASI:One, so once a
    worker finishes we relay the result straight back to the original user.
    """
    ctx.logger.info(
        f"Received state back from worker: session={state.chat_session_id}, "
        f"result={state.result!r}"
    )
    response = generate_orchestrator_response_from_state(state)
    await ctx.send(
        state.user_sender_address,
        ChatMessage(
            timestamp=datetime.now(tz=timezone.utc),
            msg_id=uuid4(),
            content=[
                TextContent(type="text", text=response),
                EndSessionContent(type="end-session"),
            ],
        ),
    )


if __name__ == "__main__":
    orchestrator.run()
`;
}

const MAKEFILE_HEADER = `# Each target runs one agent in the foreground. Open a separate terminal per
# agent: start the orchestrator first, then each worker.
#
#   make orchestrator
#   make <worker>
#
# The orchestrator is the only ASI:One bridge (port ${ORCHESTRATOR_PORT}). Workers receive
# the shared state, run their workflow, and send it back.
`;

/**
 * Render the Makefile: one target per worker plus `make orchestrator`. Recipe
 * lines MUST be tab-indented for GNU make.
 */
export function renderMakefile(workerNames) {
  const orchestratorTarget = `orchestrator:\n\tpython -m agents.orchestrator.orchestrator_agent\n`;
  const workerTargets = workerNames
    .map((n) => `${n}:\n\tpython -m agents.${n}.${n}_agent\n`)
    .join("\n");

  return `${MAKEFILE_HEADER}\n${orchestratorTarget}\n${workerTargets}`;
}

/**
 * Render the .env contents for the orchestrator+workers project. One unique
 * pre-generated seed phrase per agent, matching the names in config.py.
 *
 * @param {string[]} workerNames
 * @param {() => string} seedFn injectable for deterministic tests
 */
export function renderEnv(workerNames, seedFn = seed) {
  const lines = [
    "# Seed phrases are pre-generated and unique per agent.",
    "# Keep this file private — each seed controls an agent's on-network identity.",
    "",
    `ORCHESTRATOR_SEED_PHRASE=${seedFn()}`,
    ...workerNames.map((n) => `${n.toUpperCase()}_SEED_PHRASE=${seedFn()}`),
    "",
  ];
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Single agent
// ────────────────────────────────────────────────────────────────────────────

export const SINGLE_AGENT_PORT = 8000;

/**
 * Render a self-contained, chat-enabled single agent. It is ASI:One ready out
 * of the box: it speaks the chat protocol, so you can talk to it directly in the
 * Agentverse inspector. `agent_workflow` is the one extension point you own.
 */
export function renderSingleAgent(name, port = SINGLE_AGENT_PORT) {
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

AGENT_SEED = os.getenv("AGENT_SEED_PHRASE")

agent = Agent(
    name="${name}",
    seed=AGENT_SEED,
    port=${port},
    mailbox=True,
    publish_agent_details=True,
)

chat_proto = Protocol(spec=chat_protocol_spec)


def agent_workflow(query: str) -> str:
    """
    Your agent's logic — the one extension point you own.

    Read the user's query and return a response string. In a real implementation
    this is where you'd call an LLM, run a RAG pipeline, hit an API, or use tools.

    TODO: replace the placeholder below with your real logic.
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

    text = " ".join(item.text for item in msg.content if isinstance(item, TextContent))
    ctx.logger.info(f"Received: {text!r}")

    answer = agent_workflow(text)

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


agent.include(chat_proto, publish_manifest=True)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"${name} started with address: {agent.address}")


if __name__ == "__main__":
    agent.run()
`;
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
 * Render the Makefile for a single agent.
 */
export function renderSingleMakefile() {
  return `# Run the agent in the foreground.\n#\n#   make run\n\nrun:\n\tpython agent.py\n`;
}

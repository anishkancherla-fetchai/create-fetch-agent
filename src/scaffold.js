import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

import {
  agentPorts,
  renderMicroAgent,
  renderMultiAgentMakefile,
  renderMultiAgentEnv,
  renderPaymentEnv,
  renderPaymentEnvBody,
  renderSingleAgent,
  renderSingleEnv,
  renderSingleMakefile,
  SINGLE_AGENT_PORT,
} from "./workers.js";
import { renderPyproject, renderUvPyproject, PYTHON_VERSION } from "./env.js";
import { seed } from "./seeds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");

/** Build types that share the single-agent base. */
const SINGLE_BASE_TYPES = new Set(["single_agent", "chat_agent"]);
/** Build types that generate many independent, ASI:One-routed agents. */
const MULTI_AGENT_TYPES = new Set(["multi_agent", "orchestrator_workers"]);

/** Shared dependency source (identical deps across the chat-based build types). */
const REQUIREMENTS_SRC = path.join(TEMPLATES_DIR, "single-agent", "requirements.txt");

/** The payment agent needs newer uagents pins (payment protocol) + extra SDKs. */
const PAYMENT_DIR = path.join(TEMPLATES_DIR, "payment-agent");
const PAYMENT_REQUIREMENTS_SRC = path.join(PAYMENT_DIR, "requirements.txt");
const PAYMENT_EXTRA_DEPS = ["cosmpy==0.11.1", "stripe", "openai"];
/** Code files vended verbatim for the payment agent (relative to PAYMENT_DIR). */
const PAYMENT_CODE_FILES = [
  "agent.py",
  "protocols/__init__.py",
  "protocols/chat_proto.py",
  "protocols/payment_proto.py",
  "stripe_payments/__init__.py",
  "stripe_payments/checkout.py",
  "fet_payments/__init__.py",
  "fet_payments/ledger.py",
];

/**
 * Turn a project name into a python-identifier-safe agent name.
 */
export function toAgentName(raw) {
  const cleaned = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "agent_$1");
  return cleaned || "agent";
}

async function writeFile(targetDir, relPath, contents, written) {
  const dest = path.join(targetDir, relPath);
  await fs.ensureDir(path.dirname(dest));
  await fs.writeFile(dest, contents, "utf8");
  written.push(relPath);
}

async function copyFile(srcAbs, targetDir, relPath, written) {
  const dest = path.join(targetDir, relPath);
  await fs.ensureDir(path.dirname(dest));
  await fs.copy(srcAbs, dest);
  written.push(relPath);
}

/**
 * Write the dependency manifest that matches the chosen package manager, so the
 * generated project is a *real* project for that tool (not a requirements.txt
 * that contradicts the installed package skill):
 *   - uv     -> PEP 621 pyproject.toml + .python-version (managed by `uv sync`)
 *   - poetry -> Poetry pyproject.toml (managed by `poetry install`)
 *   - pip    -> requirements.txt (the classic venv + pip workflow)
 */
async function writeDependencyManifest(answers, { targetDir, written, requirementsSrc = REQUIREMENTS_SRC, extraDeps = [] }) {
  const reqs = await fs.readFile(requirementsSrc, "utf8");
  if (answers.pythonManager === "uv") {
    await writeFile(targetDir, "pyproject.toml", renderUvPyproject(answers.projectName, reqs, extraDeps), written);
    await writeFile(targetDir, ".python-version", `${PYTHON_VERSION}\n`, written);
  } else if (answers.pythonManager === "poetry") {
    await writeFile(targetDir, "pyproject.toml", renderPyproject(answers.projectName, reqs, extraDeps), written);
  } else {
    const extra = extraDeps.length ? `${extraDeps.join("\n")}\n` : "";
    await writeFile(targetDir, "requirements.txt", `${reqs.trimEnd()}\n${extra}`, written);
  }
}

/**
 * Scaffold a project from a wizard answers object.
 *
 * @param {object} answers
 * @param {object} [opts]
 * @param {string} [opts.cwd] directory the project dir is created under
 * @param {() => string} [opts.seedFn] injectable seed generator (tests)
 * @returns {Promise<{targetDir: string, written: string[], buildType: string}>}
 */
export async function scaffold(answers, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const seedFn = opts.seedFn || seed;
  const targetDir = path.resolve(cwd, answers.projectName);
  await fs.ensureDir(targetDir);

  const written = [];

  if (answers.buildType === "payment_agent") {
    await scaffoldPaymentAgent(answers, { targetDir, seedFn, written });
  } else if (MULTI_AGENT_TYPES.has(answers.buildType)) {
    await scaffoldMultiAgent(answers, { targetDir, seedFn, written });
  } else if (SINGLE_BASE_TYPES.has(answers.buildType)) {
    await scaffoldSingleAgent(answers, { targetDir, seedFn, written });
  } else {
    throw new Error(`Unknown build type: ${answers.buildType}`);
  }

  written.sort();
  return { targetDir, written, buildType: answers.buildType };
}

/**
 * Multiple independent, ASI:One-routed agents. There is no orchestrator agent:
 * every agent speaks the chat protocol directly, registers on Agentverse, and
 * ASI:One discovers + routes to whichever fits the user's request.
 */
async function scaffoldMultiAgent(answers, ctx) {
  const { targetDir, seedFn, written } = ctx;
  const names = answers.workers;
  const ports = agentPorts(names.length);

  await copyFile(path.join(TEMPLATES_DIR, "gitignore"), targetDir, ".gitignore", written);
  await writeFile(targetDir, "agents/__init__.py", "", written);

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    await writeFile(targetDir, `agents/${name}/__init__.py`, "", written);
    await writeFile(targetDir, `agents/${name}/${name}_agent.py`, renderMicroAgent(name, ports[i]), written);
  }

  await writeFile(targetDir, ".env", renderMultiAgentEnv(names, seedFn), written);
  await writeFile(targetDir, ".env.example", renderEnvExample(names), written);
  await writeFile(targetDir, "Makefile", renderMultiAgentMakefile(names, answers.pythonManager), written);

  await writeDependencyManifest(answers, { targetDir, written });

  await writeFile(targetDir, "README.md", renderMultiAgentReadme(answers, names, ports), written);
}

async function scaffoldSingleAgent(answers, ctx) {
  const { targetDir, seedFn, written } = ctx;
  const name = toAgentName(answers.projectName);

  await copyFile(path.join(TEMPLATES_DIR, "gitignore"), targetDir, ".gitignore", written);

  await writeFile(targetDir, "agent.py", renderSingleAgent(name, SINGLE_AGENT_PORT), written);
  await writeFile(targetDir, ".env", renderSingleEnv(seedFn), written);
  await writeFile(targetDir, ".env.example", "AGENT_SEED_PHRASE=\n", written);
  await writeFile(targetDir, "Makefile", renderSingleMakefile(answers.pythonManager), written);

  await writeDependencyManifest(answers, { targetDir, written });

  await writeFile(targetDir, "README.md", renderSingleReadme(answers, name), written);
}

/**
 * A pay-to-use agent: speaks the Agent Chat Protocol AND the Agent Payment
 * Protocol, advertising BOTH Stripe (card) and on-chain FET in one
 * RequestPayment. The full request -> commit -> verify -> complete flow is
 * generated; the builder only pastes Stripe test keys and fills in the paid
 * action. Code is vended verbatim from a single-concern file layout.
 */
async function scaffoldPaymentAgent(answers, ctx) {
  const { targetDir, seedFn, written } = ctx;

  await copyFile(path.join(TEMPLATES_DIR, "gitignore"), targetDir, ".gitignore", written);

  for (const rel of PAYMENT_CODE_FILES) {
    await copyFile(path.join(PAYMENT_DIR, rel), targetDir, rel, written);
  }

  await writeFile(targetDir, ".env", renderPaymentEnv(seedFn), written);
  await writeFile(targetDir, ".env.example", renderPaymentEnvBody(""), written);
  await writeFile(targetDir, "Makefile", renderSingleMakefile(answers.pythonManager), written);

  await writeDependencyManifest(answers, {
    targetDir,
    written,
    requirementsSrc: PAYMENT_REQUIREMENTS_SRC,
    extraDeps: PAYMENT_EXTRA_DEPS,
  });

  await writeFile(targetDir, "README.md", renderPaymentReadme(answers), written);
}

function renderEnvExample(names) {
  return [
    "# Set a unique, random seed phrase per agent (no spaces).",
    "# `create-fetch-agent` pre-fills these in .env for you.",
    "",
    ...names.map((n) => `${n.toUpperCase()}_SEED_PHRASE=`),
    "",
  ].join("\n");
}

function runHints(pythonManager) {
  if (pythonManager === "uv") {
    return { install: ["uv sync"] };
  }
  if (pythonManager === "poetry") {
    return { install: [`poetry env use python${PYTHON_VERSION}`, "poetry install"] };
  }
  return {
    install: [`python${PYTHON_VERSION} -m venv .venv`, "source .venv/bin/activate", "pip install -r requirements.txt"],
  };
}

function renderMultiAgentReadme(answers, names, ports) {
  const hints = runHints(answers.pythonManager);
  const installBlock = hints.install.join("\n");
  const rows = names
    .map((n, i) => `| ${n} | ${ports[i]} | \`agents/${n}/${n}_agent.py\` | \`make ${n}\` |`)
    .join("\n");
  const runBlocks = names.map((n) => `\`\`\`bash\nmake ${n}\n\`\`\``).join("\n\n");

  return `# ${answers.projectName}

A Fetch.ai multi-agent project: several **independent** agents, each an expert at
one task. There is **no orchestrator** — every agent speaks the Agent Chat
Protocol and registers on Agentverse, and **ASI:One discovers and routes** each
request to the right agent. Generated with
[create-fetch-agent](https://github.com/anishkancherla-fetchai/create-fetch-agent).

## How routing works

\`\`\`
                 user request
                      │
                      ▼
                  ASI:One   ──discovers + ranks agents on Agentverse──►
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
${names.map((n) => `   ${n}`).join("\n")}
\`\`\`

ASI:One's agentic model searches the Agentverse marketplace and picks the agent
whose description best matches the request. So each agent's **description and
Agentverse profile (README + keywords) is what makes routing work** — fill in the
\`AGENT_DESCRIPTION\` in each agent file with a specific, one-line summary of what
that agent does.

## Agents

| Agent | Port | File | Run |
| ----- | ---- | ---- | --- |
${rows}

## Setup

Seeds are already generated for you in \`.env\`. Install dependencies:

\`\`\`bash
${installBlock}
\`\`\`

## Run

Each agent runs in its own terminal:

${runBlocks}

## Where to add your logic

Each agent has a \`<name>_workflow(query)\` function — the single extension point.
Read the query, do the one thing that agent is an expert at, return a response.
For example, in \`agents/${names[0]}/${names[0]}_agent.py\`:

\`\`\`python
def ${names[0]}_workflow(query: str) -> str:
    return my_llm_or_rag_call(query)
\`\`\`

## Talk to it on ASI:One

Every agent sets \`mailbox=True\` and \`publish_agent_details=True\`, so connect each
one through its Agentverse inspector URL (logged on startup) and give it a clear
description. Then chat on [ASI:One](https://asi1.ai) — its agentic model routes
your request to whichever agent fits. See the "Register on Agentverse" output
from the scaffolder, or the [Agentverse docs](https://agentverse.ai).

> **The chat protocol is already wired** in every agent (\`agent.include(chat_proto,
> publish_manifest=True)\`). This is what makes each agent chattable + discoverable
> — the #1 thing builders forget. You'll see \`Manifest published successfully:
> AgentChatProtocol\` in each agent's startup logs, and Agentverse's "Add Chat
> Protocol" checklist item is already satisfied. Connecting a mailbox alone is
> **not** enough; don't remove the \`publish_manifest=True\` line.
`;
}

function renderPaymentReadme(answers) {
  const hints = runHints(answers.pythonManager);
  const installBlock = hints.install.join("\n");

  return `# ${answers.projectName}

A Fetch.ai **pay-to-use agent**: it speaks the Agent Chat Protocol *and* the
Agent Payment Protocol, so a user must pay before the agent runs its paid
action. It advertises **both Stripe (card) and on-chain FET** in a single
payment request — the user picks one. Generated with
[create-fetch-agent](https://github.com/anishkancherla-fetchai/create-fetch-agent).

## How a payment works

\`\`\`
user chats  ──►  agent sends RequestPayment (Stripe card + FET)
                      │
                      ▼
        Agentverse UI shows embedded Stripe checkout (Approve / Reject)
                      │
       user pays with test card 4242 4242 4242 4242
                      │
                      ▼
   agent verifies payment is "paid"  ──►  CompletePayment  ──►  run_paid_action()
\`\`\`

## Setup

The agent's seed is already generated in \`.env\`. To accept card payments, paste
your **Stripe TEST keys** into \`.env\` (everything else has sensible defaults):

\`\`\`dotenv
STRIPE_SECRET_KEY=sk_test_...        # dashboard.stripe.com/test/apikeys
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_AMOUNT_CENTS=100              # 100 = $1.00, 5000 = $50.00
\`\`\`

Then install dependencies:

\`\`\`bash
${installBlock}
\`\`\`

## Run

\`\`\`bash
make run
\`\`\`

The agent starts on port ${SINGLE_AGENT_PORT} and logs its address + an
Agentverse inspector URL. Connect it through the inspector, then chat with it —
it will reply with a payment request. Pay with Stripe test card
\`4242 4242 4242 4242\` (any future expiry, any CVC) to complete the flow.

## Where to add your logic

The whole payment flow is done. The **one** function you own is
\`run_paid_action(...)\` in \`protocols/chat_proto.py\` — it runs automatically once
a payment is verified. By default it replies with a placeholder (so the flow
works with only Stripe keys); set \`ASI_ONE_API_KEY\` in \`.env\` to route the
prompt to ASI:One instead, or replace the body with your real paid service
(image gen, API call, data lookup, etc.).

## File layout

| File | Concern |
| ---- | ------- |
| \`agent.py\` | entrypoint: load env, create agent, include both protocols |
| \`protocols/chat_proto.py\` | chat handling + \`run_paid_action\` (your logic) |
| \`protocols/payment_proto.py\` | payment dispatch (Stripe + FET), verification |
| \`stripe_payments/checkout.py\` | the only file that touches the Stripe SDK |
| \`fet_payments/ledger.py\` | the only file that touches the FET ledger (cosmpy) |

## Card vs. crypto, or both

Both rails are on by default. Toggle in \`.env\`:

- \`ENABLE_STRIPE_PAYMENTS=false\` → FET-only
- \`ENABLE_FET_PAYMENTS=false\` → Stripe-only

## Going live

Defaults are **test mode**: Stripe test keys + FET stable-testnet. Before a real
deploy, switch to live Stripe keys, set \`FET_USE_TESTNET=false\`, and set
\`AGENT_NETWORK=mainnet\` (then fund the agent wallet yourself).
`;
}

function renderSingleReadme(answers, name) {
  const hints = runHints(answers.pythonManager);
  const installBlock = hints.install.join("\n");
  const runCmd = "make run";
  const typeLabel =
    answers.buildType === "chat_agent"
      ? "chat agent (ASI:One ready)"
      : answers.buildType === "payment_agent"
        ? "payment agent base"
        : "single agent";

  return `# ${answers.projectName}

A Fetch.ai ${typeLabel} built on the uAgents framework. It speaks the chat
protocol, so it's ASI:One ready out of the box. Generated with
[create-fetch-agent](https://github.com/anishkancherla-fetchai/create-fetch-agent).

## Setup

The agent's seed is already generated in \`.env\`. Install dependencies:

\`\`\`bash
${installBlock}
\`\`\`

## Run

\`\`\`bash
${runCmd}
\`\`\`

The agent starts on port ${SINGLE_AGENT_PORT} and logs its address and an
Agentverse inspector URL.

## Where to add your logic

\`agent.py\` has a \`${name}_workflow(query)\` function — the single extension point.
Return the response string for a given user query:

\`\`\`python
def ${name}_workflow(query: str) -> str:
    return my_llm_call(query)
\`\`\`

## Talk to it on ASI:One

\`mailbox=True\` and \`publish_agent_details=True\` are set, so connect \`${name}\`
through the Agentverse inspector and chat with it via ASI:One. The inspector URL
is logged on startup.

> **The chat protocol is already wired** (\`agent.include(chat_proto,
> publish_manifest=True)\`). This is what makes the agent chattable + discoverable
> — the #1 thing builders forget. You'll see \`Manifest published successfully:
> AgentChatProtocol\` in the startup logs, and Agentverse's "Add Chat Protocol"
> checklist item is already satisfied. Connecting a mailbox alone is **not**
> enough; don't remove the \`publish_manifest=True\` line.
`;
}

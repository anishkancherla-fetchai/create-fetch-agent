import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

import {
  workerPorts,
  renderWorker,
  renderConfig,
  renderChatProtocol,
  renderOrchestratorAgent,
  renderMakefile,
  renderEnv,
  renderSingleAgent,
  renderSingleEnv,
  renderSingleMakefile,
  SINGLE_AGENT_PORT,
  ORCHESTRATOR_PORT,
} from "./workers.js";
import { renderPyproject } from "./env.js";
import { seed } from "./seeds.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates");

/** Build types that share the single-agent base. */
const SINGLE_BASE_TYPES = new Set(["single_agent", "chat_agent", "payment_agent"]);

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

  if (answers.buildType === "orchestrator_workers") {
    await scaffoldOrchestratorWorkers(answers, { targetDir, seedFn, written });
  } else if (SINGLE_BASE_TYPES.has(answers.buildType)) {
    await scaffoldSingleAgent(answers, { targetDir, seedFn, written });
  } else {
    throw new Error(`Unknown build type: ${answers.buildType}`);
  }

  written.sort();
  return { targetDir, written, buildType: answers.buildType };
}

async function scaffoldOrchestratorWorkers(answers, ctx) {
  const { targetDir, seedFn, written } = ctx;
  const names = answers.workers;
  const ports = workerPorts(names.length);
  const staticDir = path.join(TEMPLATES_DIR, "orchestrator-workers");

  // Static, copied verbatim.
  await copyFile(path.join(staticDir, "agents/__init__.py"), targetDir, "agents/__init__.py", written);
  await copyFile(path.join(staticDir, "agents/models/__init__.py"), targetDir, "agents/models/__init__.py", written);
  await copyFile(path.join(staticDir, "agents/models/models.py"), targetDir, "agents/models/models.py", written);
  await copyFile(path.join(staticDir, "agents/services/__init__.py"), targetDir, "agents/services/__init__.py", written);
  await copyFile(path.join(staticDir, "agents/services/state_service.py"), targetDir, "agents/services/state_service.py", written);
  await copyFile(path.join(staticDir, "agents/orchestrator/__init__.py"), targetDir, "agents/orchestrator/__init__.py", written);
  await copyFile(path.join(staticDir, "requirements.txt"), targetDir, "requirements.txt", written);
  await copyFile(path.join(TEMPLATES_DIR, "gitignore"), targetDir, ".gitignore", written);

  // Generated (name/count-driven).
  await writeFile(targetDir, "agents/models/config.py", renderConfig(names), written);
  await writeFile(targetDir, "agents/orchestrator/orchestrator_agent.py", renderOrchestratorAgent(), written);
  await writeFile(targetDir, "agents/orchestrator/chat_protocol.py", renderChatProtocol(names), written);

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const port = ports[i];
    await writeFile(targetDir, `agents/${name}/__init__.py`, "", written);
    await writeFile(targetDir, `agents/${name}/${name}_agent.py`, renderWorker(name, port), written);
  }

  await writeFile(targetDir, ".env", renderEnv(names, seedFn), written);
  await writeFile(targetDir, ".env.example", renderEnvExample(names), written);
  await writeFile(targetDir, "Makefile", renderMakefile(names), written);

  if (answers.pythonManager === "poetry") {
    const reqs = await fs.readFile(path.join(staticDir, "requirements.txt"), "utf8");
    await writeFile(targetDir, "pyproject.toml", renderPyproject(answers.projectName, reqs), written);
  }

  await writeFile(targetDir, "README.md", renderOrchestratorReadme(answers, names, ports), written);
}

async function scaffoldSingleAgent(answers, ctx) {
  const { targetDir, seedFn, written } = ctx;
  const name = toAgentName(answers.projectName);
  const staticDir = path.join(TEMPLATES_DIR, "single-agent");

  await copyFile(path.join(staticDir, "requirements.txt"), targetDir, "requirements.txt", written);
  await copyFile(path.join(TEMPLATES_DIR, "gitignore"), targetDir, ".gitignore", written);

  await writeFile(targetDir, "agent.py", renderSingleAgent(name, SINGLE_AGENT_PORT), written);
  await writeFile(targetDir, ".env", renderSingleEnv(seedFn), written);
  await writeFile(targetDir, ".env.example", "AGENT_SEED_PHRASE=\n", written);
  await writeFile(targetDir, "Makefile", renderSingleMakefile(), written);

  if (answers.pythonManager === "poetry") {
    const reqs = await fs.readFile(path.join(staticDir, "requirements.txt"), "utf8");
    await writeFile(targetDir, "pyproject.toml", renderPyproject(answers.projectName, reqs), written);
  }

  await writeFile(targetDir, "README.md", renderSingleReadme(answers, name), written);
}

function renderEnvExample(names) {
  return [
    "# Set a unique, random seed phrase per agent (no spaces).",
    "# `create-fetch-agent` pre-fills these in .env for you.",
    "",
    "ORCHESTRATOR_SEED_PHRASE=",
    ...names.map((n) => `${n.toUpperCase()}_SEED_PHRASE=`),
    "",
  ].join("\n");
}

function runHints(pythonManager) {
  if (pythonManager === "uv") {
    return {
      install: ["uv venv --python 3.12", "uv pip install -r requirements.txt"],
      prefix: "uv run",
    };
  }
  if (pythonManager === "poetry") {
    return {
      install: ["poetry install"],
      prefix: "poetry run",
    };
  }
  return {
    install: ["python3.12 -m venv .venv", "source .venv/bin/activate", "pip install -r requirements.txt"],
    prefix: "",
  };
}

function renderOrchestratorReadme(answers, names, ports) {
  const hints = runHints(answers.pythonManager);
  const installBlock = hints.install.map((c) => c).join("\n");
  const mk = (target) => (hints.prefix ? `${hints.prefix} make ${target}` : `make ${target}`);
  const workerRows = names
    .map((n, i) => `| ${n} | ${ports[i]} | \`agents/${n}/${n}_agent.py\` | \`${mk(n)}\` |`)
    .join("\n");

  return `# ${answers.projectName}

A Fetch.ai multi-agent system: an **orchestrator** (the sole ASI:One bridge) that
routes incoming chat messages to specialized **worker** agents. Generated with
[create-fetch-agent](https://github.com/anishkancherla-fetchai/create-fetch-agent).

## Architecture

\`\`\`
ASI:One / Agentverse
        │  (chat protocol)
        ▼
  orchestrator  (port ${ORCHESTRATOR_PORT})  ──►  routes SharedAgentState by name
        ▲                                   │
        └──────── result ◄──────────────────┘
                                            ▼
                              ${names.join(", ")}
\`\`\`

All agents share one message contract (\`SharedAgentState\` in
\`agents/models/models.py\`). The orchestrator owns the chat protocol and relays
the worker's \`result\` back to the user. State persists per session via
\`InMemoryStateService\` (swap it for Redis/Postgres without touching the pipeline).
Addresses are derived from seeds in \`agents/models/config.py\`, so there are no
hardcoded addresses.

## Agents

| Agent | Port | File | Run |
| ----- | ---- | ---- | --- |
| orchestrator | ${ORCHESTRATOR_PORT} | \`agents/orchestrator/orchestrator_agent.py\` | \`${mk("orchestrator")}\` |
${workerRows}

## Setup

Seeds are already generated for you in \`.env\`. Install dependencies:

\`\`\`bash
${installBlock}
\`\`\`

## Run

Each agent runs in its own terminal. Start the orchestrator first:

\`\`\`bash
${mk("orchestrator")}
\`\`\`

${names.map((n) => `\`\`\`bash\n${mk(n)}\n\`\`\``).join("\n\n")}

## Where to add your logic

Each worker has a \`<name>_workflow(state)\` function — the single extension point.
Read \`state.query\`, do the work, write \`state.result\`. For example, in
\`agents/${names[0]}/${names[0]}_agent.py\`:

\`\`\`python
def ${names[0]}_workflow(state: SharedAgentState) -> SharedAgentState:
    state.result = my_llm_or_rag_call(state.query)
    return state
\`\`\`

## Talk to it on ASI:One

The agents set \`mailbox=True\` and \`publish_agent_details=True\`, so you can
connect them through the Agentverse inspector and chat via ASI:One. See
"Register on Agentverse" output from the scaffolder, or the
[Agentverse docs](https://agentverse.ai). The inspector URL is logged on startup.

## REST hooks (custom frontend)

The orchestrator exposes \`/health\` and \`/message\` on port ${ORCHESTRATOR_PORT}:

\`\`\`bash
curl http://localhost:${ORCHESTRATOR_PORT}/health
curl -X POST http://localhost:${ORCHESTRATOR_PORT}/message -H "Content-Type: application/json" -d '{"content":"hi"}'
\`\`\`
`;
}

function renderSingleReadme(answers, name) {
  const hints = runHints(answers.pythonManager);
  const installBlock = hints.install.join("\n");
  const runCmd = hints.prefix ? `${hints.prefix} make run` : "make run";
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

\`agent.py\` has an \`agent_workflow(query)\` function — the single extension point.
Return the response string for a given user query:

\`\`\`python
def agent_workflow(query: str) -> str:
    return my_llm_call(query)
\`\`\`

## Talk to it on ASI:One

\`mailbox=True\` and \`publish_agent_details=True\` are set, so connect \`${name}\`
through the Agentverse inspector and chat with it via ASI:One. The inspector URL
is logged on startup.
`;
}

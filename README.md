# create-fetch-agent

Scaffold a **runnable Fetch.ai [uAgents](https://uagents.fetch.ai) project** with
one command, then layer in context for your AI coding tool.

```bash
npx create-fetch-agent my-app
# or
npm create fetch-agent@latest my-app
```

The generated project runs immediately — seeds are pre-filled, addresses are
derived from them, ports are assigned, and a `Makefile` starts every agent. The
only things left as `TODO` are the workflow functions where *your* logic goes.

---

## What you get

An interactive wizard asks a few questions and then:

1. **Generates a runnable uAgents project** (single agent, or an orchestrator +
   workers system).
2. **Pre-generates unique seeds** for every agent and wires up addresses + ports.
3. **Installs AI-editor context** (optional) so Cursor / Claude Code / Antigravity
   / `AGENTS.md` know how to extend the project correctly.
4. **Bootstraps the Python environment** (optional) with `uv`, `poetry`, or `pip`.
5. **Prints honest Agentverse guidance** for connecting your agents to ASI:One.

---

## Wizard options

| Prompt | Choices |
| --- | --- |
| **Project name** | directory created under the current folder (or pass it as an argument) |
| **What are you building?** | `Single agent` · `Chat agent (ASI:One ready)` · `Orchestrator + workers` · `Payment agent (FET + Stripe)` |
| **Worker count & names** | only for orchestrator + workers (defaults `alice`, `bob`) |
| **Python setup** | `uv` (default) · `poetry` · `pip + venv` |
| **AI-editor context** | any of `Cursor` · `Claude Code` · `Antigravity` · `AGENTS.md` (or none) |
| **Register on Agentverse** | `Later` · `Yes` (prints inspector steps) |
| **Install dependencies now?** | yes / no |

> **v1 scope:** `Single agent` and `Orchestrator + workers` are fully implemented.
> `Chat agent` builds on the single-agent base (already chat/ASI:One ready) plus
> the `chat-protocol` skill. `Payment agent` builds the single-agent base plus the
> payment skills as context — the full payment code path is documented future
> work, not half-built code.

---

## The two project shapes

### Single agent (`Single agent` / `Chat agent`)

A flat, self-contained, chat-enabled agent that's ASI:One ready out of the box:

```
my-app/
  agent.py          # speaks the chat protocol; agent_workflow(query) is your hook
  .env              # AGENT_SEED_PHRASE (pre-generated)
  requirements.txt
  Makefile          # make run
  README.md
```

### Orchestrator + workers (`Orchestrator + workers`)

A hub-and-spoke system around one shared message contract. The **orchestrator** is
the sole ASI:One bridge: it owns the chat protocol, routes each message to a worker
by name, and relays the worker's result back to the user. **Workers** run a
`<name>_workflow(state)` and send the state back.

```
my-app/
  agents/
    models/
      models.py       # SharedAgentState (the message contract)
      config.py       # <NAME>_SEED + <NAME>_ADDRESS per agent (no hardcoded addresses)
    services/
      state_service.py  # InMemoryStateService (swap for Redis/Postgres)
    orchestrator/
      orchestrator_agent.py  # chat bridge + /health + /message REST stubs
      chat_protocol.py       # routing branches, one per worker
    <worker>/
      <worker>_agent.py      # <worker>_workflow(state) — your extension point
  .env                # one <NAME>_SEED_PHRASE per agent (pre-generated)
  Makefile            # make orchestrator + make <worker>
  requirements.txt
  README.md
```

Ports are deterministic: the orchestrator owns `8003`; workers fill
`8001, 8002, 8004, 8005, …` (skipping `8003`).

---

## The three-layer model

`create-fetch-agent` deliberately separates three concerns:

1. **`create-fetch-agent` (this tool)** — owns project structure, runnable starter
   code, seed generation, dependency install, and Agentverse guidance.
2. **The [`fetch-help`](https://github.com/harvest7777/fetch-help) template** — the
   canonical orchestrator + workers architecture this tool stamps out and
   parameterizes (names, counts, ports, seeds).
3. **[`fetch-skills`](https://www.npmjs.com/package/fetch-skills)** — a context
   installer that writes `SKILL.md` instruction files for AI coding tools. It
   writes *no code*; this tool delegates the "AI-editor context" step to it
   instead of reinventing thousands of lines of skill markdown.

**Design philosophy — hybrid:** emit a *minimal runnable skeleton* (works on the
first run with no AI tool) whose extension points are pre-marked, then install
fetch-skills context so your AI tool can flesh those points out correctly.

### Where AI-editor context lands

| Tool | Path |
| --- | --- |
| Cursor | `.cursor/skills/<skill>/SKILL.md` |
| Claude Code | `.claude/skills/<skill>/SKILL.md` |
| Antigravity | `.agent/skills/<skill>/SKILL.md` |
| AGENTS.md | `AGENTS.md` (skills concatenated) |

---

## Talking to your agents (Agentverse / ASI:One)

Every generated agent sets `mailbox=True` and `publish_agent_details=True`, so
"registration" is the browser inspector + mailbox connect flow. Each agent logs
its exact inspector URL on startup. The CLI prints the step-by-step flow; for the
orchestrator system you only chat with the orchestrator — it routes to the workers.

Programmatic registration (`AGENTVERSE_API_KEY`) is documented future work, not v1.

---

## Development

```bash
npm install
npm test                 # fast unit + integration tests
CFA_PACK=1 npm test      # also verify the published file set via `npm pack`
CFA_SMOKE=1 npm test     # also boot a generated orchestrator and curl /health (needs Python)
```

---

## License

MIT

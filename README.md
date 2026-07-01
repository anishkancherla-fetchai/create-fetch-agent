# create-fetch-agent

Scaffold a **runnable Fetch.ai [uAgents](https://uagents.fetch.ai) project** with
one command, then layer in context for your AI coding tool.

```bash
npx create-fetch-agent my-app
# or
npm create fetch-agent@latest my-app
```

The generated project runs immediately: seeds are pre-filled, addresses are
derived from them, ports are assigned, the **chat protocol is already wired**
(so it's ASI:One ready), and a `Makefile` starts every agent. The only things
left as `TODO` are the workflow functions where *your* logic goes.

---

## What you get

An interactive wizard asks a few questions and then:

1. **Generates a runnable uAgents project** — a single agent, several independent
   ASI:One-routed agents, or a pay-to-use agent (on-chain FET).
2. **Pre-generates unique seeds** for every agent and wires up addresses + ports.
3. **Wires the chat protocol into every agent** so it's chattable + discoverable
   on ASI:One out of the box (the #1 thing builders forget).
4. **Installs AI-editor context** (optional) so Cursor / Claude Code / Antigravity
   / `AGENTS.md` know how to extend the project correctly.
5. **Bootstraps the Python environment** (optional) with `uv`, `poetry`, or `pip`,
   generating a real manifest for that manager (PEP 621 `pyproject.toml` for `uv`,
   Poetry `pyproject.toml`, or `requirements.txt` for pip).
6. **Prints honest Agentverse guidance** for connecting your agents to ASI:One.

---

## Wizard options

| Prompt | Choices |
| --- | --- |
| **Project name** | directory created under the current folder (or pass it as an argument) |
| **What are you building?** | `Single agent` · `Chat agent (ASI:One ready)` · `Multiple agents (ASI:One routes between them)` · `Payment agent (FET)` |
| **Agent count & names** | only for the multi-agent build (defaults `alice`, `bob`) |
| **Python setup** | `uv` (default) · `poetry` · `pip + venv` |
| **AI-editor context** | any of `Cursor` · `Claude Code` · `Antigravity` · `AGENTS.md` (or none) |
| **Register on Agentverse** | `Later` · `Yes` (prints inspector steps) |
| **Install dependencies now?** | yes / no |

Every build type produces real, runnable code — including the payment agent.

---

## Non-interactive & flags

Pass flags to skip prompts (handy for scripts, CI, or re-recording demos):

```bash
# non-interactive scaffold
npx create-fetch-agent my-bot --type payment --python uv --ai cursor --no-install
```

| Flag | Purpose |
| --- | --- |
| `--type <t>` | `single` · `chat` · `multi` · `payment` |
| `--agents <list>` | multi only: agent names, e.g. `alice,bob` |
| `--count <n>` | multi only: N agents with default names |
| `--python <m>` | `uv` · `poetry` · `pip` |
| `--ai <list>` | comma list: `cursor,claude,antigravity,agents` (or `none`) |
| `--no-install` | skip installing Python dependencies |
| `--no-register` | skip the Agentverse registration prompt |
| `--skills-only` | **add AI-editor context to an existing project** (no scaffolding) |
| `-h`, `--help` | show usage |

Any prompt whose flag you omit still runs interactively.

### Add context to an existing project (`--skills-only`)

Already have an agent and just want the AI-editor context? Run it **in place** —
it installs `SKILL.md` files without generating or touching any of your code:

```bash
# inside your project (or pass a directory), fully non-interactive
npx create-fetch-agent --skills-only --ai cursor,claude

# pick targets interactively; --type controls which protocol skills get added
npx create-fetch-agent ./my-existing-agent --skills-only --type payment
```

---

## The project shapes

### Single / chat agent (`Single agent`, `Chat agent`)

A flat, self-contained, chat-enabled agent that's ASI:One ready out of the box:

```
my-app/
  agent.py          # speaks the chat protocol; <name>_workflow(query) is your hook
  .env              # AGENT_SEED_PHRASE (pre-generated)
  pyproject.toml    # (uv / poetry) — or requirements.txt for pip
  Makefile          # make run
  README.md
```

Starts on port `8000`. `ctx.session` is surfaced in the handler so you can key
per-conversation state.

### Multiple agents (`Multiple agents (ASI:One routes between them)`)

Several **independent** agents, each an expert at one task. There is **no
orchestrator** — every agent speaks the chat protocol and registers on
Agentverse, and **ASI:One discovers and routes** each request to whichever agent
best matches its description.

```
my-app/
  agents/
    __init__.py
    <agent>/
      __init__.py
      <agent>_agent.py   # independent chat agent; <agent>_workflow(query) is your hook
  .env                   # one <NAME>_SEED_PHRASE per agent (pre-generated)
  Makefile               # one `make <agent>` target each
  pyproject.toml         # (uv / poetry) — or requirements.txt for pip
  README.md
```

Ports are deterministic and sequential from `8001`. Fill in each agent's
`AGENT_DESCRIPTION` so ASI:One knows when to route to it.

### Payment agent (`Payment agent (FET)`)

A pay-to-use agent: it speaks the chat protocol **and** the payment protocol,
charging in **on-chain FET**. The full `request → commit → verify → complete`
flow is generated, with on-chain verification built in.

```
my-app/
  agent.py                       # includes both chat + payment protocols
  protocols/
    chat_proto.py                # chat handling + run_paid_action() — your hook
    payment_proto.py             # the FET rail: request, on-chain verify, complete
  .env                           # seed (pre-generated) — no payment keys needed
  Makefile                       # make run
  README.md
```

This template ships **FET only** — it's the complete, working rail. Other rails
(Stripe cards, USDC, etc.) are intentionally left for you to add in
`payment_proto.py`. There are **no payment keys to configure**: FET defaults to
the stable-testnet and the wallet auto-funds itself. Just `make run`, then pay
the FET request from a testnet wallet. The default paid action runs with **no
extra keys** (it replies with a placeholder); set `ASI_ONE_API_KEY` (and
`pip install openai`) to power it with ASI:One, or edit `run_paid_action()` to
call your own service.

---

## The two-layer model

`create-fetch-agent` deliberately separates two concerns:

1. **`create-fetch-agent` (this tool)**: owns project structure, runnable starter
   code, seed generation, deterministic ports, dependency install, and Agentverse
   guidance.
2. **[`fetch-skills`](https://www.npmjs.com/package/fetch-skills)**: a context
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

Every generated agent sets `mailbox=True` and `publish_agent_details=True` and
**publishes the chat protocol manifest on startup** — so "registration" is just
the browser inspector + mailbox connect flow. Each agent logs its exact inspector
URL on startup, and the CLI prints the step-by-step flow.

> **The chat protocol is what makes an agent chattable.** You'll see
> `Manifest published successfully: AgentChatProtocol` in the startup logs, which
> means Agentverse's "Add Chat Protocol" checklist item is already satisfied.
> Connecting a mailbox alone is **not** enough — and that's the #1 reason
> hand-rolled agents fail to connect. This tool wires it for you.

For the multi-agent build there's no orchestrator: ASI:One routes each request to
whichever agent's description best fits.

Programmatic registration (`AGENTVERSE_API_KEY`) is documented future work, not v1.

---

## Development

```bash
npm install
npm test                 # fast unit + integration tests
CFA_PACK=1 npm test      # also verify the published file set via `npm pack`
CFA_SMOKE=1 npm test     # also boot a generated agent and assert it logs its address (needs Python)
```

---

## License

MIT

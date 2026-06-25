from __future__ import annotations

import os

from dotenv import load_dotenv
from uagents import Agent, Context
from uagents.setup import fund_agent_if_low

load_dotenv()

# Import protocol modules AFTER load_dotenv so module-level os.getenv reads .env values.
from protocols.chat_proto import chat_proto
from protocols.payment_proto import payment_proto, set_agent_wallet


def _required(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


# The seed is pre-generated for you in .env. It deterministically derives the
# agent's wallet + address (and therefore the recipient of every payment).
AGENT_SEED = _required("AGENT_SEED_PHRASE")

# Development default: testnet. "testnet" auto-funds the wallet (below) and
# registers against the Fetch.ai testnet Almanac. Switch to "mainnet" only for a
# real production deploy (you then fund the wallet yourself).
AGENT_NETWORK = (os.getenv("AGENT_NETWORK") or "testnet").strip().lower()

agent = Agent(
    name=os.getenv("AGENT_NAME", "payment-agent"),
    seed=AGENT_SEED,
    port=int(os.getenv("AGENT_PORT", "8000")),
    mailbox=os.getenv("AGENT_MAILBOX", "true").strip().lower() == "true",
    publish_agent_details=True,
)

# On testnet, top up the wallet so Almanac registration succeeds (no-op once
# funded, safe on every restart). On mainnet the operator funds it themselves.
if AGENT_NETWORK == "testnet":
    try:
        fund_agent_if_low(str(agent.wallet.address()))
    except Exception:
        pass

set_agent_wallet(agent.wallet)

# ⚠️ REQUIRED. The chat protocol makes the agent chattable/discoverable on
# ASI:One; the payment protocol makes it payable. Both publish their manifest on
# startup. Without the chat protocol the agent can't be chatted with at all (the
# #1 reason agents fail to connect), even with a mailbox connected. Keep both.
agent.include(chat_proto, publish_manifest=True)
agent.include(payment_proto, publish_manifest=True)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"payment agent started with address: {agent.address}")
    ctx.logger.info(f"wallet (payment recipient): {agent.wallet.address()}")
    ctx.logger.info("Chat + payment protocols published — ASI:One ready (chattable + payable).")
    ctx.logger.info("Accepts: Stripe card + on-chain FET. Chat to trigger a payment request.")


if __name__ == "__main__":
    agent.run()

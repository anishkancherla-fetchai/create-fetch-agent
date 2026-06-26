from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

from protocols.payment_proto import (
    log_inbound,
    log_outbound,
    log_state,
    request_payment_from_user,
)

chat_proto = Protocol(spec=chat_protocol_spec)

ASI_ONE_BASE_URL = "https://api.asi1.ai/v1"
ASI_ONE_MODEL = os.getenv("ASI_ONE_MODEL", "asi1").strip() or "asi1"
ASI_ONE_SYSTEM_PROMPT = (
    os.getenv("ASI_ONE_SYSTEM_PROMPT")
    or "You are a helpful, precise assistant. Answer the user's request directly."
)

_asi_client = None


def _get_asi_client():
    """Lazily build the ASI:One client (OpenAI-compatible). Returns None if the
    `openai` SDK isn't installed or ASI_ONE_API_KEY isn't set — in that case
    `run_paid_action` falls back to a placeholder so the payment loop still
    works end-to-end with no extra keys."""
    global _asi_client
    if _asi_client is not None:
        return _asi_client
    if not os.getenv("ASI_ONE_API_KEY"):
        return None
    try:
        from openai import OpenAI
    except Exception:
        return None
    _asi_client = OpenAI(api_key=os.getenv("ASI_ONE_API_KEY"), base_url=ASI_ONE_BASE_URL)
    return _asi_client


def _call_asi_one(prompt: str, *, session_id: str) -> str:
    client = _get_asi_client()
    response = client.chat.completions.create(
        model=ASI_ONE_MODEL,
        messages=[
            {"role": "system", "content": ASI_ONE_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        max_tokens=1000,
        extra_headers={"x-session-id": session_id} if session_id else None,
    )
    return response.choices[0].message.content or "(no response)"


def create_text_chat(text: str) -> ChatMessage:
    return ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=text)],
    )


def _user_text(msg: ChatMessage) -> str:
    parts = [c.text for c in msg.content if isinstance(c, TextContent)]
    return " ".join(parts).strip()


def _is_paid_request(text: str) -> bool:
    """Gate: which chat messages require payment. Default: every non-empty
    message. Replace with the agent's real 'paid action requested' detector
    (e.g. only charge for certain commands)."""
    return bool(text)


@chat_proto.on_message(ChatMessage)
async def handle_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
    log_inbound(ctx, "ChatMessage", sender, f"msg_id={msg.msg_id}")

    ack = ChatAcknowledgement(
        timestamp=datetime.now(timezone.utc),
        acknowledged_msg_id=msg.msg_id,
    )
    log_outbound(ctx, "ChatAcknowledgement", sender, f"acknowledged_msg_id={msg.msg_id}")
    await ctx.send(sender, ack)

    text = _user_text(msg)
    session_id = str(ctx.session)
    try:
        already_paid = bool(ctx.storage.get(f"{sender}:{session_id}:verified_payment"))
    except Exception:
        already_paid = False

    ctx.logger.info(f"[inbound] text from {sender}: {text[:120]!r} already_paid={already_paid}")

    if already_paid:
        # Reuse the verified flag for follow-up messages in the same session.
        # Trade-off: one paid session keeps serving until ctx.session changes.
        # If you require pay-per-message, remove the flag here and persist a
        # counter instead.
        await run_paid_action(ctx, sender, session_id, text=text)
        return

    if _is_paid_request(text):
        await request_payment_from_user(
            ctx, sender,
            description="Pay with FET to run this request.",
            text=text,
        )
        notice = create_text_chat(
            "Once the FET payment completes, I'll reply here with your result."
        )
        log_outbound(ctx, "ChatMessage", sender, "awaiting_payment_notice")
        await ctx.send(sender, notice)
        return

    greet = create_text_chat("How can I help?")
    log_outbound(ctx, "ChatMessage", sender, "default_greeting")
    await ctx.send(sender, greet)


@chat_proto.on_message(ChatAcknowledgement)
async def handle_chat_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
    log_inbound(ctx, "ChatAcknowledgement", sender, f"acknowledged_msg_id={msg.acknowledged_msg_id}")


async def run_paid_action(
    ctx: Context,
    user_address: str,
    session_id: str,
    text: str | None = None,
) -> None:
    """The paid action — the one extension point you own.

    Runs automatically ONLY after a payment is verified. Replace the body with
    your real paid service (LLM call, image gen, video gen, API call, data
    lookup, etc.).

    Default behaviour:
      * If ASI_ONE_API_KEY is set (and the `openai` SDK is installed), routes the
        prompt to ASI:One and returns the completion.
      * Otherwise replies with a confirmation placeholder so the full
        pay -> verify -> deliver loop is demonstrable with no extra keys.
    """
    prompt = (text or "").strip() or "Say hello."

    if _get_asi_client() is None:
        reply = create_text_chat(
            "Payment verified ✅ — here's your result.\n\n"
            f"(You asked: {prompt[:200]})\n\n"
            "This is the placeholder paid action. Set ASI_ONE_API_KEY in .env to "
            "power it with ASI:One, or edit run_paid_action() in "
            "protocols/chat_proto.py to call your own service."
        )
        log_outbound(ctx, "ChatMessage", user_address, "paid_action_placeholder")
        await ctx.send(user_address, reply)
        return

    try:
        reply_text = await asyncio.to_thread(_call_asi_one, prompt, session_id=session_id)
    except Exception as e:
        ctx.logger.exception(f"[payment] ASI:One call failed: {e}")
        reply_text = "Payment verified, but the assistant call failed. Please try again."
    reply = create_text_chat(reply_text)
    log_outbound(ctx, "ChatMessage", user_address, "paid_action_result")
    await ctx.send(user_address, reply)

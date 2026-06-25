from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import ChatMessage, TextContent
from uagents_core.contrib.protocols.payment import (
    CancelPayment,
    CommitPayment,
    CompletePayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

from stripe_payments.checkout import (
    create_embedded_checkout_session,
    is_stripe_configured,
    verify_checkout_session_paid,
)
from fet_payments.ledger import extract_buyer_fet_wallet, verify_fet_payment_to_agent

payment_proto = Protocol(spec=payment_protocol_spec, role="seller")


def _env_int(name: str, default: int) -> int:
    """Safe int parsing for env vars; falls back to default on missing/garbage values
    instead of raising at module import time."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


# --- pricing knobs (computed server-side, never trusted from the buyer) ---
STRIPE_AMOUNT_CENTS = _env_int("STRIPE_AMOUNT_CENTS", 100)
STRIPE_CURRENCY = (os.getenv("STRIPE_CURRENCY") or "USD").strip().upper()
STRIPE_FUNDS = Funds(
    currency=STRIPE_CURRENCY,
    amount=f"{STRIPE_AMOUNT_CENTS / 100:.2f}",
    payment_method="stripe",
)

FET_AMOUNT_FET = (os.getenv("FET_AMOUNT_FET") or "0.001").strip() or "0.001"
FET_FUNDS = Funds(currency="FET", amount=FET_AMOUNT_FET, payment_method="fet_direct")

_agent_wallet = None  # set from agent.py via set_agent_wallet(agent.wallet)


def set_agent_wallet(wallet) -> None:
    global _agent_wallet
    _agent_wallet = wallet


def _env_true(name: str, default: bool = True) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "y", "on"}


def _use_testnet() -> bool:
    return os.getenv("FET_USE_TESTNET", "true").strip().lower() == "true"


def log_inbound(ctx: Context, msg_type: str, sender: str, details: str | None = None) -> None:
    suffix = f" {details}" if details else ""
    ctx.logger.info(f"[inbound] {msg_type} from {sender}{suffix}")


def log_outbound(ctx: Context, msg_type: str, recipient: str, details: str | None = None) -> None:
    suffix = f" {details}" if details else ""
    ctx.logger.info(f"[outbound] {msg_type} -> {recipient}{suffix}")


def log_state(ctx: Context, event: str, details: str | None = None) -> None:
    suffix = f" {details}" if details else ""
    ctx.logger.info(f"[state] {event}{suffix}")


def metadata_value(metadata, key: str, default: str = "") -> str:
    """Stripe metadata may be a StripeObject; normalize reads to avoid AttributeError."""
    if isinstance(metadata, dict):
        return str(metadata.get(key) or default)
    if hasattr(metadata, "to_dict_recursive"):
        return str(metadata.to_dict_recursive().get(key) or default)
    return str(getattr(metadata, key, default) or default)


def _lookup_session_id_by_checkout(ctx: Context, tx_id: str) -> str:
    """Recover the chat session id for a Stripe Checkout Session id.

    Stripe metadata occasionally arrives empty (legacy sessions, custom UIs
    that strip metadata). The pending request mapping persisted in
    `request_payment_from_user` is the canonical fallback.
    """
    try:
        rec = ctx.storage.get(f"payment_request:by_checkout:{tx_id}") or {}
    except Exception:
        return ""
    if isinstance(rec, dict):
        return str(rec.get("chat_session_id") or "")
    return ""


def _latest_session_key(user_address: str) -> str:
    return f"payment_request:latest_session:{user_address}"


def _resolve_latest_session_id(ctx: Context, user_address: str) -> str:
    """Best-effort session recovery for replayed commits / session drift."""
    try:
        rec = ctx.storage.get(_latest_session_key(user_address)) or {}
        if isinstance(rec, dict):
            sid = str(rec.get("session_id") or "").strip()
            if sid:
                return sid
    except Exception:
        pass
    return str(ctx.session)


def _fulfilled_key(user_address: str, session_id: str, tx_id: str) -> str:
    return f"payment:fulfilled:{user_address}:{session_id}:{tx_id}"


def _chat(text: str) -> ChatMessage:
    return ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=text)],
    )


def _accepted_methods() -> list[Funds]:
    """Build the multi-method accepted_funds list, skipping anything disabled."""
    funds: list[Funds] = []
    if _env_true("ENABLE_STRIPE_PAYMENTS", True) and is_stripe_configured():
        funds.append(STRIPE_FUNDS)
    if _env_true("ENABLE_FET_PAYMENTS", True) and _agent_wallet is not None:
        funds.append(FET_FUNDS)
    return funds


async def request_payment_from_user(
    ctx: Context,
    user_address: str,
    description: str | None = None,
    text: str | None = None,
) -> None:
    """Build a single RequestPayment that advertises every enabled method.

    `text` is the user's original prompt. We persist it so the per-method
    `_on_commit_*` handler can fulfill the request after verification.
    """
    if _agent_wallet is None:
        ctx.logger.error("[payment] agent wallet not set; call set_agent_wallet(agent.wallet)")
        return

    chat_session_id = str(ctx.session)
    pending_key = f"payment_request:pending:{user_address}:{chat_session_id}"
    prompt_key = f"chat_prompt:{user_address}:{chat_session_id}"

    # Always refresh the persisted prompt so the latest paid request wins.
    try:
        ctx.storage.set(prompt_key, text or "")
        ctx.storage.set(_latest_session_key(user_address), {"session_id": chat_session_id, "ts": time.time()})
    except Exception as e:
        ctx.logger.warning(f"[payment] failed to persist chat prompt: {e}")

    pending_ttl_s = max(60, min(24 * 60 * 60, int(os.getenv("PAYMENT_REQUEST_PENDING_TTL_SECONDS", "1800"))))
    resend_min_s = max(10, min(3600, int(os.getenv("PAYMENT_REQUEST_RESEND_MIN_INTERVAL_SECONDS", "60"))))
    now = time.time()

    try:
        already_verified = bool(ctx.storage.get(f"{user_address}:{chat_session_id}:verified_payment"))
    except Exception:
        already_verified = False
    if already_verified:
        log_state(ctx, "already_verified", f"user={user_address} session={chat_session_id}")
        return

    try:
        pending = ctx.storage.get(pending_key) if ctx.storage.has(pending_key) else None
    except Exception:
        pending = None
    if isinstance(pending, dict):
        try:
            ts = float(pending.get("ts") or 0)
            last_sent = float(pending.get("last_sent") or 0)
        except Exception:
            ts, last_sent = 0.0, 0.0
        if ts and (now - ts) < pending_ttl_s and (now - last_sent) < resend_min_s:
            log_state(ctx, "pending_request_suppressed", f"user={user_address} session={chat_session_id}")
            return

    accepted = _accepted_methods()
    if not accepted:
        ctx.logger.warning("[payment] no payment methods enabled; cannot request payment")
        reply = _chat("Payments are not available right now.")
        log_outbound(ctx, "ChatMessage", user_address, "no_methods_enabled")
        await ctx.send(user_address, reply)
        return

    metadata: dict = {"agent": ctx.agent.name}

    # Stripe metadata + Checkout Session creation only when Stripe is in the offer.
    if any(f.payment_method == "stripe" for f in accepted):
        checkout = create_embedded_checkout_session(
            user_address=user_address,
            chat_session_id=chat_session_id,
            description=description or "Payment required to continue.",
            payment_request_id=uuid4().hex,
        )
        if not checkout or checkout.get("error") or not checkout.get("client_secret"):
            err = (checkout or {}).get("error") or "unknown error"
            ctx.logger.error(f"[payment] stripe checkout create failed: {err}")
            # Drop Stripe from the offer; FET (if enabled) can still proceed.
            accepted = [f for f in accepted if f.payment_method != "stripe"]
        else:
            ctx.logger.info(
                f"[payment] stripe checkout created cs_id={checkout['id']} "
                f"amount_cents={checkout['amount_cents']} currency={checkout['currency']} "
                f"ui_mode={checkout.get('ui_mode')}"
            )
            metadata["stripe"] = {
                # Literal "embedded" here is the Agentverse UI contract — NOT the
                # Stripe API enum (which moved to "embedded_page" in Dahlia).
                "ui_mode": "embedded",
                "publishable_key": checkout["publishable_key"],
                "client_secret": checkout["client_secret"],
                "checkout_session_id": checkout["id"],
                "amount_cents": checkout["amount_cents"],
                "currency": checkout["currency"],
            }

    # FET metadata only when FET is in the offer.
    if any(f.payment_method == "fet_direct" for f in accepted):
        use_testnet = _use_testnet()
        metadata["fet_network"] = "stable-testnet" if use_testnet else "mainnet"
        metadata["mainnet"] = "false" if use_testnet else "true"
        metadata["provider_agent_wallet"] = str(_agent_wallet.address())

    if not accepted:
        reply = _chat("No payment methods are available right now. Please try again later.")
        log_outbound(ctx, "ChatMessage", user_address, "no_methods_enabled")
        await ctx.send(user_address, reply)
        return

    deadline_seconds = max(60, min(24 * 60 * 60, int(os.getenv("CHECKOUT_DEADLINE_SECONDS", "300"))))
    msg = RequestPayment(
        accepted_funds=accepted,
        recipient=str(_agent_wallet.address()),
        deadline_seconds=deadline_seconds,
        reference=str(uuid4()),
        description=description or "Payment required to continue.",
        metadata=metadata,
    )

    method_summary = ",".join(f.payment_method for f in accepted)
    log_outbound(
        ctx, "RequestPayment", user_address,
        f"methods={method_summary} ref={msg.reference} recipient={msg.recipient}",
    )
    await ctx.send(user_address, msg)

    pending_payload = {
        "ts": now,
        "last_sent": now,
        "reference": msg.reference,
        "deadline_seconds": deadline_seconds,
        "description": msg.description,
        "recipient": msg.recipient,
        "metadata": {k: ("<redacted>" if k == "stripe" else v) for k, v in metadata.items()},
        "accepted_funds": [
            {"currency": f.currency, "amount": f.amount, "payment_method": f.payment_method}
            for f in accepted
        ],
    }
    try:
        ctx.storage.set(pending_key, pending_payload)
        if "stripe" in metadata:
            ctx.storage.set(
                f"payment_request:by_checkout:{metadata['stripe']['checkout_session_id']}",
                {
                    "user_address": user_address,
                    "chat_session_id": chat_session_id,
                    "amount_cents": int(metadata["stripe"]["amount_cents"]),
                    "currency": str(metadata["stripe"]["currency"]).lower(),
                },
            )
        log_state(
            ctx, "pending_request_saved",
            f"user={user_address} session={chat_session_id} ref={msg.reference} methods={method_summary}",
        )
    except Exception as e:
        ctx.logger.warning(f"[payment] failed to persist pending request: {e}")


# ---- Commit dispatch ----------------------------------------------------------

async def _resume_paid_fulfillment(
    ctx: Context,
    *,
    sender: str,
    session_id: str,
    tx_id: str,
    replay: bool,
) -> None:
    try:
        prompt = str(ctx.storage.get(f"chat_prompt:{sender}:{session_id}") or "")
    except Exception:
        prompt = ""
    try:
        from protocols.chat_proto import run_paid_action
        await run_paid_action(ctx, sender, session_id, text=prompt)
        ctx.storage.set(_fulfilled_key(sender, session_id, tx_id), True)
        replay_suffix = " replay=true" if replay else ""
        log_state(
            ctx,
            "post_payment_fulfilled",
            f"user={sender} session={session_id} tx_id={tx_id}{replay_suffix}",
        )
    except Exception as e:
        ctx.logger.exception(f"[payment] post-payment fulfillment failed: {e}")
        fail = _chat("Payment received, but generating the result failed. Please retry.")
        log_outbound(
            ctx,
            "ChatMessage",
            sender,
            "post_payment_fulfillment_failed_replay" if replay else "post_payment_fulfillment_failed",
        )
        await ctx.send(sender, fail)


async def _on_commit_stripe(ctx: Context, sender: str, msg: CommitPayment) -> None:
    tx_id = str(getattr(msg, "transaction_id", "") or "")
    if not tx_id:
        log_outbound(ctx, "RejectPayment", sender, "reason=missing_tx_id method=stripe")
        await ctx.send(sender, RejectPayment(reason="Missing Stripe checkout session id"))
        return

    result = verify_checkout_session_paid(tx_id)
    ctx.logger.info(
        f"[payment] stripe verify tx_id={tx_id} verified={result.get('verified')} "
        f"status={result.get('status')} amount_total={result.get('amount_total')} "
        f"currency={result.get('currency')}"
    )
    if not result.get("verified"):
        reason = result.get("error") or "Stripe payment not completed yet."
        log_outbound(ctx, "RejectPayment", sender, f"reason=not_verified tx_id={tx_id}")
        await ctx.send(sender, RejectPayment(reason=reason))
        return

    # Resolve the chat session id with a robust fallback chain so a verified
    # payment never gets rejected just because Stripe's metadata round-trip
    # came back empty.
    metadata = result.get("metadata") or {}
    session_id = (
        metadata_value(metadata, "session_id")
        or _lookup_session_id_by_checkout(ctx, tx_id)
        or _resolve_latest_session_id(ctx, sender)
        or str(ctx.session)
    )
    checkout_ref = ctx.storage.get(f"payment_request:by_checkout:{tx_id}") or {}
    if isinstance(checkout_ref, dict):
        expected_user = str(checkout_ref.get("user_address") or "")
        if expected_user and expected_user != sender:
            log_outbound(ctx, "RejectPayment", sender, f"reason=checkout_owner_mismatch tx_id={tx_id}")
            await ctx.send(sender, RejectPayment(reason="Checkout session does not belong to this user."))
            return
        expected_amount = checkout_ref.get("amount_cents")
        expected_currency = str(checkout_ref.get("currency") or "").lower()
        actual_amount = result.get("amount_total")
        actual_currency = str(result.get("currency") or "").lower()
        if isinstance(expected_amount, int) and actual_amount is not None and int(actual_amount) != expected_amount:
            log_outbound(ctx, "RejectPayment", sender, f"reason=amount_mismatch tx_id={tx_id}")
            await ctx.send(sender, RejectPayment(reason="Stripe amount mismatch."))
            return
        if expected_currency and actual_currency and actual_currency != expected_currency:
            log_outbound(ctx, "RejectPayment", sender, f"reason=currency_mismatch tx_id={tx_id}")
            await ctx.send(sender, RejectPayment(reason="Stripe currency mismatch."))
            return
    log_state(ctx, "session_id_resolved", f"tx_id={tx_id} session={session_id} method=stripe")

    ctx.storage.set(f"payments:processed:{sender}:{tx_id}", True)
    ctx.storage.set(f"{sender}:{session_id}:verified_payment", True)
    ctx.storage.remove(f"payment_request:pending:{sender}:{session_id}")
    ctx.storage.remove(f"payment_request:by_checkout:{tx_id}")
    log_state(ctx, "payment_verified", f"user={sender} session={session_id} tx_id={tx_id} method=stripe")

    log_outbound(ctx, "CompletePayment", sender, f"tx_id={tx_id} method=stripe")
    await ctx.send(sender, CompletePayment(transaction_id=tx_id))

    await _resume_paid_fulfillment(ctx, sender=sender, session_id=session_id, tx_id=tx_id, replay=False)


async def _on_commit_fet(ctx: Context, sender: str, msg: CommitPayment) -> None:
    tx_id = str(getattr(msg, "transaction_id", "") or "")
    cancel_tx_id = tx_id or "missing_transaction_id"
    currency = str(getattr(msg.funds, "currency", "") or "")

    if currency != "FET":
        log_outbound(ctx, "CancelPayment", sender, f"reason=unsupported currency={currency}")
        await ctx.send(
            sender,
            CancelPayment(transaction_id=cancel_tx_id, reason=f"Unsupported FET currency: {currency}"),
        )
        return

    if not tx_id:
        log_outbound(ctx, "CancelPayment", sender, "reason=missing_tx_id method=fet_direct")
        await ctx.send(sender, CancelPayment(transaction_id=cancel_tx_id, reason="Missing transaction_id"))
        return

    buyer_fet_wallet = extract_buyer_fet_wallet(msg.metadata)
    if not buyer_fet_wallet:
        log_outbound(ctx, "CancelPayment", sender, "reason=missing_buyer_fet_wallet")
        await ctx.send(
            sender,
            CancelPayment(transaction_id=cancel_tx_id, reason="Missing buyer_fet_wallet in metadata"),
        )
        return

    use_testnet = _use_testnet()
    network_name = "stable-testnet" if use_testnet else "mainnet"
    ctx.logger.info(
        f"[payment] fet verifying tx tx_id={tx_id} network={network_name} "
        f"buyer={buyer_fet_wallet} recipient={_agent_wallet.address()} amount={msg.funds.amount}"
    )
    try:
        verified = await asyncio.to_thread(
            verify_fet_payment_to_agent,
            transaction_id=tx_id,
            expected_amount_fet=str(msg.funds.amount),
            sender_fet_address=buyer_fet_wallet,
            recipient_agent_wallet=_agent_wallet,
            logger=ctx.logger,
            use_mainnet=not use_testnet,
        )
    except Exception as e:
        ctx.logger.exception(f"[payment] fet verify error: {e}")
        verified = False

    ctx.logger.info(f"[payment] fet verify result tx_id={tx_id} verified={verified}")
    if not verified:
        log_outbound(ctx, "CancelPayment", sender, f"reason=verify_failed tx_id={tx_id}")
        await ctx.send(
            sender,
            CancelPayment(transaction_id=cancel_tx_id, reason="Payment verification failed"),
        )
        return

    session_id = _resolve_latest_session_id(ctx, sender)
    try:
        ctx.storage.set(f"payments:processed:{sender}:{tx_id}", True)
        ctx.storage.set(f"{sender}:{session_id}:verified_payment", True)
        ctx.storage.remove(f"payment_request:pending:{sender}:{session_id}")
        log_state(ctx, "payment_verified", f"user={sender} session={session_id} tx_id={tx_id} method=fet_direct")
    except Exception as e:
        ctx.logger.warning(f"[payment] failed to persist verified state: {e}")

    log_outbound(ctx, "CompletePayment", sender, f"tx_id={tx_id} method=fet_direct")
    await ctx.send(sender, CompletePayment(transaction_id=tx_id))

    await _resume_paid_fulfillment(ctx, sender=sender, session_id=session_id, tx_id=tx_id, replay=False)


@payment_proto.on_message(CommitPayment)
async def on_commit(ctx: Context, sender: str, msg: CommitPayment) -> None:
    tx_id = str(getattr(msg, "transaction_id", "") or "")
    method = str(getattr(msg.funds, "payment_method", "") or "")
    currency = str(getattr(msg.funds, "currency", "") or "")
    amount = str(getattr(msg.funds, "amount", "") or "")
    log_inbound(
        ctx, "CommitPayment", sender,
        f"tx_id={tx_id or 'MISSING'} method={method} currency={currency} amount={amount}",
    )

    if _agent_wallet is None:
        ctx.logger.error("[payment] agent wallet not set; cannot verify")
        log_outbound(ctx, "CancelPayment", sender, "reason=server_wallet_missing")
        await ctx.send(
            sender,
            CancelPayment(transaction_id=tx_id or "missing_transaction_id", reason="Server wallet not configured"),
        )
        return

    # Idempotency BEFORE method dispatch — duplicate commits are method-agnostic.
    if tx_id:
        processed_key = f"payments:processed:{sender}:{tx_id}"
        try:
            if ctx.storage.get(processed_key):
                if method == "stripe":
                    stripe_result = verify_checkout_session_paid(tx_id)
                    stripe_meta = stripe_result.get("metadata") or {}
                    session_id = (
                        metadata_value(stripe_meta, "session_id")
                        or _lookup_session_id_by_checkout(ctx, tx_id)
                        or _resolve_latest_session_id(ctx, sender)
                    )
                elif method == "fet_direct":
                    session_id = _resolve_latest_session_id(ctx, sender)
                else:
                    session_id = str(ctx.session)
                fulfilled = bool(ctx.storage.get(_fulfilled_key(sender, session_id, tx_id)))
                log_state(
                    ctx,
                    "duplicate_commit",
                    f"tx_id={tx_id} method={method} session={session_id} fulfilled={fulfilled}",
                )
                log_outbound(ctx, "CompletePayment", sender, f"tx_id={tx_id} idempotent_replay=true")
                await ctx.send(sender, CompletePayment(transaction_id=tx_id))
                if method in {"stripe", "fet_direct"} and not fulfilled:
                    await _resume_paid_fulfillment(
                        ctx,
                        sender=sender,
                        session_id=session_id,
                        tx_id=tx_id,
                        replay=True,
                    )
                return
        except Exception:
            pass

    if method == "stripe" and _env_true("ENABLE_STRIPE_PAYMENTS", True):
        await _on_commit_stripe(ctx, sender, msg)
    elif method == "fet_direct" and _env_true("ENABLE_FET_PAYMENTS", True):
        await _on_commit_fet(ctx, sender, msg)
    else:
        # Unknown / disabled method. Use RejectPayment as the generic seller failure.
        log_outbound(ctx, "RejectPayment", sender, f"reason=unsupported_method method={method}")
        await ctx.send(
            sender,
            RejectPayment(reason=f"Unsupported or disabled payment method: {method}"),
        )


@payment_proto.on_message(RejectPayment)
async def on_reject(ctx: Context, sender: str, msg: RejectPayment) -> None:
    reason = str(getattr(msg, "reason", "") or "no reason")
    log_inbound(ctx, "RejectPayment", sender, f"reason={reason[:120]}")

    session_id = _resolve_latest_session_id(ctx, sender)
    try:
        ctx.storage.remove(f"payment_request:pending:{sender}:{session_id}")
        log_state(ctx, "pending_request_cleared", f"user={sender} session={session_id}")
    except Exception:
        pass

    reply = _chat(
        "Payment was not completed. Reply if you want to try again and I'll send a new payment request."
    )
    log_outbound(ctx, "ChatMessage", sender, "payment_reject_ack")
    await ctx.send(sender, reply)

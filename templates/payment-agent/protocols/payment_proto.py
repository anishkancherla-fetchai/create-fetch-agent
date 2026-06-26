from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone
from typing import Any
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

payment_proto = Protocol(spec=payment_protocol_spec, role="seller")


def _env_int(name: str, default: int) -> int:
    """Safe int parsing for env vars; falls back to default on missing/garbage."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


# --- pricing (computed server-side, never trusted from the buyer) ---
FET_AMOUNT_FET = (os.getenv("FET_AMOUNT_FET") or "0.001").strip() or "0.001"
FET_FUNDS = Funds(currency="FET", amount=FET_AMOUNT_FET, payment_method="fet_direct")

_agent_wallet = None  # set from agent.py via set_agent_wallet(agent.wallet)


def set_agent_wallet(wallet) -> None:
    global _agent_wallet
    _agent_wallet = wallet


def _use_testnet() -> bool:
    return os.getenv("FET_USE_TESTNET", "true").strip().lower() == "true"


# --- directional logging (so the whole payment lifecycle is traceable in CLI) ---

def log_inbound(ctx: Context, msg_type: str, sender: str, details: str | None = None) -> None:
    suffix = f" {details}" if details else ""
    ctx.logger.info(f"[inbound] {msg_type} from {sender}{suffix}")


def log_outbound(ctx: Context, msg_type: str, recipient: str, details: str | None = None) -> None:
    suffix = f" {details}" if details else ""
    ctx.logger.info(f"[outbound] {msg_type} -> {recipient}{suffix}")


def log_state(ctx: Context, event: str, details: str | None = None) -> None:
    suffix = f" {details}" if details else ""
    ctx.logger.info(f"[state] {event}{suffix}")


def _chat(text: str) -> ChatMessage:
    return ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=text)],
    )


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


# --- FET ledger verification (the only on-chain code; uses cosmpy) ----------------

def extract_buyer_fet_wallet(metadata: Any) -> str | None:
    """Read the buyer's FET address from CommitPayment.metadata.

    Accepts either `buyer_fet_wallet` or `buyer_fet_address`.
    """
    if not isinstance(metadata, dict):
        return None
    v = metadata.get("buyer_fet_wallet") or metadata.get("buyer_fet_address")
    return v if isinstance(v, str) and v else None


def verify_fet_payment_to_agent(
    *,
    transaction_id: str,
    expected_amount_fet: str,
    sender_fet_address: str,
    recipient_agent_wallet,        # any object with .address()
    logger,
    use_mainnet: bool | None = None,
) -> bool:
    """Verify a direct FET transfer by inspecting the chain transaction.

    `expected_amount_fet` is in FET units (string, e.g. "0.001").
    `recipient_agent_wallet` must expose `.address()` (e.g. `agent.wallet`).
    """
    try:
        prefer_mainnet = (os.getenv("FET_USE_TESTNET", "true").strip().lower() != "true")
        networks: list[bool] = (
            [use_mainnet] if use_mainnet is not None else [prefer_mainnet, not prefer_mainnet]
        )
        for net_is_mainnet in networks:
            if _verify_fet_tx(
                transaction_id=transaction_id,
                expected_amount_fet=expected_amount_fet,
                sender_fet_address=sender_fet_address,
                recipient_agent_wallet=recipient_agent_wallet,
                logger=logger,
                use_mainnet=net_is_mainnet,
            ):
                return True
        return False
    except Exception as e:
        logger.error(f"FET payment verification failed: {e}")
        return False


def _verify_fet_tx(
    *,
    transaction_id: str,
    expected_amount_fet: str,
    sender_fet_address: str,
    recipient_agent_wallet,
    logger,
    use_mainnet: bool,
) -> bool:
    expected_amount_micro = int(float(expected_amount_fet) * 10**18)
    denom = "afet" if use_mainnet else "atestfet"
    expected_recipient = str(recipient_agent_wallet.address())

    logger.info(
        f"Verifying FET payment of {expected_amount_fet} FET ({expected_amount_micro} {denom}) "
        f"from {sender_fet_address} to {expected_recipient} "
        f"on {'mainnet' if use_mainnet else 'testnet'}"
    )

    from cosmpy.aerial.client import LedgerClient, NetworkConfig

    network_config = (
        NetworkConfig.fetchai_mainnet() if use_mainnet else NetworkConfig.fetchai_stable_testnet()
    )
    ledger = LedgerClient(network_config)

    query_timeout_s = float(_env_int("FET_LEDGER_QUERY_TIMEOUT_SECONDS", 20))
    try:
        with ThreadPoolExecutor(max_workers=1) as ex:
            fut = ex.submit(ledger.query_tx, transaction_id)
            tx_resp = fut.result(timeout=query_timeout_s)
    except FuturesTimeoutError:
        logger.error(
            f"FET tx query timed out after {query_timeout_s:.0f}s on "
            f"{'mainnet' if use_mainnet else 'testnet'} (tx={transaction_id})"
        )
        return False

    if tx_resp is None:
        logger.error(f"Transaction {transaction_id} not found on {'mainnet' if use_mainnet else 'testnet'}")
        return False
    if hasattr(tx_resp, "is_successful") and not tx_resp.is_successful():
        logger.error(f"Transaction {transaction_id} was not successful")
        return False
    events = getattr(tx_resp, "events", None)
    if not isinstance(events, dict):
        logger.error(f"Transaction {transaction_id} has no usable events")
        return False

    valid_recipient = False
    valid_sender = False
    valid_amount = False

    transfer = events.get("transfer")
    if isinstance(transfer, dict):
        recipient = str(transfer.get("recipient") or "")
        sender = str(transfer.get("sender") or "")
        amount_str = str(transfer.get("amount") or "")
        if recipient == expected_recipient:
            valid_recipient = True
        if sender == sender_fet_address:
            valid_sender = True
        if amount_str.endswith(denom):
            try:
                if int(amount_str.replace(denom, "")) >= expected_amount_micro:
                    valid_amount = True
            except ValueError:
                pass

    if not (valid_recipient and valid_amount):
        coin_received = events.get("coin_received")
        if isinstance(coin_received, dict):
            if str(coin_received.get("receiver") or "") == expected_recipient:
                valid_recipient = True
            amount_str = str(coin_received.get("amount") or "")
            if amount_str.endswith(denom):
                try:
                    if int(amount_str.replace(denom, "")) >= expected_amount_micro:
                        valid_amount = True
                except ValueError:
                    pass

    if not valid_sender:
        coin_spent = events.get("coin_spent")
        if isinstance(coin_spent, dict) and str(coin_spent.get("spender") or "") == sender_fet_address:
            valid_sender = True

    if valid_recipient and valid_amount and valid_sender:
        logger.info(f"FET tx verified: {transaction_id}")
        return True

    logger.warning(
        "FET verification incomplete - "
        f"recipient={valid_recipient}, amount={valid_amount}, sender={valid_sender}"
    )
    return False


# --- the seller flow: request -> commit -> verify -> complete --------------------

async def request_payment_from_user(
    ctx: Context,
    user_address: str,
    description: str | None = None,
    text: str | None = None,
) -> None:
    """Send a RequestPayment for FET. Persists the user's prompt so the commit
    handler can fulfill the request after on-chain verification."""
    if _agent_wallet is None:
        ctx.logger.error("[payment] agent wallet not set; call set_agent_wallet(agent.wallet)")
        return

    chat_session_id = str(ctx.session)
    try:
        ctx.storage.set(f"chat_prompt:{user_address}:{chat_session_id}", text or "")
        ctx.storage.set(_latest_session_key(user_address), {"session_id": chat_session_id})
    except Exception as e:
        ctx.logger.warning(f"[payment] failed to persist chat prompt: {e}")

    use_testnet = _use_testnet()
    metadata = {
        "agent": ctx.agent.name,
        # The buyer's wallet/UI uses these to broadcast the FET transfer.
        "fet_network": "stable-testnet" if use_testnet else "mainnet",
        "mainnet": "false" if use_testnet else "true",
        "provider_agent_wallet": str(_agent_wallet.address()),
    }

    deadline_seconds = max(60, min(24 * 60 * 60, int(os.getenv("CHECKOUT_DEADLINE_SECONDS", "300"))))
    msg = RequestPayment(
        accepted_funds=[FET_FUNDS],
        recipient=str(_agent_wallet.address()),
        deadline_seconds=deadline_seconds,
        reference=str(uuid4()),
        description=description or "Pay with FET to continue.",
        metadata=metadata,
    )

    log_outbound(
        ctx, "RequestPayment", user_address,
        f"method=fet_direct amount={FET_AMOUNT_FET} ref={msg.reference} recipient={msg.recipient}",
    )
    await ctx.send(user_address, msg)
    log_state(ctx, "payment_requested", f"user={user_address} session={chat_session_id}")


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
        # Imported here (not at module top) to avoid a circular import with chat_proto.
        from protocols.chat_proto import run_paid_action
        await run_paid_action(ctx, sender, session_id, text=prompt)
        ctx.storage.set(_fulfilled_key(sender, session_id, tx_id), True)
        replay_suffix = " replay=true" if replay else ""
        log_state(ctx, "post_payment_fulfilled", f"user={sender} session={session_id} tx_id={tx_id}{replay_suffix}")
    except Exception as e:
        ctx.logger.exception(f"[payment] post-payment fulfillment failed: {e}")
        log_outbound(ctx, "ChatMessage", sender, "post_payment_fulfillment_failed")
        await ctx.send(sender, _chat("Payment received, but generating the result failed. Please retry."))


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

    cancel_tx_id = tx_id or "missing_transaction_id"

    if _agent_wallet is None:
        ctx.logger.error("[payment] agent wallet not set; cannot verify")
        log_outbound(ctx, "CancelPayment", sender, "reason=server_wallet_missing")
        await ctx.send(sender, CancelPayment(transaction_id=cancel_tx_id, reason="Server wallet not configured"))
        return

    # This template accepts FET only. Add other methods yourself if you need them.
    if method != "fet_direct" or currency != "FET":
        log_outbound(ctx, "CancelPayment", sender, f"reason=unsupported method={method} currency={currency}")
        await ctx.send(
            sender,
            CancelPayment(transaction_id=cancel_tx_id, reason=f"Unsupported payment method: {method or currency}"),
        )
        return

    if not tx_id:
        log_outbound(ctx, "CancelPayment", sender, "reason=missing_tx_id")
        await ctx.send(sender, CancelPayment(transaction_id=cancel_tx_id, reason="Missing transaction_id"))
        return

    # Idempotency: never re-verify/re-charge a transaction we've already processed.
    processed_key = f"payments:processed:{sender}:{tx_id}"
    try:
        if ctx.storage.get(processed_key):
            session_id = _resolve_latest_session_id(ctx, sender)
            fulfilled = bool(ctx.storage.get(_fulfilled_key(sender, session_id, tx_id)))
            log_state(ctx, "duplicate_commit", f"tx_id={tx_id} session={session_id} fulfilled={fulfilled}")
            log_outbound(ctx, "CompletePayment", sender, f"tx_id={tx_id} idempotent_replay=true")
            await ctx.send(sender, CompletePayment(transaction_id=tx_id))
            if not fulfilled:
                await _resume_paid_fulfillment(ctx, sender=sender, session_id=session_id, tx_id=tx_id, replay=True)
            return
    except Exception:
        pass

    buyer_fet_wallet = extract_buyer_fet_wallet(msg.metadata)
    if not buyer_fet_wallet:
        log_outbound(ctx, "CancelPayment", sender, "reason=missing_buyer_fet_wallet")
        await ctx.send(
            sender,
            CancelPayment(transaction_id=cancel_tx_id, reason="Missing buyer_fet_wallet in metadata"),
        )
        return

    use_testnet = _use_testnet()
    ctx.logger.info(
        f"[payment] fet verifying tx tx_id={tx_id} network={'stable-testnet' if use_testnet else 'mainnet'} "
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
        await ctx.send(sender, CancelPayment(transaction_id=cancel_tx_id, reason="Payment verification failed"))
        return

    session_id = _resolve_latest_session_id(ctx, sender)
    try:
        ctx.storage.set(processed_key, True)
        ctx.storage.set(f"{sender}:{session_id}:verified_payment", True)
        log_state(ctx, "payment_verified", f"user={sender} session={session_id} tx_id={tx_id} method=fet_direct")
    except Exception as e:
        ctx.logger.warning(f"[payment] failed to persist verified state: {e}")

    log_outbound(ctx, "CompletePayment", sender, f"tx_id={tx_id} method=fet_direct")
    await ctx.send(sender, CompletePayment(transaction_id=tx_id))

    await _resume_paid_fulfillment(ctx, sender=sender, session_id=session_id, tx_id=tx_id, replay=False)


@payment_proto.on_message(RejectPayment)
async def on_reject(ctx: Context, sender: str, msg: RejectPayment) -> None:
    reason = str(getattr(msg, "reason", "") or "no reason")
    log_inbound(ctx, "RejectPayment", sender, f"reason={reason[:120]}")
    log_outbound(ctx, "ChatMessage", sender, "payment_reject_ack")
    await ctx.send(
        sender,
        _chat("Payment was not completed. Reply if you want to try again and I'll send a new payment request."),
    )

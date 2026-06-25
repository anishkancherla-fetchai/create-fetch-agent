from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from typing import Any


def extract_buyer_fet_wallet(metadata: Any) -> str | None:
    """Read the buyer's FET address from CommitPayment.metadata.

    Accepts either `buyer_fet_wallet` or `buyer_fet_address`.
    """
    if not isinstance(metadata, dict):
        return None
    v = metadata.get("buyer_fet_wallet") or metadata.get("buyer_fet_address")
    return v if isinstance(v, str) and v else None


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


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

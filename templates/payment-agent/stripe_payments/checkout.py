import os
import time
from typing import Any
from uuid import uuid4


def _stripe_sdk():
    try:
        import stripe
        return stripe
    except Exception:
        return None


def is_stripe_configured() -> bool:
    sdk = _stripe_sdk()
    return bool(sdk and os.getenv("STRIPE_SECRET_KEY") and os.getenv("STRIPE_PUBLISHABLE_KEY"))


def stripe_metadata_to_dict(metadata: Any) -> dict[str, Any]:
    """Stripe returns metadata as a StripeObject in some SDK versions, not a dict."""
    if not metadata:
        return {}
    if isinstance(metadata, dict):
        return metadata
    if hasattr(metadata, "to_dict_recursive"):
        return metadata.to_dict_recursive()
    try:
        return dict(metadata)
    except Exception:
        return {}


def create_embedded_checkout_session(
    *,
    user_address: str,
    chat_session_id: str,
    description: str,
    payment_request_id: str | None = None,
    amount_cents_override: int | None = None,
) -> dict[str, Any] | None:
    sdk = _stripe_sdk()
    if not sdk:
        return None
    secret = os.getenv("STRIPE_SECRET_KEY")
    publishable = os.getenv("STRIPE_PUBLISHABLE_KEY")
    if not (secret and publishable):
        return None
    sdk.api_key = secret

    price_id = (os.getenv("STRIPE_PRICE_ID") or "").strip()
    amount_cents = amount_cents_override if amount_cents_override is not None else int(
        os.getenv("STRIPE_AMOUNT_CENTS", "100")
    )
    currency = (os.getenv("STRIPE_CURRENCY") or "usd").strip().lower()
    product_name = os.getenv("STRIPE_PRODUCT_NAME", "Agent service")
    success_url = os.getenv("STRIPE_SUCCESS_URL", "https://agentverse.ai/payment-success")

    expires_in = max(1800, min(24 * 60 * 60, int(os.getenv("STRIPE_CHECKOUT_EXPIRES_SECONDS", "1800"))))
    expires_at = int(time.time()) + expires_in

    payment_reference = f"{user_address}:{chat_session_id}:{uuid4().hex[:8]}"
    return_url = (
        f"{success_url}?session_id={{CHECKOUT_SESSION_ID}}"
        f"&chat_session_id={chat_session_id}&user={user_address}"
    )
    if payment_request_id:
        return_url += f"&payment_request_id={payment_request_id}"

    line_items = (
        [{"price": price_id, "quantity": 1}]
        if price_id
        else [{
            "price_data": {
                "currency": currency,
                "product_data": {"name": product_name, "description": description},
                "unit_amount": amount_cents,
            },
            "quantity": 1,
        }]
    )

    idem_parts = [
        user_address,
        chat_session_id,
        payment_request_id or "",
        "price" if price_id else "inline",
        str(amount_cents),
    ]
    base_idempotency_key = ":".join(idem_parts)

    base_kwargs: dict[str, Any] = {
        "redirect_on_completion": "if_required",
        "payment_method_types": ["card"],
        "mode": "payment",
        "line_items": line_items,
        "return_url": return_url,
        "expires_at": expires_at,
        "metadata": {
            "user_address": user_address,
            "session_id": chat_session_id,
            "payment_reference": payment_reference,
        },
    }

    # Stripe API 2026-03-25 ("Dahlia") renamed ui_mode "embedded" -> "embedded_page".
    # Try the new value first; fall back to the legacy value if the account is pinned
    # to an older API version. Each attempt uses its own idempotency key so Stripe
    # doesn't replay a cached 400 from the first try.
    ui_mode_attempts = [
        ("embedded_page", base_idempotency_key + ":embedded_page"),
        ("embedded", base_idempotency_key + ":embedded"),
    ]
    last_error: str | None = None

    for ui_mode, idem_key in ui_mode_attempts:
        try:
            session = sdk.checkout.Session.create(
                ui_mode=ui_mode,
                idempotency_key=idem_key[:255],
                **base_kwargs,
            )
            return {
                "client_secret": session.client_secret,
                "id": session.id,
                "publishable_key": publishable,
                "amount_cents": amount_cents,
                "currency": currency,
                "ui_mode": ui_mode,
            }
        except sdk.error.InvalidRequestError as exc:
            err = str(exc).lower()
            last_error = str(exc)
            if "ui_mode" in err and (
                "no longer supported" in err
                or "invalid value" in err
                or "is not a valid" in err
            ):
                continue
            return {"error": str(exc)}
        except Exception as exc:
            return {"error": str(exc)}

    return {"error": last_error or "Could not create Checkout Session"}


def verify_checkout_session_paid(checkout_session_id: str) -> dict[str, Any]:
    sdk = _stripe_sdk()
    if not sdk:
        return {"verified": False, "error": "stripe SDK not installed"}
    secret = os.getenv("STRIPE_SECRET_KEY")
    if not secret:
        return {"verified": False, "error": "Stripe not configured"}
    sdk.api_key = secret
    try:
        s = sdk.checkout.Session.retrieve(checkout_session_id)
        metadata = stripe_metadata_to_dict(getattr(s, "metadata", {}) or {})
        return {
            "verified": getattr(s, "payment_status", None) == "paid",
            "checkout_session_id": checkout_session_id,
            "status": getattr(s, "payment_status", None),
            "amount_total": getattr(s, "amount_total", None),
            "currency": getattr(s, "currency", None),
            "metadata": metadata,
        }
    except Exception as exc:
        return {"verified": False, "error": str(exc)}

"""
utils.py — Shared helpers: time formatting, phone validation, message text builders.
"""

import re
from datetime import datetime, timezone, timedelta
from typing import Optional


PHONE_RE = re.compile(r"^\d{7,15}$")


def is_phone_number(text: str) -> bool:
    return bool(PHONE_RE.match(text.strip()))


def is_six_digits(text: str) -> bool:
    return bool(re.match(r"^\d{6}$", text.strip()))


def is_pairing_code(text: str) -> bool:
    """Accept 12345678 or 1234-5678."""
    clean = text.strip().replace("-", "")
    return bool(re.match(r"^\d{8}$", clean))


def clean_pairing_code(text: str) -> str:
    return text.strip().replace("-", "")


def format_wait(seconds: int) -> str:
    """
    Format seconds into compact human time.
    0 zero-units shown.
    Examples: 3600→1h, 300→5m, 30→30s, 7500→2h5m, 11150→3h5m50s
    """
    if seconds <= 0:
        return "0s"
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    parts = []
    if h:
        parts.append(f"{h}h")
    if m:
        parts.append(f"{m}m")
    if s:
        parts.append(f"{s}s")
    return "".join(parts) if parts else "0s"


def msg_processing(phone: str) -> str:
    return f"{phone} 🔵 Processing"

def msg_registered(phone: str) -> str:
    return f"{phone} 🟢 Registered"

def msg_already_registered(phone: str) -> str:
    return f"{phone} ⚪ Already Registered"

def msg_bad_number(phone: str) -> str:
    return f"{phone} ⚫ Bad Number"

def msg_error_code(phone: str) -> str:
    return f"{phone} 🔴 Error Code"

def msg_try_in(phone: str, seconds: int) -> str:
    return f"{phone} 🟡 Try in {format_wait(seconds)}"

def msg_pairing_request(phone: str) -> str:
    return f"{phone} waiting for pairing\nEnter code to link new device"

def msg_restricted(phone: str, seconds_remaining: int) -> str:
    return f"{phone} ⚠️ Restricted ({format_wait(seconds_remaining)} remaining)"

def msg_banned(phone: str) -> str:
    return f"{phone} 🚫 Banned"


def seconds_until(dt: datetime) -> int:
    if dt is None:
        return 0
    now = datetime.now(timezone.utc)
    delta = dt - now
    return max(0, int(delta.total_seconds()))


STATUS_EMOJI = {
    "REGISTERED":     "🕜 Awaiting Pairing",
    "AWAITING_PAIRING": "🕜 Awaiting Pairing",
    "PAIRED":         "✅ Successfully Paired",
    "RESTRICTED":     "⚠️ Restricted",
    "BANNED":         "🚫 Banned",
    "PROCESSING":     "🔵 Processing",
    "TIMEOUT":        "🟡 Timed Out",
}


def build_numbers_list(registrations: list) -> str:
    if not registrations:
        return "You have no registered numbers yet."
    lines = ["<b>Your registered numbers</b>\n"]
    from datetime import timezone as tz
    now = datetime.now(timezone.utc)
    for i, reg in enumerate(registrations, 1):
        phone = reg["phone_number"]
        status = reg["status"]
        if status == "PAIRED":
            n = reg.get("paired_devices", 0)
            label = f"✅ Successfully Paired ({n} device{'s' if n != 1 else ''})"
        elif status in ("REGISTERED", "AWAITING_PAIRING"):
            label = "🕜 Awaiting Pairing"
        elif status == "RESTRICTED":
            end = reg.get("restriction_ends_at")
            if end and end > now:
                remaining = int((end - now).total_seconds())
                label = f"⚠️ Restricted ({format_wait(remaining)} remaining)"
            else:
                label = "🕜 Awaiting Pairing"
        elif status == "BANNED":
            label = "🚫 Banned"
        else:
            label = STATUS_EMOJI.get(status, status)
        lines.append(f"{i}. <code>{phone}</code> - {label}")
    return "\n".join(lines)

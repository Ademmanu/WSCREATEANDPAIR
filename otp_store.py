"""
otp_store.py — Thread-safe in-memory OTP store with expiration.
bot.py writes OTPs here when users reply on Telegram.
wa_register.js polls GET /otp/{phone} to retrieve them.
"""

import asyncio
import logging
from typing import Optional
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

# phone_number → (otp, expires_at)
_store: dict = {}
_lock = asyncio.Lock()


async def put(phone: str, otp: str):
    """Store OTP with 15-minute expiration."""
    expires = datetime.now(timezone.utc) + timedelta(minutes=15)
    async with _lock:
        _store[phone] = (otp, expires)
    logger.info(f"OTP stored for {phone}: {otp}")


async def get_and_clear(phone: str) -> Optional[str]:
    """Retrieve and remove OTP if not expired."""
    async with _lock:
        if phone in _store:
            otp, expires = _store[phone]
            if datetime.now(timezone.utc) < expires:
                del _store[phone]
                logger.info(f"OTP retrieved and cleared for {phone}: {otp}")
                return otp
            else:
                # Expired
                del _store[phone]
                logger.warning(f"OTP expired for {phone}")
        return None


async def peek(phone: str) -> Optional[str]:
    """Check if OTP exists without removing it."""
    async with _lock:
        if phone in _store:
            otp, expires = _store[phone]
            if datetime.now(timezone.utc) < expires:
                return otp
            else:
                del _store[phone]
        return None


async def cleanup_expired():
    """Remove all expired OTPs (run periodically)."""
    now = datetime.now(timezone.utc)
    async with _lock:
        expired = [p for p, (_, exp) in _store.items() if now > exp]
        for phone in expired:
            del _store[phone]
    if expired:
        logger.info(f"Cleaned up {len(expired)} expired OTPs")

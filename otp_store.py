"""
otp_store.py — Thread-safe in-memory OTP store.
bot.py writes OTPs here when users reply on Telegram.
wa_register.js polls GET /otp/{phone} to retrieve them.
"""

import asyncio
from typing import Optional

# phone_number → otp string (consumed once)
_store: dict = {}
_lock = asyncio.Lock()


async def put(phone: str, otp: str):
    async with _lock:
        _store[phone] = otp


async def get_and_clear(phone: str) -> Optional[str]:
    async with _lock:
        return _store.pop(phone, None)


async def peek(phone: str) -> Optional[str]:
    async with _lock:
        return _store.get(phone)

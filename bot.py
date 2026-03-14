"""
bot.py — Telegram bot entry point.
Handles all user interactions: number submission, OTP replies,
pairing code replies, /numbers command, and webhook callbacks from GitHub Actions.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from aiohttp import web
from telegram import Update, Bot
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    filters, ContextTypes
)
from telegram.constants import ParseMode
from telegram.error import TelegramError

import db
import github_actions
import utils
import otp_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Suppress noisy loggers ────────────────────────────────────────────────────
# Render health checks, UptimeRobot pings, and Telegram long-poll are all
# expected and produce no useful signal — hide them.
logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("telegram.vendor.ptb_urllib3").setLevel(logging.WARNING)

class _HealthFilter(logging.Filter):
    """Drop /health GET log records from aiohttp.access."""
    def filter(self, record):
        return "/health" not in record.getMessage()

logging.getLogger("aiohttp.access").addFilter(_HealthFilter())

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]
RENDER_URL = os.environ.get("RENDER_EXTERNAL_URL", "")
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "changeme")

# ── Timeout tracker: {(user_id, phone): asyncio.Task} ────────────────────────
_otp_timers: dict = {}


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

async def safe_edit(bot: Bot, chat_id: int, message_id: int,
                    new_text: str, phone: str, user_id: int,
                    reason: str):
    """Edit a message and log the change."""
    # We need the old text — fetch from DB log or reconstruct from context
    # For simplicity we pass the old text via the callers who already know it.
    # This wrapper is called by callers who provide `before_text`.
    pass  # See edit_message_logged below


async def edit_message_logged(bot: Bot, chat_id: int, message_id: int,
                               before_text: str, after_text: str,
                               phone: str, user_id: int, reason: str):
    try:
        await bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=after_text,
            parse_mode=ParseMode.HTML,
        )
        await db.log_edit(phone, user_id, message_id, before_text, after_text, reason)
    except TelegramError as e:
        logger.warning(f"edit_message_logged failed for {phone}: {e}")


async def send_processing(bot: Bot, chat_id: int, phone: str) -> int:
    msg = await bot.send_message(
        chat_id=chat_id,
        text=utils.msg_processing(phone),
    )
    return msg.message_id


# ═══════════════════════════════════════════════════════════════════════════════
# OTP timeout task
# ═══════════════════════════════════════════════════════════════════════════════

async def _otp_timeout_task(bot: Bot, chat_id: int, user_id: int,
                              phone: str, otp_message_id: int,
                              before_text: str):
    """Waits 15 minutes then marks the number as timed out."""
    await asyncio.sleep(15 * 60)
    # Check if still awaiting (might have been resolved)
    reg = await db.get_registration(user_id, phone)
    if reg and reg["status"] == "AWAITING_OTP":
        after = utils.msg_try_in(phone, 600)
        await edit_message_logged(
            bot, chat_id, otp_message_id,
            before_text, after, phone, user_id,
            reason="15-minute OTP window expired"
        )
        await db.update_status(user_id, phone, "TIMEOUT")
        # Cancel the GitHub Actions run if still running
        if reg.get("github_run_id"):
            await github_actions.cancel_run(reg["github_run_id"])
    key = (user_id, phone)
    _otp_timers.pop(key, None)


def _cancel_otp_timer(user_id: int, phone: str):
    key = (user_id, phone)
    task = _otp_timers.pop(key, None)
    if task and not task.done():
        task.cancel()


def _start_otp_timer(bot: Bot, chat_id: int, user_id: int,
                      phone: str, otp_message_id: int, before_text: str):
    _cancel_otp_timer(user_id, phone)
    task = asyncio.create_task(
        _otp_timeout_task(bot, chat_id, user_id, phone, otp_message_id, before_text)
    )
    _otp_timers[(user_id, phone)] = task


# ═══════════════════════════════════════════════════════════════════════════════
# Telegram handlers
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg or not msg.text:
        return

    user_id = msg.from_user.id
    chat_id = msg.chat_id
    text = msg.text.strip()
    bot = context.bot

    # ── Case 1: reply to a bot message ──────────────────────────────────────
    if msg.reply_to_message:
        replied_id = msg.reply_to_message.message_id

        # Check if this is an OTP reply
        reg_otp = await db.get_registration_by_otp_msg(replied_id)
        if reg_otp and reg_otp["telegram_user_id"] == user_id:
            phone = reg_otp["phone_number"]

            # Validate 6 digits
            if not utils.is_six_digits(text):
                return  # silently ignore

            if reg_otp["status"] not in ("AWAITING_OTP", "ERROR_CODE"):
                return  # stale reply

            # Check not expired
            expires = reg_otp.get("otp_expires_at")
            if expires and datetime.now(timezone.utc) > expires:
                return  # already timed out

            # Forward OTP to session manager / GitHub Actions via HTTP
            success = await _send_otp_to_runner(
                reg_otp["github_run_id"], phone, text
            )
            # Actual result comes back via webhook; update status optimistically
            await db.update_status(user_id, phone, "OTP_SUBMITTED")
            return

        # Check if this is a pairing code reply
        reg_pair = await db.get_registration_by_pairing_msg(replied_id)
        if reg_pair and reg_pair["telegram_user_id"] == user_id:
            phone = reg_pair["phone_number"]
            if not utils.is_pairing_code(text):
                return  # silently ignore
            code = utils.clean_pairing_code(text)
            # Forward to session manager
            await _send_pairing_code(phone, code)
            return

        return  # reply to unknown message — ignore

    # ── Case 2: plain phone number ───────────────────────────────────────────
    if utils.is_phone_number(text):
        phone = text

        # Check for existing in-progress registration
        existing = await db.get_registration(user_id, phone)
        if existing and existing["status"] in ("PROCESSING", "AWAITING_OTP", "OTP_SUBMITTED"):
            await bot.send_message(chat_id, f"{phone} is already being processed.")
            return

        # Send first Processing message
        first_msg_id = await send_processing(bot, chat_id, phone)
        await db.upsert_registration(
            user_id, phone,
            status="PROCESSING",
            first_message_id=first_msg_id,
        )

        # Trigger GitHub Actions
        result = await github_actions.trigger_registration(
            phone, user_id, RENDER_URL
        )
        if not result:
            after = utils.msg_bad_number(phone)
            await edit_message_logged(
                bot, chat_id, first_msg_id,
                utils.msg_processing(phone), after,
                phone, user_id,
                reason="No GitHub Actions account available or dispatch failed"
            )
            await db.update_status(user_id, phone, "BAD_NUMBER")
            return

        await db.upsert_registration(
            user_id, phone,
            github_job_id=result["username"],
            github_run_id=result.get("run_id"),
        )
        return

    # Everything else — ignore silently


async def cmd_numbers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    regs = await db.get_all_registered(user_id)
    text = utils.build_numbers_list(regs)
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Send me a phone number (e.g. <code>2348012345678</code>) to register it on WhatsApp.\n\n"
        "Commands:\n"
        "/numbers — list all your registered numbers",
        parse_mode=ParseMode.HTML,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Internal helpers — communicate with session manager
# ═══════════════════════════════════════════════════════════════════════════════

async def _send_otp_to_runner(run_id: Optional[str], phone: str, otp: str) -> bool:
    """
    Store OTP so that wa_register.js can poll GET /otp/{phone} and retrieve it.
    """
    await otp_store.put(phone, otp)
    logger.info(f"[OTP_STORE] Stored OTP for {phone}")
    return True


async def _send_pairing_code(phone: str, code: str):
    import aiohttp
    url = f"http://localhost:{os.environ.get('NODE_PORT', 3001)}/pair"
    headers = {"x-api-key": INTERNAL_API_KEY}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, json={"phone": phone, "code": code},
                              headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as r:
                pass
    except Exception as e:
        logger.warning(f"Could not forward pairing code: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# Webhook server — receives callbacks from GitHub Actions & session_manager
# ═══════════════════════════════════════════════════════════════════════════════

def _verify_secret(request_secret: str) -> bool:
    expected = WEBHOOK_SECRET
    return hmac.compare_digest(request_secret, expected)


async def webhook_handler(request: web.Request) -> web.Response:
    secret = request.headers.get("X-Webhook-Secret", "")
    if not _verify_secret(secret):
        return web.Response(status=403, text="Forbidden")

    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="Bad JSON")

    event = data.get("event")
    phone = data.get("phone_number", "").strip()
    user_id = int(data.get("telegram_user_id", 0))

    bot: Bot = request.app["bot"]

    if not phone or not user_id:
        return web.Response(status=400, text="Missing fields")

    reg = await db.get_registration(user_id, phone)
    if not reg:
        return web.Response(status=404, text="Registration not found")

    chat_id = user_id  # Telegram user_id == chat_id for private chats

    # ── OTP requested (send second Processing message) ──────────────────────
    if event == "otp_requested":
        otp_msg_id = await send_processing(bot, chat_id, phone)
        expires = datetime.now(timezone.utc) + timedelta(minutes=15)
        await db.upsert_registration(
            user_id, phone,
            status="AWAITING_OTP",
            otp_message_id=otp_msg_id,
            otp_expires_at=expires,
            github_run_id=data.get("run_id", reg.get("github_run_id")),
        )
        _start_otp_timer(
            bot, chat_id, user_id, phone, otp_msg_id,
            utils.msg_processing(phone)
        )

    # ── Registered successfully ──────────────────────────────────────────────
    elif event == "registered":
        _cancel_otp_timer(user_id, phone)
        otp_msg_id = reg.get("otp_message_id") or reg.get("first_message_id")
        before = utils.msg_processing(phone)
        after = utils.msg_registered(phone)
        await edit_message_logged(bot, chat_id, otp_msg_id, before, after,
                                   phone, user_id, "OTP accepted, WhatsApp registration complete")
        await db.update_status(user_id, phone, "REGISTERED")

    # ── OTP wrong ────────────────────────────────────────────────────────────
    elif event == "otp_error":
        otp_msg_id = reg.get("otp_message_id")
        if otp_msg_id:
            before = utils.msg_processing(phone)
            after = utils.msg_error_code(phone)
            await edit_message_logged(bot, chat_id, otp_msg_id, before, after,
                                       phone, user_id, "Invalid OTP entered")
            await db.update_status(user_id, phone, "ERROR_CODE")

    # ── Already registered ───────────────────────────────────────────────────
    elif event == "already_registered":
        first_msg_id = reg.get("first_message_id")
        before = utils.msg_processing(phone)
        after = utils.msg_already_registered(phone)
        await edit_message_logged(bot, chat_id, first_msg_id, before, after,
                                   phone, user_id,
                                   "WhatsApp reports number already registered")
        await db.update_status(user_id, phone, "ALREADY_REGISTERED")

    # ── Bad number ───────────────────────────────────────────────────────────
    elif event == "bad_number":
        reason = data.get("reason", "unknown")
        msg_id = reg.get("otp_message_id") or reg.get("first_message_id")
        before = utils.msg_processing(phone)
        after = utils.msg_bad_number(phone)
        await edit_message_logged(bot, chat_id, msg_id, before, after,
                                   phone, user_id, f"Bad number — {reason}")
        await db.update_status(user_id, phone, "BAD_NUMBER")

    # ── Rate limited ─────────────────────────────────────────────────────────
    elif event == "rate_limited":
        wait_seconds = int(data.get("wait_seconds", 600))
        first_msg_id = reg.get("first_message_id")
        before = utils.msg_processing(phone)
        after = utils.msg_try_in(phone, wait_seconds)
        await edit_message_logged(bot, chat_id, first_msg_id, before, after,
                                   phone, user_id,
                                   f"WhatsApp rate limit, wait {wait_seconds}s")
        await db.update_status(user_id, phone, "RATE_LIMITED")

    # ── Pairing requested (session manager event) ────────────────────────────
    elif event == "pairing_requested":
        pair_msg = await bot.send_message(
            chat_id=chat_id,
            text=utils.msg_pairing_request(phone),
        )
        await db.upsert_registration(
            user_id, phone,
            status="AWAITING_PAIRING",
            pairing_message_id=pair_msg.message_id,
        )

    # ── Pairing success ──────────────────────────────────────────────────────
    elif event == "paired":
        devices = int(data.get("devices", 1))
        await db.upsert_registration(user_id, phone,
                                      status="PAIRED", paired_devices=devices)

    # ── Account restricted ───────────────────────────────────────────────────
    elif event == "restricted":
        seconds_remaining = int(data.get("seconds_remaining", 0))
        restriction_ends = datetime.now(timezone.utc) + timedelta(seconds=seconds_remaining)
        await db.upsert_registration(user_id, phone,
                                      status="RESTRICTED",
                                      restriction_ends_at=restriction_ends)
        await bot.send_message(
            chat_id=chat_id,
            text=utils.msg_restricted(phone, seconds_remaining),
        )

    # ── Account banned ───────────────────────────────────────────────────────
    elif event == "banned":
        await db.update_status(user_id, phone, "BANNED")
        await bot.send_message(chat_id=chat_id, text=utils.msg_banned(phone))

    # ── Session data update (save serialized WA session) ────────────────────
    elif event == "session_update":
        session_data = data.get("session_data")
        if session_data:
            await db.upsert_registration(user_id, phone, session_data=session_data)

    else:
        return web.Response(status=400, text=f"Unknown event: {event}")

    return web.Response(status=200, text="OK")


async def otp_poll_handler(request: web.Request) -> web.Response:
    """Called by wa_register.js to retrieve the OTP once the user replies on Telegram."""
    secret = request.headers.get("X-Webhook-Secret", "")
    if not _verify_secret(secret):
        return web.Response(status=403, text="Forbidden")
    phone = request.match_info.get("phone", "")
    otp = await otp_store.get_and_clear(phone)
    if otp:
        return web.Response(status=200, text=otp)
    return web.Response(status=204, text="")  # not ready yet


async def health_handler(request: web.Request) -> web.Response:
    return web.Response(status=200, text="OK")


# ═══════════════════════════════════════════════════════════════════════════════
# Startup / main
# ═══════════════════════════════════════════════════════════════════════════════

async def restore_sessions(bot: Bot):
    """On startup, tell session_manager to reload all active WA sessions."""
    import aiohttp
    sessions = await db.get_all_active_sessions()
    if not sessions:
        return
    url = f"http://localhost:{os.environ.get('NODE_PORT', 3001)}/restore"
    headers = {"x-api-key": INTERNAL_API_KEY}
    payload = [
        {"phone": s["phone_number"], "session": s["session_data"]}
        for s in sessions if s.get("session_data")
    ]
    if not payload:
        return
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, json=payload, headers=headers,
                              timeout=aiohttp.ClientTimeout(total=30)) as r:
                logger.info(f"Restored {len(payload)} WA sessions, status={r.status}")
    except Exception as e:
        logger.warning(f"Session restore failed: {e}")


async def seed_github_from_env():
    raw = os.environ.get("GITHUB_ACCOUNTS_JSON", "[]")
    try:
        accounts = json.loads(raw)
        if accounts:
            await db.seed_github_accounts(accounts)
    except Exception as e:
        logger.error(f"Failed to seed GitHub accounts: {e}")


async def main():
    await db.init_db()
    await seed_github_from_env()

    app_builder = (
        Application.builder()
        .token(BOT_TOKEN)
        .build()
    )
    application = app_builder

    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("numbers", cmd_numbers))
    application.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
    )

    bot = application.bot
    await restore_sessions(bot)

    # Aiohttp webhook server
    web_app = web.Application()
    web_app["bot"] = bot
    web_app.router.add_post("/webhook/event", webhook_handler)
    web_app.router.add_get("/otp/{phone}", otp_poll_handler)
    web_app.router.add_get("/health", health_handler)

    port = int(os.environ.get("PORT", 8080))

    runner = web.AppRunner(web_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info(f"Webhook server running on port {port}")

    # ── Kill any stale polling session before starting ───────────────────────
    # Render keeps the old container alive briefly during redeployment.
    # Calling deleteWebhook with drop_pending_updates forces Telegram to
    # terminate any existing getUpdates session, then we wait a few seconds
    # for the old container to fully stop before starting our own poll.
    await application.initialize()
    try:
        await application.bot.delete_webhook(drop_pending_updates=True)
        logger.info("Cleared any existing Telegram webhook/polling session")
    except Exception as e:
        logger.warning(f"delete_webhook failed (non-fatal): {e}")

    logger.info("Waiting 8s for old container to terminate before polling...")
    await asyncio.sleep(8)

    await application.start()
    await application.updater.start_polling(
        drop_pending_updates=True,
        allowed_updates=["message"],
        # Use a longer timeout so the connection stays open longer,
        # reducing the polling frequency and log noise
        timeout=30,
        read_timeout=30,
        write_timeout=30,
        connect_timeout=30,
        pool_timeout=30,
    )
    logger.info("Bot polling started")

    # Keep running
    try:
        await asyncio.Event().wait()
    finally:
        await application.updater.stop()
        await application.stop()
        await application.shutdown()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

"""
bot.py — Telegram bot entry point.
Handles all user interactions: number submission, OTP replies,
pairing code replies, /numbers command, and webhook callbacks from session_manager.

Changes from GitHub Actions version:
  - github_actions.py is no longer imported or used
  - trigger_registration() now calls session_manager POST /register directly
  - Everything else (OTP store, webhook handler, Telegram polling) is unchanged
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiohttp
from aiohttp import web
from telegram import Update, Bot
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    filters, ContextTypes
)
from telegram.constants import ParseMode
from telegram.error import TelegramError

import db
import utils
import otp_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("telegram.vendor.ptb_urllib3").setLevel(logging.WARNING)

class _HealthFilter(logging.Filter):
    def filter(self, record):
        return "/health" not in record.getMessage()

logging.getLogger("aiohttp.access").addFilter(_HealthFilter())

BOT_TOKEN        = os.environ["TELEGRAM_BOT_TOKEN"]
WEBHOOK_SECRET   = os.environ["WEBHOOK_SECRET"]
RENDER_URL       = os.environ.get("RENDER_EXTERNAL_URL", "")
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "changeme")
NODE_PORT        = int(os.environ.get("NODE_PORT", 3001))

_otp_timers: dict = {}


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

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
# OTP timeout task  (unchanged)
# ═══════════════════════════════════════════════════════════════════════════════

async def _otp_timeout_task(bot: Bot, chat_id: int, user_id: int,
                              phone: str, otp_message_id: int,
                              before_text: str):
    await asyncio.sleep(15 * 60)
    reg = await db.get_registration(user_id, phone)
    if reg and reg["status"] == "AWAITING_OTP":
        after = utils.msg_try_in(phone, 600)
        await edit_message_logged(
            bot, chat_id, otp_message_id,
            before_text, after, phone, user_id,
            reason="15-minute OTP window expired"
        )
        await db.update_status(user_id, phone, "TIMEOUT")
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
# ★ NEW: trigger registration via session_manager (replaces github_actions.py)
# ═══════════════════════════════════════════════════════════════════════════════

async def trigger_registration(phone: str, user_id: int) -> bool:
    """
    Call session_manager POST /register to start Baileys registration.
    Returns True if the request was accepted, False on failure.
    session_manager fires all subsequent webhooks (otp_requested, registered, etc.)
    """
    url = f"http://localhost:{NODE_PORT}/register"
    headers = {"x-api-key": INTERNAL_API_KEY}
    payload = {
        "phone":            phone,
        "telegram_user_id": user_id,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url, json=payload, headers=headers,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status == 200:
                    logger.info(f"[REGISTER] Baileys registration started for {phone}")
                    return True
                elif resp.status == 409:
                    logger.warning(f"[REGISTER] Already in progress for {phone}")
                    return True  # treat as accepted
                else:
                    text = await resp.text()
                    logger.error(f"[REGISTER] session_manager returned {resp.status}: {text}")
                    return False
    except Exception as e:
        logger.error(f"[REGISTER] Could not reach session_manager for {phone}: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════════════════
# Telegram handlers
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg or not msg.text:
        return

    user_id = msg.from_user.id
    chat_id = msg.chat_id
    text    = msg.text.strip()
    bot     = context.bot

    # ── Reply to a bot message ───────────────────────────────────────────────
    if msg.reply_to_message:
        replied_id = msg.reply_to_message.message_id

        reg_otp = await db.get_registration_by_otp_msg(replied_id)
        if reg_otp and reg_otp["telegram_user_id"] == user_id:
            phone = reg_otp["phone_number"]
            if not utils.is_six_digits(text):
                return
            if reg_otp["status"] not in ("AWAITING_OTP", "ERROR_CODE"):
                return
            expires = reg_otp.get("otp_expires_at")
            if expires and datetime.now(timezone.utc) > expires:
                return
            # Store OTP — session_manager polls GET /otp/{phone}
            await otp_store.put(phone, text)
            logger.info(f"[OTP_STORE] Stored OTP for {phone}")
            await db.update_status(user_id, phone, "OTP_SUBMITTED")
            return

        reg_pair = await db.get_registration_by_pairing_msg(replied_id)
        if reg_pair and reg_pair["telegram_user_id"] == user_id:
            phone = reg_pair["phone_number"]
            if not utils.is_pairing_code(text):
                return
            # Pairing not used in Baileys mobile flow — kept for compatibility
            return

        return

    # ── Plain phone number ───────────────────────────────────────────────────
    if utils.is_phone_number(text):
        phone = text

        existing = await db.get_registration(user_id, phone)
        if existing and existing["status"] in ("PROCESSING", "AWAITING_OTP", "OTP_SUBMITTED"):
            await bot.send_message(chat_id, f"{phone} is already being processed.")
            return

        first_msg_id = await send_processing(bot, chat_id, phone)
        await db.upsert_registration(
            user_id, phone,
            status="PROCESSING",
            first_message_id=first_msg_id,
        )

        # ── Trigger Baileys registration (replaces GitHub Actions dispatch) ──
        ok = await trigger_registration(phone, user_id)
        if not ok:
            after = utils.msg_bad_number(phone)
            await edit_message_logged(
                bot, chat_id, first_msg_id,
                utils.msg_processing(phone), after,
                phone, user_id,
                reason="session_manager unreachable or refused registration"
            )
            await db.update_status(user_id, phone, "BAD_NUMBER")
        return


async def cmd_numbers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    regs    = await db.get_all_registered(user_id)
    text    = utils.build_numbers_list(regs)
    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Send me a phone number (e.g. <code>2348012345678</code>) to register it on WhatsApp.\n\n"
        "Commands:\n"
        "/numbers — list all your registered numbers",
        parse_mode=ParseMode.HTML,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Webhook server  (receives callbacks from session_manager — unchanged surface)
# ═══════════════════════════════════════════════════════════════════════════════

def _verify_secret(s: str) -> bool:
    return hmac.compare_digest(s, WEBHOOK_SECRET)


async def webhook_handler(request: web.Request) -> web.Response:
    secret = request.headers.get("X-Webhook-Secret", "")
    if not _verify_secret(secret):
        return web.Response(status=403, text="Forbidden")
    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="Bad JSON")

    event   = data.get("event")
    phone   = data.get("phone_number", "").strip()
    user_id = int(data.get("telegram_user_id", 0))
    bot: Bot = request.app["bot"]

    if not phone or not user_id:
        return web.Response(status=400, text="Missing fields")

    reg = await db.get_registration(user_id, phone)
    if not reg:
        return web.Response(status=404, text="Registration not found")

    chat_id = user_id  # private chat

    # ── otp_requested ────────────────────────────────────────────────────────
    if event == "otp_requested":
        otp_msg_id = await send_processing(bot, chat_id, phone)
        expires    = datetime.now(timezone.utc) + timedelta(minutes=15)
        await db.upsert_registration(
            user_id, phone,
            status="AWAITING_OTP",
            otp_message_id=otp_msg_id,
            otp_expires_at=expires,
        )
        _start_otp_timer(
            bot, chat_id, user_id, phone, otp_msg_id,
            utils.msg_processing(phone)
        )

    # ── registered ───────────────────────────────────────────────────────────
    elif event == "registered":
        _cancel_otp_timer(user_id, phone)
        msg_id = reg.get("otp_message_id") or reg.get("first_message_id")
        await edit_message_logged(
            bot, chat_id, msg_id,
            utils.msg_processing(phone), utils.msg_registered(phone),
            phone, user_id, "OTP accepted — WhatsApp registration complete"
        )
        await db.update_status(user_id, phone, "REGISTERED")

        session_data = data.get("session_data")
        if session_data:
            await db.upsert_registration(user_id, phone, session_data=session_data)

    # ── otp_error ────────────────────────────────────────────────────────────
    elif event == "otp_error":
        otp_msg_id = reg.get("otp_message_id")
        if otp_msg_id:
            await edit_message_logged(
                bot, chat_id, otp_msg_id,
                utils.msg_processing(phone), utils.msg_error_code(phone),
                phone, user_id, "Invalid OTP"
            )
            await db.update_status(user_id, phone, "ERROR_CODE")

    # ── already_registered ───────────────────────────────────────────────────
    elif event == "already_registered":
        msg_id = reg.get("first_message_id")
        await edit_message_logged(
            bot, chat_id, msg_id,
            utils.msg_processing(phone), utils.msg_already_registered(phone),
            phone, user_id, "Number already has a WhatsApp account"
        )
        await db.update_status(user_id, phone, "ALREADY_REGISTERED")

    # ── bad_number ───────────────────────────────────────────────────────────
    elif event == "bad_number":
        reason = data.get("reason", "unknown")
        msg_id = reg.get("otp_message_id") or reg.get("first_message_id")
        logger.error(f"[BAD_NUMBER] {phone} — {reason}")
        await edit_message_logged(
            bot, chat_id, msg_id,
            utils.msg_processing(phone), utils.msg_bad_number(phone),
            phone, user_id, f"Bad number — {reason}"
        )
        await db.update_status(user_id, phone, "BAD_NUMBER")

    # ── rate_limited ─────────────────────────────────────────────────────────
    elif event == "rate_limited":
        wait_seconds = int(data.get("wait_seconds", 600))
        msg_id = reg.get("first_message_id")
        await edit_message_logged(
            bot, chat_id, msg_id,
            utils.msg_processing(phone), utils.msg_try_in(phone, wait_seconds),
            phone, user_id, f"WhatsApp rate limit — wait {wait_seconds}s"
        )
        await db.update_status(user_id, phone, "RATE_LIMITED")

    # ── restricted ───────────────────────────────────────────────────────────
    elif event == "restricted":
        secs = int(data.get("seconds_remaining", 0))
        ends = datetime.now(timezone.utc) + timedelta(seconds=secs)
        await db.upsert_registration(user_id, phone,
                                      status="RESTRICTED",
                                      restriction_ends_at=ends)
        await bot.send_message(chat_id, utils.msg_restricted(phone, secs))

    # ── banned ────────────────────────────────────────────────────────────────
    elif event == "banned":
        await db.update_status(user_id, phone, "BANNED")
        await bot.send_message(chat_id, utils.msg_banned(phone))

    # ── session_update ────────────────────────────────────────────────────────
    elif event == "session_update":
        session_data = data.get("session_data")
        if session_data:
            await db.upsert_registration(user_id, phone, session_data=session_data)

    else:
        return web.Response(status=400, text=f"Unknown event: {event}")

    return web.Response(status=200, text="OK")


async def otp_poll_handler(request: web.Request) -> web.Response:
    """Called by wa_register_baileys.js to retrieve the OTP once the user replies."""
    secret = request.headers.get("X-Webhook-Secret", "")
    if not _verify_secret(secret):
        return web.Response(status=403, text="Forbidden")
    phone = request.match_info.get("phone", "")
    otp   = await otp_store.get_and_clear(phone)
    if otp:
        return web.Response(status=200, text=otp)
    return web.Response(status=204, text="")


async def health_handler(request: web.Request) -> web.Response:
    return web.Response(status=200, text="OK")


# ═══════════════════════════════════════════════════════════════════════════════
# Startup
# ═══════════════════════════════════════════════════════════════════════════════

async def restore_sessions(bot: Bot):
    """Tell session_manager to reload all active WA sessions from the DB."""
    sessions = await db.get_all_active_sessions()
    if not sessions:
        return
    url     = f"http://localhost:{NODE_PORT}/restore"
    headers = {"x-api-key": INTERNAL_API_KEY}
    payload = [
        {"phone": s["phone_number"], "user_id": s["telegram_user_id"], "session": s["session_data"]}
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


async def main():
    await db.init_db()

    app_builder = Application.builder().token(BOT_TOKEN).build()
    application = app_builder

    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("numbers", cmd_numbers))
    application.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
    )

    bot = application.bot
    await restore_sessions(bot)

    web_app = web.Application()
    web_app["bot"] = bot
    web_app.router.add_post("/webhook/event", webhook_handler)
    web_app.router.add_get("/otp/{phone}",    otp_poll_handler)
    web_app.router.add_get("/health",         health_handler)

    port   = int(os.environ.get("PORT", 8080))
    runner = web.AppRunner(web_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info(f"Webhook server running on port {port}")

    await application.initialize()
    try:
        await application.bot.delete_webhook(drop_pending_updates=True)
    except Exception as e:
        logger.warning(f"delete_webhook failed (non-fatal): {e}")

    logger.info("Waiting 100s for old container to terminate before polling...")
    await asyncio.sleep(100)

    await application.start()
    await application.updater.start_polling(
        drop_pending_updates=True,
        allowed_updates=["message"],
        timeout=30,
        read_timeout=30,
        write_timeout=30,
        connect_timeout=30,
        pool_timeout=30,
    )
    logger.info("Bot polling started")

    try:
        await asyncio.Event().wait()
    finally:
        await application.updater.stop()
        await application.stop()
        await application.shutdown()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

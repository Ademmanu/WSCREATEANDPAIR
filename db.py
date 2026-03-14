"""
db.py — PostgreSQL database layer using asyncpg
All sessions, registrations, GitHub accounts, and edit logs live here.
"""

import asyncpg
import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=os.environ["DATABASE_URL"],
            min_size=2,
            max_size=10,
            statement_cache_size=0,  # Required for PgBouncer / Aiven
        )
    return _pool


async def init_db():
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS registrations (
                id SERIAL PRIMARY KEY,
                telegram_user_id BIGINT NOT NULL,
                phone_number TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PROCESSING',
                first_message_id BIGINT,
                otp_message_id BIGINT,
                pairing_message_id BIGINT,
                session_data JSONB,
                paired_devices INT NOT NULL DEFAULT 0,
                restriction_ends_at TIMESTAMPTZ,
                retry_after TIMESTAMPTZ,
                github_job_id TEXT,
                github_run_id TEXT,
                otp_expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(telegram_user_id, phone_number)
            );

            CREATE TABLE IF NOT EXISTS github_accounts (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                token TEXT NOT NULL,
                minutes_used REAL NOT NULL DEFAULT 0,
                month_reset_at TIMESTAMPTZ NOT NULL DEFAULT DATE_TRUNC('month', NOW()),
                is_active BOOLEAN NOT NULL DEFAULT TRUE
            );

            CREATE TABLE IF NOT EXISTS message_edit_log (
                id SERIAL PRIMARY KEY,
                phone_number TEXT NOT NULL,
                telegram_user_id BIGINT NOT NULL,
                message_id BIGINT NOT NULL,
                before_text TEXT NOT NULL,
                after_text TEXT NOT NULL,
                reason TEXT NOT NULL,
                edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_reg_user_phone
                ON registrations(telegram_user_id, phone_number);
            CREATE INDEX IF NOT EXISTS idx_reg_status
                ON registrations(status);
            CREATE INDEX IF NOT EXISTS idx_reg_otp_msg
                ON registrations(otp_message_id);
            CREATE INDEX IF NOT EXISTS idx_log_phone
                ON message_edit_log(phone_number);
        """)
    logger.info("Database schema initialised")


# ── Registrations ──────────────────────────────────────────────────────────────

async def upsert_registration(telegram_user_id: int, phone_number: str, **kwargs):
    pool = await get_pool()

    # Always strip updated_at from kwargs — the SQL hardcodes NOW() for it.
    # Having it in both kwargs and the trailing ", updated_at = NOW()" causes
    # "multiple assignments to same column" PostgresSyntaxError.
    kwargs.pop("updated_at", None)

    if not kwargs:
        # Nothing to update beyond the conflict — just ensure row exists
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO registrations (telegram_user_id, phone_number)
                   VALUES ($1, $2)
                   ON CONFLICT (telegram_user_id, phone_number) DO UPDATE
                   SET updated_at = NOW()""",
                telegram_user_id, phone_number
            )
        return

    # Build parameterised query: $1=user_id, $2=phone, $3..=kwargs values
    set_clauses = ", ".join(f"{k} = ${i+3}" for i, k in enumerate(kwargs))
    values = [telegram_user_id, phone_number] + list(kwargs.values())
    cols = ", ".join(["telegram_user_id", "phone_number"] + list(kwargs.keys()))
    placeholders = ", ".join(f"${i+1}" for i in range(len(values)))
    sql = f"""
        INSERT INTO registrations ({cols}, updated_at)
        VALUES ({placeholders}, NOW())
        ON CONFLICT (telegram_user_id, phone_number)
        DO UPDATE SET {set_clauses}, updated_at = NOW()
    """
    async with pool.acquire() as conn:
        await conn.execute(sql, *values)


async def get_registration(telegram_user_id: int, phone_number: str) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM registrations WHERE telegram_user_id=$1 AND phone_number=$2",
            telegram_user_id, phone_number
        )
    return dict(row) if row else None


async def get_registration_by_otp_msg(otp_message_id: int) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM registrations WHERE otp_message_id=$1",
            otp_message_id
        )
    return dict(row) if row else None


async def get_registration_by_pairing_msg(pairing_message_id: int) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM registrations WHERE pairing_message_id=$1",
            pairing_message_id
        )
    return dict(row) if row else None


async def get_all_registered(telegram_user_id: int) -> list:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT * FROM registrations
               WHERE telegram_user_id=$1
               AND status IN ('REGISTERED','PAIRED','RESTRICTED','AWAITING_PAIRING','BANNED')
               ORDER BY created_at ASC""",
            telegram_user_id
        )
    return [dict(r) for r in rows]


async def get_all_active_sessions() -> list:
    """Load all sessions that need to be kept alive after bot restart."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT * FROM registrations
               WHERE status IN ('REGISTERED','PAIRED','RESTRICTED','AWAITING_PAIRING')
               AND session_data IS NOT NULL"""
        )
    return [dict(r) for r in rows]


async def update_status(telegram_user_id: int, phone_number: str, status: str, **extra):
    await upsert_registration(telegram_user_id, phone_number, status=status, **extra)


# ── GitHub accounts ────────────────────────────────────────────────────────────

async def get_next_github_account() -> Optional[dict]:
    """Return the GitHub account with the most remaining minutes this month."""
    pool = await get_pool()
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        # Reset monthly counters if needed
        await conn.execute(
            """UPDATE github_accounts
               SET minutes_used = 0, month_reset_at = DATE_TRUNC('month', NOW())
               WHERE month_reset_at < DATE_TRUNC('month', NOW())"""
        )
        row = await conn.fetchrow(
            """SELECT * FROM github_accounts
               WHERE is_active = TRUE AND minutes_used < 1990
               ORDER BY minutes_used ASC
               LIMIT 1"""
        )
    return dict(row) if row else None


async def add_github_minutes(username: str, minutes: float):
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE github_accounts SET minutes_used = minutes_used + $1 WHERE username = $2",
            minutes, username
        )


async def seed_github_accounts(accounts: list):
    """accounts = [{"username": "...", "token": "ghp_..."}]"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        for acc in accounts:
            await conn.execute(
                """INSERT INTO github_accounts (username, token)
                   VALUES ($1, $2)
                   ON CONFLICT (username) DO UPDATE SET token = $2, is_active = TRUE""",
                acc["username"], acc["token"]
            )
    logger.info(f"Seeded {len(accounts)} GitHub accounts")


# ── Edit log ───────────────────────────────────────────────────────────────────

async def log_edit(phone_number: str, telegram_user_id: int, message_id: int,
                   before_text: str, after_text: str, reason: str):
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO message_edit_log
               (phone_number, telegram_user_id, message_id, before_text, after_text, reason)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            phone_number, telegram_user_id, message_id, before_text, after_text, reason
        )
    logger.info(
        f"[EDIT] {phone_number} | msg_id={message_id} | "
        f"Before: \"{before_text}\" | After: \"{after_text}\" | Reason: {reason}"
    )

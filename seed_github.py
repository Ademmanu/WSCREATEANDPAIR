"""
seed_github.py
Run this ONCE (locally or on Render shell) to add GitHub accounts to the DB.

Usage:
  DATABASE_URL="postgresql://..." python seed_github.py

You can also run it again to add more accounts — existing ones are updated.
"""

import asyncio
import os
import sys
import asyncpg


ACCOUNTS = [
    # Add as many as you like.
    # Get token from: GitHub → Settings → Developer settings →
    #   Personal access tokens → Tokens (classic) → Generate new token
    #   Scopes needed: repo, workflow
    {"username": "your_github_username_1", "token": "ghp_xxxxxxxxxxxxxxxxxxxx"},
    {"username": "your_github_username_2", "token": "ghp_yyyyyyyyyyyyyyyyyyyy"},
    # {"username": "account3", "token": "ghp_zzz..."},
]


async def seed():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: Set DATABASE_URL environment variable first.")
        sys.exit(1)

    conn = await asyncpg.connect(dsn)
    for acc in ACCOUNTS:
        await conn.execute(
            """INSERT INTO github_accounts (username, token)
               VALUES ($1, $2)
               ON CONFLICT (username) DO UPDATE SET token = $2, is_active = TRUE""",
            acc["username"], acc["token"]
        )
        print(f"  ✓ Seeded account: {acc['username']}")

    rows = await conn.fetch("SELECT username, minutes_used, is_active FROM github_accounts")
    print(f"\nAll GitHub accounts in DB ({len(rows)} total):")
    for r in rows:
        status = "✅ active" if r["is_active"] else "❌ disabled"
        print(f"  {r['username']} — {r['minutes_used']:.1f} min used — {status}")

    await conn.close()


asyncio.run(seed())

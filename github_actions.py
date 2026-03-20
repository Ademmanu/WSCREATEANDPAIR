"""
github_actions.py — Trigger GitHub Actions workflows and manage account rotation.
Each registration dispatches a workflow_dispatch event to the repo.
"""

import aiohttp
import asyncio
import json
import logging
import os
from typing import Optional

import db

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
WORKFLOW_FILE = "register.yml"


async def trigger_registration(phone_number: str, telegram_user_id: int,
                                webhook_base: str) -> Optional[dict]:
    """
    Pick the next available GitHub account, trigger the workflow,
    return {"username": ..., "run_id": ...} or None on failure.
    """
    account = await db.get_next_github_account()
    if not account:
        logger.error("No GitHub accounts with remaining minutes available")
        return None

    repo = os.environ.get("GITHUB_REPO")  # e.g. "myuser/wa-emulator"
    token = account["token"]
    username = account["username"]

    payload = {
        "ref": "main",
        "inputs": {
            "phone_number": phone_number,
            "telegram_user_id": str(telegram_user_id),
            "webhook_url": webhook_base,
            "webhook_secret": os.environ["WEBHOOK_SECRET"],
        }
    }

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    url = f"{GITHUB_API}/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/dispatches"

    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload, headers=headers) as resp:
            if resp.status == 204:
                logger.info(f"Workflow dispatched via {username} for {phone_number}")
                # Fetch the run_id of the job we just started
                await asyncio.sleep(4)
                run_id = await _get_latest_run_id(session, repo, token, phone_number)
                # Charge 5 minutes speculatively; actual usage tracked via webhook
                await db.add_github_minutes(username, 5)
                return {"username": username, "run_id": run_id}
            else:
                text = await resp.text()
                logger.error(f"GitHub dispatch failed [{resp.status}]: {text}")
                return None


async def cancel_run(run_id: str):
    """Cancel a running workflow (e.g. on OTP timeout)."""
    account = await db.get_next_github_account()
    if not account:
        return
    repo = os.environ.get("GITHUB_REPO")
    token = account["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}/cancel"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers) as resp:
            if resp.status in (202, 409):
                logger.info(f"Cancelled run {run_id}")
            else:
                logger.warning(f"Could not cancel run {run_id}: {resp.status}")


async def _get_latest_run_id(session: aiohttp.ClientSession, repo: str,
                              token: str, phone_number: str) -> Optional[str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = f"{GITHUB_API}/repos/{repo}/actions/runs?per_page=5&event=workflow_dispatch"
    async with session.get(url, headers=headers) as resp:
        if resp.status == 200:
            data = await resp.json()
            runs = data.get("workflow_runs", [])
            if runs:
                return str(runs[0]["id"])
    return None

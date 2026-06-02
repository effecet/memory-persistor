#!/usr/bin/env python3
"""
events_canary.py — alert when the events pipeline goes silent.

Queries ``MAX(events.created_at)`` and compares against a freshness threshold.
Events are a fire-and-forget log, so a broken insert pipeline produces no
error — just an ever-older last-event timestamp. This canary surfaces that.

Exit codes (so systemd / cron can consume the result directly):
    0  events are fresh (or table empty with --allow-empty)
    1  events are stale (last entry older than threshold)
    2  unexpected error (DB down, schema mismatch, etc.)

crafted by effece 🧉
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

DEFAULT_THRESHOLD_HOURS = 24

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
COMPOSE_FILE = PROJECT_DIR / "docker-compose.yml"


# ── config ───────────────────────────────────────────────────────────────────


def get_database_url() -> str:
    """Read DATABASE_URL from env, .env.supabase, or .env (in that order)."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url

    for filename in (".env.supabase", ".env"):
        env_file = PROJECT_DIR / filename
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")

    raise RuntimeError("DATABASE_URL not found in environment, .env.supabase, or .env")


def _is_local(url: str) -> bool:
    """Heuristic: does DATABASE_URL point at the local Docker instance?"""
    return "localhost" in url or "127.0.0.1" in url


def run_psql(query: str) -> str:
    """Execute a psql query.

    Routing:
      - If psql is on PATH → use it with DATABASE_URL directly. Works for both
        local and remote.
      - Otherwise and DATABASE_URL is local → fall back to the Docker postgres
        container. Legitimate path for Mac devs who don't have libpq installed.
      - Otherwise and DATABASE_URL is REMOTE → raise loudly. Do NOT silently
        query the Docker container — that reproduces the exact silent-misroute
        bug this canary is meant to detect (2026-04-07 → 2026-04-13 incident).
    """
    database_url = get_database_url()

    if shutil.which("psql"):
        result = subprocess.run(
            ["psql", database_url, "-t", "-A", "-c", query],
            capture_output=True,
            text=True,
            timeout=30,
        )
    elif _is_local(database_url):
        result = subprocess.run(
            [
                "docker",
                "compose",
                "-f",
                str(COMPOSE_FILE),
                "exec",
                "-T",
                "postgres",
                "psql",
                "-U",
                "postgres",
                "-d",
                "memory_persistor",
                "-t",
                "-A",
                "-c",
                query,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    else:
        raise RuntimeError(
            "DATABASE_URL points at a remote host but `psql` is not on PATH. "
            "Install libpq (`brew install libpq && brew link --force libpq`) "
            "so the remote canary can actually query the remote DB. "
            "Refusing to fall back to Docker — that would mask the silent "
            "misroute the canary exists to detect."
        )

    if result.returncode != 0:
        raise RuntimeError(f"psql error: {result.stderr.strip()}")
    return result.stdout.strip()


# ── canary logic ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CanaryResult:
    last_event: Optional[datetime]
    age_hours: Optional[float]
    threshold_hours: float
    is_stale: bool
    is_empty: bool
    now: datetime

    def render_text(self) -> str:
        if self.is_empty:
            return (
                f"⚠️ events table empty — "
                f"pipeline has never recorded an event "
                f"(threshold {self.threshold_hours:.0f}h)"
            )
        assert self.last_event is not None and self.age_hours is not None
        status = "⚠️ stale" if self.is_stale else "✅ fresh"
        return (
            f"{status} — last event {self.age_hours:.1f}h ago "
            f"at {self.last_event.isoformat()} "
            f"(threshold {self.threshold_hours:.0f}h)"
        )

    def to_json(self) -> str:
        return json.dumps(
            {
                "last_event": self.last_event.isoformat() if self.last_event else None,
                "age_hours": self.age_hours,
                "threshold_hours": self.threshold_hours,
                "is_stale": self.is_stale,
                "is_empty": self.is_empty,
                "now": self.now.isoformat(),
            }
        )


def parse_max_timestamp(raw: str) -> Optional[datetime]:
    """Parse the psql -t -A output of ``SELECT MAX(created_at) FROM events``.

    Returns None for an empty string (table empty) and raises ValueError for
    anything else that can't be parsed.
    """
    raw = raw.strip()
    if not raw:
        return None
    ts = datetime.fromisoformat(raw.replace(" ", "T"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def check_events_freshness(
    threshold_hours: float = DEFAULT_THRESHOLD_HOURS,
    now: Optional[datetime] = None,
    psql_runner=run_psql,
) -> CanaryResult:
    """Core logic: query events MAX(created_at) and compare to threshold."""
    current = now or datetime.now(timezone.utc)
    raw = psql_runner("SELECT MAX(created_at) FROM public.events;")
    last_event = parse_max_timestamp(raw)

    if last_event is None:
        return CanaryResult(
            last_event=None,
            age_hours=None,
            threshold_hours=threshold_hours,
            is_stale=True,
            is_empty=True,
            now=current,
        )

    age = current - last_event
    age_hours = age.total_seconds() / 3600.0
    is_stale = age > timedelta(hours=threshold_hours)
    return CanaryResult(
        last_event=last_event,
        age_hours=age_hours,
        threshold_hours=threshold_hours,
        is_stale=is_stale,
        is_empty=False,
        now=current,
    )


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--threshold-hours",
        type=float,
        default=DEFAULT_THRESHOLD_HOURS,
        help=f"Hours before events are considered stale (default: {DEFAULT_THRESHOLD_HOURS})",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of human-readable text",
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Treat an empty events table as fresh (exit 0)",
    )
    args = parser.parse_args(argv)

    try:
        result = check_events_freshness(threshold_hours=args.threshold_hours)
    except Exception as e:
        print(f"events_canary error: {e}", file=sys.stderr)
        return 2

    print(result.to_json() if args.json else result.render_text())

    if result.is_empty and args.allow_empty:
        return 0
    return 1 if result.is_stale else 0


if __name__ == "__main__":
    sys.exit(main())

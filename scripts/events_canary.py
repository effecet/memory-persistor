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
from typing import Literal, Optional

_HOOKS = Path(__file__).resolve().parent  # psql_dsn.py lives beside this script
if str(_HOOKS) not in sys.path:
    sys.path.insert(0, str(_HOOKS))
from psql_dsn import psql_env  # noqa: E402  (path-insert must precede import)

DEFAULT_THRESHOLD_HOURS = 24
HEARTBEAT_THRESHOLD_HOURS = 24  # brain-liveness window (heartbeat events)
# 72h (not 24h) is deliberate: real MCP events are sparse + bursty (~8/active
# day, ~half the days idle), so a short pipe window would false-alarm via the
# alert gate whenever the operator is active (fresh heartbeat) but simply hasn't
# made an explicit remember/recall in a day. 72h makes "active yet zero real
# events" implausible enough to read as a genuine silent pipeline. Detecting a
# misroute within 72h of continued use still beats the historical 6-day blindness.
PIPELINE_THRESHOLD_HOURS = 72  # real MCP-event window (non-heartbeat events)

# The 5 states db_events can resolve to. Literal (not bare str) so mypy catches
# typos and non-exhaustive handling in render_detail / verdict.
CanaryState = Literal["empty", "healthy", "bootstrap", "idle", "pipeline_silent"]

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
        # Password out of argv (/proc/<pid>/cmdline is world-readable) and into
        # the child env, where /proc/<pid>/environ is owner-only. See psql_dsn.
        argv_dsn, env = psql_env(database_url)
        result = subprocess.run(
            ["psql", argv_dsn, "-t", "-A", "-c", query],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
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


@dataclass(frozen=True)
class TwoTierResult:
    pipe_last: Optional[datetime]
    hb_last: Optional[datetime]
    pipe_age_hours: Optional[float]
    hb_age_hours: Optional[float]
    hb_threshold_hours: float
    pipe_threshold_hours: float
    state: CanaryState
    should_alert: bool  # db_events unhealthy — True only for 'pipeline_silent' and 'empty'
    now: datetime

    def render_detail(self) -> str:
        """Concise one-line detail for the canary card (no raw ISO timestamps)."""
        p = self.pipe_threshold_hours
        pipe = f"{self.pipe_age_hours:.1f}h" if self.pipe_age_hours is not None else "—"
        hb = f"{self.hb_age_hours:.1f}h" if self.hb_age_hours is not None else "—"
        if self.state == "empty":
            return f"events table empty (thr {p:.0f}h)"
        if self.state == "pipeline_silent":
            return f"STALE · pipeline silent {pipe} while active (hb {hb})"
        if self.state == "idle":
            return f"idle · pipeline {pipe} / hb {hb} (both quiet)"
        if self.state == "bootstrap":
            return f"healthy · no pipeline events yet (hb {hb})"
        return f"healthy · pipeline {pipe} (hb {hb})"


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


def parse_two_timestamps(raw: str) -> tuple[Optional[datetime], Optional[datetime]]:
    """Parse the ``<pipe>~<hb>`` output of the two-tier MAX query. Either side may
    be empty (SQL NULL → empty string). The '~' delimiter is guaranteed by the
    query's COALESCE-to-text, so its absence means a malformed response."""
    raw = raw.strip()
    if "~" not in raw:
        raise ValueError(f"two-tier query output missing '~' delimiter: {raw!r}")
    pipe_str, hb_str = raw.split("~", 1)
    return parse_max_timestamp(pipe_str), parse_max_timestamp(hb_str)


def _age_hours(now: datetime, ts: Optional[datetime]) -> Optional[float]:
    return None if ts is None else (now - ts).total_seconds() / 3600.0


def two_tier_verdict(
    pipe_last: Optional[datetime],
    hb_last: Optional[datetime],
    now: datetime,
    hb_threshold_hours: float,
    pipe_threshold_hours: float,
) -> tuple[CanaryState, bool, Optional[float], Optional[float]]:
    """Discriminate idle-brain from a silent pipeline. should_alert=True only when
    the brain is actively touched (hb fresh) yet real MCP events have gone silent
    (pipe non-NULL and stale). Returns (state, should_alert, pipe_age, hb_age).

    Boundary asymmetry is deliberate: ``hb_fresh`` uses strict ``<`` (so a
    heartbeat exactly at the threshold is NOT fresh and cannot trigger an alert —
    the conservative choice), while ``pipe_fresh``/``pipe_stale`` use ``<=``/``>``
    as a complementary partition (no gap/overlap at the boundary).
    """
    pipe_age = _age_hours(now, pipe_last)
    hb_age = _age_hours(now, hb_last)
    hb_fresh = hb_age is not None and hb_age < hb_threshold_hours
    pipe_fresh = pipe_age is not None and pipe_age <= pipe_threshold_hours
    pipe_stale = pipe_age is not None and pipe_age > pipe_threshold_hours

    if pipe_last is None and hb_last is None:
        return "empty", True, pipe_age, hb_age
    if pipe_fresh:
        return "healthy", False, pipe_age, hb_age
    if pipe_stale and hb_fresh:
        return "pipeline_silent", True, pipe_age, hb_age
    if pipe_last is None and hb_fresh:
        return "bootstrap", False, pipe_age, hb_age
    return "idle", False, pipe_age, hb_age


def check_events_freshness(
    threshold_hours: float = DEFAULT_THRESHOLD_HOURS,
    now: Optional[datetime] = None,
    psql_runner=run_psql,
) -> CanaryResult:
    """Core logic: query the newest REAL (non-heartbeat) event and compare to
    threshold. Heartbeats are excluded — they are a ≤6h liveness ping, so counting
    them here would keep this single-tier check permanently 'fresh' and blind it to
    a silent MCP pipeline (the failure it exists to catch). Two-tier callers use
    check_events_two_tier; this stays the simple real-pipeline freshness signal."""
    current = now or datetime.now(timezone.utc)
    raw = psql_runner(
        "SELECT MAX(created_at) FROM public.events WHERE event_type <> 'heartbeat';"
    )
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


def check_events_two_tier(
    hb_threshold_hours: float = HEARTBEAT_THRESHOLD_HOURS,
    pipe_threshold_hours: float = PIPELINE_THRESHOLD_HOURS,
    now: Optional[datetime] = None,
    psql_runner=run_psql,
) -> TwoTierResult:
    """Two-tier freshness: newest non-heartbeat event (pipe) + newest heartbeat
    (hb). COALESCE-to-text with a '~' delimiter makes parsing independent of
    psql's field separator."""
    current = now or datetime.now(timezone.utc)
    raw = psql_runner(
        "SELECT "  # noqa: S608 — literal SQL, no bind params (run_psql contract)
        "COALESCE(MAX(created_at) FILTER (WHERE event_type <> 'heartbeat')::text, '') "
        "|| '~' || "
        "COALESCE(MAX(created_at) FILTER (WHERE event_type = 'heartbeat')::text, '') "
        "FROM public.events;"
    )
    pipe_last, hb_last = parse_two_timestamps(raw)
    state, should_alert, pipe_age, hb_age = two_tier_verdict(
        pipe_last, hb_last, current, hb_threshold_hours, pipe_threshold_hours
    )
    return TwoTierResult(
        pipe_last=pipe_last,
        hb_last=hb_last,
        pipe_age_hours=pipe_age,
        hb_age_hours=hb_age,
        hb_threshold_hours=hb_threshold_hours,
        pipe_threshold_hours=pipe_threshold_hours,
        state=state,
        should_alert=should_alert,
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

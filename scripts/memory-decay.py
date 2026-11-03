#!/usr/bin/env python3
"""
Memory decay + snapshot script.
Run on session start or via cron to age out stale memories.

1. Runs public.memory_thermal_decay() — the versioned decay function
   (this script does NOT define decay behaviour; drizzle/ owns it)
2. Exports JSON snapshots to backups/
3. Prunes to the last MAX_SNAPSHOTS snapshots
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

_HOOKS = Path(__file__).resolve().parent  # psql_dsn.py lives beside this script
if str(_HOOKS) not in sys.path:
    sys.path.insert(0, str(_HOOKS))
from psql_dsn import psql_env  # noqa: E402  (path-insert must precede import)

MAX_SNAPSHOTS = 7  # keep ~1 week of DB snapshots; Postgres is the real safety net

# Resolve paths
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
BACKUP_DIR = PROJECT_DIR / "backups"
COMPOSE_FILE = PROJECT_DIR / "docker-compose.yml"


def get_database_url() -> str:
    """Resolve DATABASE_URL targeting the SAME DB the MCP uses.

    Order: non-localhost DATABASE_URL env -> DOTENV_CONFIG_PATH file (the MCP's
    own env selector) -> .env.supabase (managed database) -> .env (local
    Docker). Honoring DOTENV_CONFIG_PATH / .env.supabase matters when the real
    corpus lives on a managed database: decaying an idle local copy instead
    is a silent no-op. For an explicit local run, set DOTENV_CONFIG_PATH=.env.
    """
    env_url = os.environ.get("DATABASE_URL")
    if env_url and "localhost" not in env_url and "127.0.0.1" not in env_url:
        return env_url

    candidates: list[Path] = []
    dotenv_path = os.environ.get("DOTENV_CONFIG_PATH")
    if dotenv_path:
        candidates.append(Path(dotenv_path).expanduser())
    candidates += [PROJECT_DIR / ".env.supabase", PROJECT_DIR / ".env"]

    for env_file in candidates:
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val

    if env_url:  # last resort: a localhost env URL beats nothing
        return env_url
    raise RuntimeError("DATABASE_URL not found (DOTENV_CONFIG_PATH/.env.supabase/.env)")


def run_psql(query: str) -> str:
    """Execute a psql query via local psql or Docker container fallback."""
    if shutil.which("psql"):
        argv_dsn, env = psql_env(get_database_url())
        result = subprocess.run(
            ["psql", argv_dsn, "-t", "-A", "-c", query],
            capture_output=True, text=True, timeout=30, env=env,
        )
    else:
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE),
             "exec", "-T", "postgres",
             "psql", "-U", "postgres", "-d", "memory_persistor", "-t", "-A", "-c", query],
            capture_output=True, text=True, timeout=30,
        )

    if result.returncode != 0:
        raise RuntimeError(f"psql error: {result.stderr.strip()}")
    return result.stdout.strip()


def decay() -> int:
    """Run the versioned decay function. Returns the count of CHANGED rows.

    Delegates to public.memory_thermal_decay() rather than carrying its own
    query, so `make decay` and the nightly pg_cron job cannot diverge. They
    had: this function held the pre-0010 logic — a flat decay rate with no
    pattern-awareness, no floor, and tier written from absolute thresholds —
    so after the switch to rank-assigned tiers, running it OVERWROTE correct
    tiers with the old scheme across every row in the staleness window.

    The returned number changed meaning with that delegation. It used to count
    rows inside the staleness window whether or not anything about them moved;
    it now counts rows the function reports as actually changed, which is a
    subset and the more useful figure. `make decay` output will read lower.

    Note this path does NOT sync markdown — psql cannot reach the filesystem,
    the same property the pg_cron path has. decayAll() in src/thermal.ts is
    the only caller that writes files.
    """
    result = run_psql("SELECT COUNT(*) FROM public.memory_thermal_decay();")
    return int(result) if result else 0


def export_snapshot() -> tuple[Path, Path]:
    """Export entities and relations as JSON snapshots."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d_%H%M")

    entities_file = BACKUP_DIR / f"entities_{date_str}.json"
    relations_file = BACKUP_DIR / f"relations_{date_str}.json"

    entities_json = run_psql("""
        SELECT json_agg(row_to_json(t)) FROM (
            SELECT id, name, type, observations, tags, source, importance,
                   temperature, tier, access_count, created_at
            FROM public.entities ORDER BY created_at
        ) t;
    """)
    entities_file.write_text(entities_json or "[]", encoding="utf-8")

    relations_json = run_psql("""
        SELECT json_agg(row_to_json(t)) FROM (
            SELECT * FROM public.memory_relations ORDER BY created_at
        ) t;
    """)
    relations_file.write_text(relations_json or "[]", encoding="utf-8")

    return entities_file, relations_file


def prune_snapshots() -> int:
    """Keep only the last MAX_SNAPSHOTS of each type. Returns count removed."""
    removed = 0
    for prefix in ("entities_", "relations_"):
        files = sorted(
            BACKUP_DIR.glob(f"{prefix}*.json"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        for old_file in files[MAX_SNAPSHOTS:]:
            old_file.unlink()
            removed += 1
    return removed


def main() -> None:
    # 1. Decay
    changed_count = decay()

    # 2. Snapshot
    try:
        entities_file, relations_file = export_snapshot()
        snapshot_msg = f"snapshot: {entities_file.name}"
    except Exception as e:
        snapshot_msg = f"snapshot failed: {e}"

    # 3. Prune
    pruned = prune_snapshots()

    # Human-readable summary line (captured by the caller, if any)
    parts = [f"🧊 Memory decay: {changed_count} entities changed"]
    if pruned:
        parts.append(f", {pruned} old snapshots pruned")
    parts.append(f" | {snapshot_msg}")

    print("".join(parts))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"🧊 Memory decay error: {e}", file=sys.stderr)
        sys.exit(0)  # non-fatal — never block session start

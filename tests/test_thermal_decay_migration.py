# tests/test_thermal_decay_migration.py
"""Drift guard for the versioned thermal decay job.

The decay contract lives in two hand-written copies: ``src/config.ts`` holds the
constants, ``drizzle/0010_thermal_decay_function.sql`` holds the query that uses
them. Before that migration existed, the query lived ONLY as a live row in
``cron.job`` on the managed instance — in no migration and no script — so a
``config.ts`` edit could silently diverge from what actually ran nightly.

This guard fails when one copy moves without the other.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATION = REPO / "drizzle" / "0010_thermal_decay_function.sql"
CONFIG = REPO / "src" / "config.ts"
THERMAL_TS = REPO / "src" / "thermal.ts"

PLAIN_CONSTANTS = (
    "DECAY_RATE",
    "DECAY_THRESHOLD_HOURS",
    "PATTERN_THRESHOLD_BITS",
    "PATTERN_MULTIPLIER_PER_BIT",
    "IMPORTANCE_DRIFT_UP",
    "IMPORTANCE_DRIFT_DOWN",
    "IMPORTANCE_DRIFT_ACCESS_MIN",
    "IMPORTANCE_DRIFT_NEGLECT_DAYS",
    "IMPORTANCE_CAP",
    "IMPORTANCE_FLOOR",
    "TIER_HOT",
    "TIER_WARM",
    "STALE_THRESHOLD_DAYS",
)


def _const(name: str) -> str:
    """Read a numeric constant out of src/config.ts, normalized like SQL writes it."""
    m = re.search(rf"^export const {name} = ([0-9._]+)", CONFIG.read_text(), re.M)
    assert m, f"{name} not found in src/config.ts"
    return m.group(1).rstrip(".")


def test_migration_exists():
    assert MIGRATION.exists(), "drizzle/0010_thermal_decay_function.sql is missing"


def test_plain_constants_appear_in_migration():
    """Every constant the decay query uses must be present verbatim in the SQL."""
    sql = MIGRATION.read_text()
    missing = [f"{n} = {_const(n)}" for n in PLAIN_CONSTANTS if _const(n) not in sql]
    assert not missing, f"constants missing from migration: {missing}"


def test_encoded_pattern_multiplier_base():
    """The migration encodes PATTERN_MULTIPLIER_BASE - 1.0, not the raw value.

    config.ts says 1.1; the SQL says 0.1. A naive substring check would miss
    this, so it gets its own assertion.
    """
    encoded = round(float(_const("PATTERN_MULTIPLIER_BASE")) - 1.0, 10)
    assert str(encoded) in MIGRATION.read_text(), (
        f"PATTERN_MULTIPLIER_BASE - 1.0 = {encoded} missing from migration"
    )


def test_schedules_the_named_job():
    sql = MIGRATION.read_text()
    assert "cron.schedule" in sql
    assert "memory-thermal-decay" in sql
    assert "0 6 * * *" in sql


def test_migration_is_idempotent_by_construction():
    """Re-applying must not create a second function or a second cron job."""
    sql = MIGRATION.read_text()
    assert "CREATE OR REPLACE FUNCTION" in sql
    assert "cron.unschedule" in sql, (
        "schedule must be guarded by an unschedule so re-application cannot "
        "leave two jobs on pg_cron < 1.4"
    )


def test_decay_all_delegates_and_keeps_no_second_copy():
    """decayAll() must call the function, not carry its own copy of the CTE."""
    ts = THERMAL_TS.read_text()
    assert "public.memory_thermal_decay()" in ts, "decayAll no longer calls the function"
    assert "WITH decay_rates AS" not in ts, (
        "a second hand-written copy of the decay CTE is back in src/thermal.ts"
    )


def test_returned_columns_match_what_decay_all_reads():
    """The RETURNS TABLE column names are the contract decayAll consumes."""
    sql = MIGRATION.read_text()
    for col in ("id", "name", "type", "observations", "temperature",
                "tier", "source", "importance", "access_count"):
        assert re.search(rf"^\s+{col}\s+\w", sql, re.M), (
            f"RETURNS TABLE is missing the {col} column decayAll reads"
        )

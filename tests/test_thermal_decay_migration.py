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
import pytest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MIGRATION = REPO / "drizzle" / "0010_thermal_decay_function.sql"
CONFIG = REPO / "src" / "config.ts"
THERMAL_TS = REPO / "src" / "thermal.ts"

# Each constant is pinned to the SQL EXPRESSION it appears in, not to its bare
# value. A bare-value check is close to vacuous here: "3", "5", "30" and "0.1"
# all occur incidentally elsewhere in the file (including inside comments), so a
# substring guard reports green while the maths has actually drifted. `{v}` is
# substituted with the value read from src/config.ts.
CONSTANT_EXPRESSIONS = {
    "DECAY_RATE": r"ELSE {v}::real",
    "DECAY_THRESHOLD_HOURS": r"INTERVAL '1 hour' \* {v}\b",
    "PATTERN_THRESHOLD_BITS": r">= {v}::real",
    "PATTERN_MULTIPLIER_PER_BIT": r"\* {v}::real",
    "IMPORTANCE_DRIFT_UP": r"e\.importance \+ {v}::real",
    "IMPORTANCE_DRIFT_DOWN": r"e\.importance - {v}::real",
    "IMPORTANCE_DRIFT_ACCESS_MIN": r"e\.access_count >= {v}\b",
    "IMPORTANCE_DRIFT_NEGLECT_DAYS": r"INTERVAL '1 day' \* {v}\b",
    "IMPORTANCE_CAP": r"LEAST\({v}::real",
    "IMPORTANCE_FLOOR": r"GREATEST\({v}::real",
    "TIER_HOT": r"> {v} THEN 'HOT'",
    "TIER_WARM": r"> {v} THEN 'WARM'",
    "STALE_THRESHOLD_DAYS": r"INTERVAL '1 day' \* {v}\b",
}


def _const(name: str) -> str:
    """Read a numeric constant out of src/config.ts, normalized like SQL writes it."""
    m = re.search(rf"^export const {name} = ([0-9._]+)", CONFIG.read_text(), re.M)
    assert m, f"{name} not found in src/config.ts"
    return m.group(1).rstrip(".")


def _sql_without_comments() -> str:
    """Strip `--` comment lines so prose can never satisfy a constant assertion."""
    return "\n".join(
        line for line in MIGRATION.read_text().splitlines()
        if not line.lstrip().startswith("--")
    )


def test_migration_exists():
    assert MIGRATION.exists(), "drizzle/0010_thermal_decay_function.sql is missing"


@pytest.mark.parametrize("name", sorted(CONSTANT_EXPRESSIONS))
def test_constant_appears_in_its_sql_expression(name: str):
    """Each config.ts constant must appear in the SQL expression that uses it."""
    value = re.escape(_const(name))
    pattern = CONSTANT_EXPRESSIONS[name].replace("{v}", value)
    assert re.search(pattern, _sql_without_comments()), (
        f"{name} = {_const(name)} does not appear in the migration as /{pattern}/ "
        f"— config.ts and the SQL have drifted"
    )


def test_encoded_pattern_multiplier_base():
    """The migration encodes PATTERN_MULTIPLIER_BASE - 1.0, not the raw value.

    config.ts says 1.1; the SQL says 0.1. Anchored to the exact line it sits on,
    because IMPORTANCE_FLOOR is ALSO 0.1 — a bare `"0.1" in sql` check passes on
    that unrelated constant and would never notice this one going wrong.
    """
    encoded = round(float(_const("PATTERN_MULTIPLIER_BASE")) - 1.0, 10)
    pattern = rf"^\s+{re.escape(str(encoded))}::real$"
    assert re.search(pattern, _sql_without_comments(), re.M), (
        f"PATTERN_MULTIPLIER_BASE - 1.0 = {encoded} missing from the migration "
        f"as a standalone /{pattern}/ term"
    )


def test_schedules_the_named_job():
    sql = MIGRATION.read_text()
    assert "cron.schedule" in sql
    assert "memory-thermal-decay" in sql
    assert "0 6 * * *" in sql


def test_migration_is_idempotent_by_construction():
    """Re-applying must not create a second function or a second cron job."""
    sql = MIGRATION.read_text()
    assert "DROP FUNCTION IF EXISTS public.memory_thermal_decay();" in sql, (
        "a bare CREATE OR REPLACE cannot change a RETURNS TABLE column list "
        "(Postgres: 'cannot change return type of existing function'), so the "
        "DROP must stay or a future column change breaks every applied database"
    )
    assert "CREATE FUNCTION public.memory_thermal_decay()" in sql
    assert "cron.unschedule" in sql, (
        "schedule must be guarded by an unschedule so re-application cannot "
        "leave two jobs on pg_cron < 1.4"
    )
    assert "AND database = current_database()" in sql, (
        "cron.job is cluster-wide, so an unscoped unschedule applied in a second "
        "database tears down the first database's job"
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
                "tier", "source", "importance", "access_count", "origin_host"):
        assert re.search(rf"^\s+{col}\s+\w", sql, re.M), (
            f"RETURNS TABLE is missing the {col} column decayAll reads"
        )

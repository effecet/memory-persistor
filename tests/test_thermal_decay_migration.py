# tests/test_thermal_decay_migration.py
"""Drift guard for the versioned thermal decay job.

The decay contract lives in two hand-written copies: ``src/config.ts`` holds the
constants, and a ``drizzle/*.sql`` migration holds the query that uses them.
Before 0010 existed, the query lived ONLY as a live row in ``cron.job`` on
Supabase — in no migration and no script — so a ``config.ts`` edit could
silently diverge from what actually ran nightly.

The function body has been superseded repeatedly (0010 → 0013 → 0014 → 0015),
each time by a full copy, so the migration that MATTERS is whichever one
``make migrate`` applies last. That target is **discovered, never hardcoded**
— see ``_decay_definers``. It used to be a literal path, which is how this
guard came to validate dead SQL: it named 0013 while 0014 had already
superseded 0013's body, so it spent that whole period pinning ``config.ts``
against a definition Postgres no longer ran, while reporting a clean pass.

The cron schedule assertions are the exception: the superseding migrations
deliberately do NOT re-schedule the job, so the schedule still lives only in
0010 (see ``SCHEDULE_MIGRATION`` below).

This guard fails when one copy moves without the other. It mirrors the existing
``test_memory_dedup.py::TestTsSlugDrift`` /
``test_backup_prune.py::TestSlugify`` pattern.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# Matches both the original CREATE FUNCTION and every CREATE OR REPLACE that
# superseded it, so the chain is discovered however a future migration spells it.
_DEFINES_DECAY = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.memory_thermal_decay\b",
    re.IGNORECASE,
)


def _strip_sql_comments(sql: str) -> str:
    """Drop whole-line ``--`` comments.

    These migrations quote SQL at length in their headers — 0015 discusses
    CREATE OR REPLACE in prose — so matching raw file text would let a COMMENT
    in a future migration re-target this guard onto a file that defines
    nothing. ``tests/test_thermal_test_isolation.py`` strips comments before
    matching for exactly this reason.
    """
    return "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )


def _decay_definers() -> list[Path]:
    """Every migration that defines public.memory_thermal_decay(), in apply order.

    Migrations are zero-padded and applied in filename order (``make migrate``
    globs ``drizzle/*.sql`` and sorts), so lexicographic order IS apply order.
    """
    return sorted(
        path
        for path in (REPO / "drizzle").glob("*.sql")
        if _DEFINES_DECAY.search(_strip_sql_comments(path.read_text()))
    )


_DEFINERS = _decay_definers()
assert _DEFINERS, "no drizzle migration defines public.memory_thermal_decay()"
# The LAST definer is the one left standing after every migration is applied —
# the only body Postgres actually runs, and therefore the only one worth
# pinning src/config.ts against.
MIGRATION = _DEFINERS[-1]
# The superseding migrations use CREATE OR REPLACE FUNCTION and deliberately do
# NOT re-schedule the cron job — the schedule (cron.schedule /
# memory-thermal-decay / 0 6 * * *) still lives only in 0010, so the
# schedule-specific assertions target it directly rather than MIGRATION.
SCHEDULE_MIGRATION = REPO / "drizzle" / "0010_thermal_decay_function.sql"
# 0012's static seed for the thermal_cutoffs row. Once 0013 exists,
# memory_thermal_decay() overwrites this row at runtime (Pass 3), so a runtime
# integration test can no longer prove the SEED matches TIER_HOT/TIER_WARM —
# see test_0012_seed_matches_tier_hot_warm below, and
# tests/integration/isolated/thermal-cutoffs-migration.test.ts's beforeEach comment.
MIGRATION_0012 = REPO / "drizzle" / "0012_thermal_cutoffs.sql"
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
    "HOT_QUANTILE",
    "WARM_QUANTILE",
    "TEMPERATURE_FLOOR_EPSILON",
)


def _const(name: str) -> str:
    """Read a numeric constant out of src/config.ts, normalized like SQL writes it.

    Handles scientific notation (e.g. ``1e-6``, TEMPERATURE_FLOOR_EPSILON's
    literal form) as well as plain decimals — a ``[0-9._]+`` character class
    stops at the ``e``/``-`` in ``1e-6`` and silently returns just ``1``, which
    makes the membership check below vacuous (every migration contains the
    digit "1" somewhere). Verified against a mutation: with the narrower class,
    changing TEMPERATURE_FLOOR_EPSILON to 2e-6 did NOT turn
    test_plain_constants_appear_in_migration red.
    """
    m = re.search(
        rf"^export const {name} = ([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)",
        CONFIG.read_text(),
        re.M,
    )
    assert m, f"{name} not found in src/config.ts"
    return m.group(1).rstrip(".")


def test_migration_is_the_last_definer():
    """The pinned migration must be the one no later migration supersedes.

    NOT tautological against a careless edit: it goes red the moment MIGRATION
    is hardcoded to a literal path again and a later migration redefines the
    function. That is the exact state this file sat in between 0014 and
    0015 — pointing at 0013, validating SQL that no longer ran, passing.
    """
    later = [p.name for p in _decay_definers() if p.name > MIGRATION.name]
    assert not later, (
        f"{MIGRATION.name} is superseded by {later} — this guard is pinning dead SQL"
    )


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


def test_0012_seed_matches_tier_hot_warm():
    """0012's static seed row must equal TIER_HOT/TIER_WARM — a STATIC guard.

    Before 0013, tests/integration/isolated/thermal-cutoffs-migration.test.ts asserted
    this at runtime by reading the live row. Since 0013,
    memory_thermal_decay() writes real values to that same row on every call
    (Pass 3), so any earlier suite in the shared integration DB overwrites it
    before that test's assertion runs — its `beforeEach` now RE-WRITES the
    seed values it then asserts on, which tests the fixture, not the
    migration. This test restores the coverage by reading the migration file
    directly: it fails if 0012 ever seeds different numbers, OR if the seed
    INSERT is removed entirely, OR if TIER_HOT/TIER_WARM in config.ts drift
    away from what 0012 hardcodes.
    """
    expected = f"VALUES (1, {_const('TIER_HOT')}, {_const('TIER_WARM')}, 0)"
    sql = MIGRATION_0012.read_text()
    assert expected in sql, (
        f"0012's seed does not match TIER_HOT/TIER_WARM: expected {expected!r} "
        f"in {MIGRATION_0012.name}"
    )


def test_schedules_the_named_job():
    """The cron schedule lives only in 0010 — 0013 deliberately does not repeat it."""
    sql = SCHEDULE_MIGRATION.read_text()
    assert "cron.schedule" in sql
    assert "memory-thermal-decay" in sql
    assert "0 6 * * *" in sql


def test_migration_is_idempotent_by_construction():
    """Re-applying must not create a second function or a second cron job."""
    sql = MIGRATION.read_text()
    assert "CREATE OR REPLACE FUNCTION" in sql
    schedule_sql = SCHEDULE_MIGRATION.read_text()
    assert "cron.unschedule" in schedule_sql, (
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

# tests/test_thermal_decay_migration.py
"""Drift guard for the versioned thermal decay job.

The decay contract lives in two hand-written copies: ``src/config.ts`` holds the
constants, and a ``drizzle/*.sql`` migration holds the query that uses them.
Before 0010 existed, the query lived ONLY as a live row in ``cron.job`` on
the managed instance — in no migration and no script — so a ``config.ts`` edit could
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

import pytest

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

# Each constant is pinned to the SQL EXPRESSION it appears in, not to its bare
# value. A bare-value check is close to vacuous here: "3", "5", "0.05" and "0.1"
# occur many times elsewhere in the function (comments included), so a
# substring guard reports green while the maths has actually drifted. `{v}` is
# substituted with the value read from src/config.ts; matching runs on the SQL
# with comment lines removed.
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
    # The seeds are the fallback cutoffs written when no measured band exists.
    "TIER_HOT": r"THEN {v}::real ELSE b\.min_hot\b",
    "TIER_WARM": r"THEN {v}::real ELSE b\.min_warm\b",
    "HOT_QUANTILE": r"ranked\.pr >= {v}::real THEN 'HOT'",
    "WARM_QUANTILE": r"ranked\.pr >= {v}::real THEN 'WARM'",
    "STALE_THRESHOLD_DAYS": r"INTERVAL '1 day' \* {v}\b",
    "TEMPERATURE_FLOOR_EPSILON": r"e\.temperature < {v}::real THEN 0\.0::real",
}


def _sql_without_comments() -> str:
    """Strip `--` comment lines so prose can never satisfy a constant assertion."""
    return "\n".join(
        line for line in MIGRATION.read_text().splitlines()
        if not line.lstrip().startswith("--")
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


@pytest.mark.parametrize("name", sorted(CONSTANT_EXPRESSIONS))
def test_constant_appears_in_its_sql_expression(name: str):
    """Each constant must sit in the expression that uses it, not just anywhere."""
    value = re.escape(_const(name))
    pattern = CONSTANT_EXPRESSIONS[name].replace("{v}", value)
    assert re.search(pattern, _sql_without_comments()), (
        f"{name} = {_const(name)} not found in its expression /{pattern}/ in {MIGRATION.name}"
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
    assert "AND database = current_database()" in schedule_sql, (
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


INITDB_CRON = REPO / "initdb" / "01-pg-cron.sql"


def _decay_catchup_body() -> str:
    sql = INITDB_CRON.read_text()
    m = re.search(
        r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.decay_catchup\(\).*?\$func\$(.*?)\$func\$",
        sql,
        re.S | re.I,
    )
    assert m, "decay_catchup() not found in initdb/01-pg-cron.sql"
    return _strip_sql_comments(m.group(1))


def test_decay_catchup_delegates_and_keeps_no_second_copy():
    """The startup catch-up runs the versioned function, not a frozen copy.

    It used to inline the v3 query with fixed 0.7/0.3 tier thresholds, so
    after a long outage local Docker re-tiered on absolute cutoffs while the
    nightly job used cume_dist."""
    body = _decay_catchup_body()
    # The call site, not the name: the name also appears in the
    # to_regprocedure guard and the NOTICE text.
    call = re.search(r"\bFROM\s+public\.memory_thermal_decay\(\)", body)
    assert call, "decay_catchup no longer calls public.memory_thermal_decay()"
    # Before `make migrate` the function does not exist yet; without the guard
    # the @reboot catch-up on a fresh container would raise instead of skip.
    guard = re.search(
        r"to_regprocedure\('public\.memory_thermal_decay\(\)'\)\s+IS\s+NULL", body, re.I
    )
    assert guard, "decay_catchup lost its missing-function guard"
    assert guard.start() < call.start(), "the missing-function guard must run before the call"
    assert "WITH decay_rates AS" not in body, (
        "a hand-written copy of the decay CTE is back in decay_catchup"
    )
    assert not re.search(r">\s*0\.[37]\b", body), (
        "decay_catchup hard-codes a tier threshold"
    )


def test_thermal_cutoffs_single_row_check_matches_migration():
    """schema.ts declares the CHECK 0012 created, under the name Postgres gave
    it (`<table>_<column>_check` for an inline column CHECK), so the schema and
    the database agree that thermal_cutoffs holds a single row."""
    schema = (REPO / "src" / "schema.ts").read_text()
    assert re.search(
        r"check\('thermal_cutoffs_id_check',\s*sql`\$\{table\.id\} = 1`\)", schema
    ), "src/schema.ts lost the thermal_cutoffs single-row CHECK"
    (mig,) = (REPO / "drizzle").glob("0012_*.sql")
    assert re.search(r"\bid\s+smallint\b[^,\n]*\bCHECK\s*\(\s*id\s*=\s*1\s*\)", mig.read_text(), re.I), (
        "0012 no longer declares the inline CHECK (id = 1) the schema name relies on"
    )


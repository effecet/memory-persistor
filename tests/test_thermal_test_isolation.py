# tests/test_thermal_test_isolation.py
"""Isolation guard for the thermal integration tests.

`memory_thermal_decay()` is corpus-wide by design — that is what makes
`cume_dist()` meaningful — so any test that calls it re-tiers, re-ranks and
re-flags every row every other suite seeded. `thermal_cutoffs` is a second,
smaller version of the same problem: one shared row, read by every `bump()`
caller.

Both kinds of writer live in `tests/integration/isolated/`, which runs in its
own vitest process against its own database. This guard fails when one escapes.

`isolated/` is not thermal-only: any test that changes DATABASE-WIDE state
belongs there too — `mcp-write-faults.test.ts` adds triggers and renames
`word_similarity`. This guard only polices the thermal writers; the database
and CI step keep their `thermal_*` names for continuity.

It DISCOVERS its targets by globbing rather than checking a hardcoded list,
because a hardcoded list is how the `psql` DSN problem reached nine call sites
unnoticed (see `tests/test_psql_call_sites.py`).

⚠️ The wiring assertions below assert that the Makefile, the npm scripts and the
CI workflow ACTUALLY USE the isolated database — never merely that its name
appears somewhere. The first version of this file checked substrings, and four
separate mutations passed it 7/7 during review:

  A. `test-thermal` reset with `$(PG_TEST_DB)` — both phases on one database.
  B. `@$(MAKE) test-thermal` deleted — the thermal suite silently never runs.
  C. `test:integration` changed to RUN `tests/integration/isolated/` — the
     substring "tests/integration/isolated" is present either way, so an
     assertion spelled `"…isolated" in script` is satisfied by the defect it
     was meant to forbid.
  D. the isolated CI step pointed at the main database with `ci.env` — the
     leftover `CREATE DATABASE thermal_isolated` step satisfied the substring.

Each of A-D now has a test that goes red. A guard that only proves a NAME EXISTS
proves nothing about what runs.
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INTEGRATION = REPO / "tests" / "integration"
ISOLATED = INTEGRATION / "isolated"
PACKAGE_JSON = REPO / "package.json"
MAKEFILE = REPO / "Makefile"
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"

# The database the MAIN integration suite uses in CI, and the one the isolated
# suite must use instead. Kept as literals so a rename has to touch this guard.
CI_MAIN_DB = "memory_persistor_test"
CI_ISOLATED_DB = "thermal_isolated"
CI_MAIN_DOTENV = "ci.env"

# Corpus-wide: memory_thermal_decay() rewrites tier/temperature/stale for EVERY
# row in entities. decayAll() is the TypeScript path to the same function.
#
# Matches a CALL, not a mention: `tests/integration/helpers.ts:91` refers to
# "memory_thermal_decay()'s 24h staleness window" in prose, and a guard that
# fires on that would be crying wolf in a file nobody should have to edit.
#
# ⚠️ Kept as NAMED ALTERNATIVES, deliberately. An earlier version was one blob
# pinned by "the regex matches at least one isolated file" — which a review
# mutation defeated by DELETING the SQL alternative: `thermal-v3.test.ts`
# satisfied the check through the `decayAll(` branch alone, so the guard stayed
# green while `decay-origin-host.test.ts` (a SQL-only caller) became free to
# move out undetected. Every alternative is pinned individually below.
_DECAY_PARTS = {
    "sql": r"(?:SELECT|FROM)\s+(?:public\.)?memory_thermal_decay\s*\(",
    "decayAll": r"\bdecayAll\s*\(",
    # An ALIASED import defeats a call-shape pattern:
    #   import { decayAll as runDecay } from '../../src/thermal.js';
    #   await runDecay();
    # Found in review. The bare-name pattern this replaced caught it on the
    # import line by accident; tightening to a call shape lost that, so the
    # import is matched explicitly. `decayAll` never appears in shared-file
    # prose, so this costs no false positives.
    "import": r"import\s*\{[^}]*\bdecayAll\b",
}

# Single shared row: thermal_cutoffs holds one row that every bump() call reads.
# Spellings verified missing from the first version during review: TRUNCATE, a
# quoted identifier, UPDATE ONLY, and the Drizzle builder reached through the
# `* as schema` import that helpers.ts already makes.
_CUTOFFS_PARTS = {
    "sql_dml": (
        r"(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)"
        r'\s+(?:ONLY\s+)?(?:public\.)?["\']?thermal_cutoffs'
    ),
    "drizzle": r"\.(?:insert|update|delete)\(\s*(?:\w+\.)?thermalCutoffs",
}

CORPUS_WIDE = re.compile("|".join(_DECAY_PARTS.values()), re.IGNORECASE)
CUTOFFS_WRITE = re.compile("|".join(_CUTOFFS_PARTS.values()), re.IGNORECASE)

# A line that is entirely a comment cannot contain a live call. Dropping these
# removes the dominant false-positive source (prose and JSDoc referring to the
# very functions this guard hunts) without any risk of hiding a real one.
_COMMENT_LINE = re.compile(r"^\s*(?://|/\*|\*)")


def _code(text: str) -> str:
    return "\n".join(
        line for line in text.splitlines() if not _COMMENT_LINE.match(line)
    )


def _unisolated_sources() -> list[Path]:
    """Every integration source that runs against the SHARED database.

    Recursive over ALL .ts files, not just `*.test.ts` directly in the
    directory. Verified during review: `tests/integration/evade.spec.ts` and
    `tests/integration/thermal2/evade.test.ts` are both COLLECTED by
    `npm run test:integration` (vitest's default include is
    `**/*.{test,spec}.?(c|m)[jt]s?(x)`, and the --exclude only removes
    `isolated/**`), so a flat `*.test.ts` glob left two ways to evade this
    guard. `helpers.ts` and `db-guard.ts` are scanned for the same reason: a
    shared helper calling decayAll would poison every shared test at once.
    """
    return sorted(
        p
        for p in INTEGRATION.rglob("*.ts")
        if ISOLATED not in p.parents and p.parent != ISOLATED
    )


def _isolated_sources() -> list[Path]:
    return sorted(ISOLATED.rglob("*.ts"))


def _make_recipe(target: str) -> str:
    """The recipe body of one Makefile target (its tab-indented lines)."""
    lines = MAKEFILE.read_text().splitlines()
    out: list[str] = []
    collecting = False
    for line in lines:
        if not collecting:
            if re.match(rf"^{re.escape(target)}\s*:", line):
                collecting = True
            continue
        if line.startswith("\t"):
            out.append(line)
        elif line.strip() == "":
            continue
        else:
            break
    assert out, f"no recipe found for Makefile target {target!r}"
    return "\n".join(out)


def _workflow_step(name_fragment: str) -> str:
    """The body of one workflow step, up to the next step, comments removed.

    Comment lines are dropped because they do not select a database, and the
    step bodies here run right up against the NEXT step's explanatory comment
    block — the ranking-guard comment says "the suite above leaves rows in
    memory_persistor_test", which would otherwise read as the isolated step
    referencing the main database.
    """
    lines = WORKFLOW.read_text().splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip().startswith("- name:") and name_fragment in line:
            start = i
            break
    assert start is not None, f"no workflow step matching {name_fragment!r}"
    out: list[str] = []
    for line in lines[start + 1 :]:
        stripped = line.strip()
        # Terminate on ANY new list item, not just `- name:` / `- uses:`. A step
        # led by `- id:` or `- if:` would otherwise be swallowed into this one,
        # and this function's callers assert that a step does NOT mention the
        # other database — so over-collecting reads as a failure in the wrong
        # step. Every step complies today; this keeps that from mattering.
        if re.match(r"^-\s+[\w.-]+\s*:", stripped):
            break
        if stripped.startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


# ─── Placement ────────────────────────────────────────────────────────────────


def test_no_corpus_wide_decay_outside_isolated():
    offenders = [
        str(p.relative_to(INTEGRATION))
        for p in _unisolated_sources()
        if CORPUS_WIDE.search(_code(p.read_text()))
    ]
    assert offenders == [], (
        "These sources call the corpus-wide decay while running against the "
        f"SHARED integration database: {offenders}. Move them to "
        "tests/integration/isolated/ (and fix their relative imports) so they "
        "stop rewriting every other suite's fixtures."
    )


def test_no_cutoffs_writes_outside_isolated():
    offenders = [
        str(p.relative_to(INTEGRATION))
        for p in _unisolated_sources()
        if CUTOFFS_WRITE.search(_code(p.read_text()))
    ]
    assert offenders == [], (
        "These sources write the single-row thermal_cutoffs table while running "
        f"against the SHARED integration database: {offenders}. Move them to "
        "tests/integration/isolated/."
    )


def test_isolated_directory_is_not_empty():
    """A guard whose target set is empty passes vacuously."""
    assert _isolated_sources(), (
        "tests/integration/isolated/ holds no .ts files — the placement "
        "assertions above would pass vacuously."
    )


# Alternatives that real isolated files exercise today. Each must keep matching
# at least one of them, individually.
#
# ⚠️ Pinning the COMBINED regex is not enough, and a review mutation proved it:
# deleting the "sql" alternative left "decayAll" matching thermal-v3.test.ts, so
# a whole-regex check stayed green while decay-origin-host.test.ts — a SQL-only
# caller — became free to move out undetected. Granularity is the point.
#
# Referenced BY NAME, not by value, so deleting an alternative from the dicts
# above fails as a readable assertion rather than a KeyError at import time.
_EXERCISED: dict[str, list[str]] = {
    "decay": ["sql", "decayAll", "import"],
    "cutoffs": ["sql_dml"],
}
_PART_SETS = {"decay": _DECAY_PARTS, "cutoffs": _CUTOFFS_PARTS}

# Spellings that must match, whether or not any file uses them today. Real-file
# pinning cannot cover TRUNCATE/DELETE or the Drizzle builder — nothing writes
# the row that way right now — so those alternatives are pinned synthetically.
_MUST_MATCH_DECAY = [
    "await testDb.execute(sql`SELECT public.memory_thermal_decay()`);",
    "SELECT COUNT(*)::int FROM public.memory_thermal_decay() d",
    "SELECT memory_thermal_decay()",
    "await decayAll();",
    "import { decayAll as runDecay } from '../../src/thermal.js';",
]
_MUST_MATCH_CUTOFFS = [
    "INSERT INTO public.thermal_cutoffs (id) VALUES (1)",
    'INSERT INTO "thermal_cutoffs" (id) VALUES (1)',
    "UPDATE public.thermal_cutoffs SET hot_cutoff = 0.7",
    "UPDATE ONLY thermal_cutoffs SET hot_cutoff = 0.7",
    "DELETE FROM thermal_cutoffs WHERE id = 1",
    "TRUNCATE thermal_cutoffs",
    "TRUNCATE TABLE public.thermal_cutoffs",
    "await testDb.insert(schema.thermalCutoffs).values({ id: 1 })",
    "await testDb.delete(thermalCutoffs)",
]
# Reads and prose must NOT fire — a guard that cries wolf gets disabled.
_MUST_NOT_MATCH = [
    "SELECT * FROM thermal_cutoffs WHERE id = 1",
    "const { hot } = await resolveCutoffs();",
    "await thermalDecayAllTheThings();",
]


def test_each_exercised_alternative_matches_a_real_isolated_file():
    sources = [(p.name, _code(p.read_text())) for p in _isolated_sources()]
    for group, keys in _EXERCISED.items():
        parts = _PART_SETS[group]
        for key in keys:
            assert key in parts, (
                f"alternative {group}:{key} was removed from the pattern set. "
                "Every alternative is pinned individually on purpose — dropping "
                "one is how a whole-regex check stayed green while a real caller "
                "escaped."
            )
            rx = re.compile(parts[key], re.IGNORECASE)
            hits = [name for name, text in sources if rx.search(text)]
            assert hits, (
                f"alternative {group}:{key} matches no file in "
                "tests/integration/isolated/ — it has rotted, and deleting it "
                "would not fail any other assertion."
            )


def test_every_write_spelling_is_matched():
    for sample in _MUST_MATCH_DECAY:
        assert CORPUS_WIDE.search(_code(sample)), f"CORPUS_WIDE missed: {sample!r}"
    for sample in _MUST_MATCH_CUTOFFS:
        assert CUTOFFS_WRITE.search(_code(sample)), f"CUTOFFS_WRITE missed: {sample!r}"


def test_reads_and_prose_do_not_fire():
    for sample in _MUST_NOT_MATCH:
        code = _code(sample)
        assert not CORPUS_WIDE.search(code), f"CORPUS_WIDE false-positive: {sample!r}"
        assert not CUTOFFS_WRITE.search(code), f"CUTOFFS_WRITE false-positive: {sample!r}"


# ─── Wiring: the Makefile must USE the isolated database ──────────────────────


def test_test_thermal_resets_the_isolated_database():
    """Mutation A: resetting PG_TEST_DB here puts both phases on one database."""
    recipe = _make_recipe("test-thermal")
    assert "reset_db,$(PG_ISOLATED_DB)" in recipe, (
        "make test-thermal does not reset PG_ISOLATED_DB; it would run the "
        f"isolated suite against whatever the previous phase left.\n{recipe}"
    )
    assert "$(PG_TEST_DB)" not in recipe, (
        "make test-thermal references PG_TEST_DB — the isolated suite must not "
        f"touch the main test database.\n{recipe}"
    )


def test_test_integration_runs_the_thermal_phase():
    """Mutation B: dropping this line silently stops running six test files."""
    recipe = _make_recipe("test-integration")
    assert re.search(r"\$\(MAKE\)\s+test-thermal", recipe), (
        "make test-integration never invokes test-thermal, so the isolated "
        f"suite would not run at all locally.\n{recipe}"
    )


def test_main_integration_script_excludes_rather_than_includes_isolated():
    """Mutation C: a substring check is satisfied by RUNNING the directory."""
    main = json.loads(PACKAGE_JSON.read_text())["scripts"]["test:integration"]
    assert re.search(
        r"--exclude\s+['\"][^'\"]*tests/integration/isolated", main
    ), (
        "package.json test:integration must EXCLUDE tests/integration/isolated/ "
        "via --exclude. Merely mentioning the path is what the defect looks "
        f"like too: {main}"
    )


def test_isolated_script_targets_the_isolated_directory():
    scripts = json.loads(PACKAGE_JSON.read_text())["scripts"]
    assert "test:integration:isolated" in scripts, (
        "package.json has no test:integration:isolated script for the second run."
    )
    assert "tests/integration/isolated" in scripts["test:integration:isolated"], (
        "test:integration:isolated does not actually target the isolated "
        f"directory: {scripts['test:integration:isolated']}"
    )


def test_makefile_defines_a_distinct_isolated_database():
    names = dict(
        re.findall(r"^(PG_\w+)\s*=\s*(\S+)$", MAKEFILE.read_text(), re.MULTILINE)
    )
    assert "PG_ISOLATED_DB" in names, "Makefile does not define PG_ISOLATED_DB."
    assert names["PG_ISOLATED_DB"] != names.get("PG_TEST_DB"), (
        "PG_ISOLATED_DB must name a DIFFERENT database from PG_TEST_DB; both are "
        f"{names['PG_ISOLATED_DB']}."
    )
    assert names["PG_ISOLATED_DB"] != names.get("PG_DEV_DB"), (
        "PG_ISOLATED_DB must not name the dev database."
    )


# ─── Wiring: CI must point the isolated suite at the isolated database ────────


def test_ci_isolated_step_uses_its_own_database():
    """Mutation D: the CREATE DATABASE step alone satisfied a substring check."""
    step = _workflow_step("Vitest thermal isolated suite")
    assert CI_ISOLATED_DB in step, (
        f"the isolated CI step does not name {CI_ISOLATED_DB}:\n{step}"
    )
    assert CI_MAIN_DB not in step, (
        f"the isolated CI step references the MAIN database {CI_MAIN_DB} — it "
        f"would run the thermal suite against the shared corpus:\n{step}"
    )
    assert not re.search(rf"DOTENV_CONFIG_PATH:\s*{re.escape(CI_MAIN_DOTENV)}\s*$", step, re.MULTILINE), (
        f"the isolated CI step points DOTENV_CONFIG_PATH at {CI_MAIN_DOTENV}. "
        "db.ts calls dotenv.config({ override: true }), so that FILE wins over "
        f"DATABASE_URL and the suite would silently use {CI_MAIN_DB}:\n{step}"
    )
    assert "test:integration:isolated" in step, (
        f"the isolated CI step does not run the isolated npm script:\n{step}"
    )


def test_ci_main_step_does_not_use_the_isolated_database():
    step = _workflow_step("Vitest integration suite")
    assert CI_MAIN_DB in step, f"the main CI step does not name {CI_MAIN_DB}:\n{step}"
    assert CI_ISOLATED_DB not in step, (
        f"the main CI step references {CI_ISOLATED_DB}:\n{step}"
    )


def test_ci_creates_the_isolated_database():
    step = _workflow_step("Create isolated thermal database")
    assert f"CREATE DATABASE {CI_ISOLATED_DB}" in step, (
        f"CI never creates {CI_ISOLATED_DB}:\n{step}"
    )

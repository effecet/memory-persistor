# tests/test_migration_glob_parity.py
"""Every migration loop must apply the SAME set of files.

Five places apply the migrations in order: `make migrate` and the `reset_db`
macro in the Makefile, and three steps in `.forgejo/workflows/integration.yml`
(main test DB, thermal_isolated, ranking_guard).

They must agree. When they do not, a migration lands in some databases and not
others — a SUBSET-APPLIED migration, the same shape as the PR #47 drizzle-kit
incident: every table looks correct while a function is silently absent, and the
failure surfaces far from its cause as "works in CI, fails locally".

They diverged for real. the isolated thermal suite added a third CI loop and unified four sites onto
`drizzle/*.sql` while `make migrate` stayed on `drizzle/0*.sql`. Closed
2026-09-17.

## This guard DENIES BY DEFAULT, and that is the whole design

An earlier version scanned for a known loop shape and asserted `len(loops) >= 5`.
Review defeated it in one move: a SIXTH loop, spelled `for file in ...` with a
divergent glob, was invisible to the regex, so the count stayed at 5 and all
assertions passed — the exact failure the file exists to prevent, shipped
silently. A `>= N` floor only catches REMOVING a known loop, never ADDING an
unknown one. It is a hardcoded list wearing discovery's clothes.

So: every non-comment line mentioning `drizzle/` in a file that applies
migrations is a CANDIDATE, and a candidate this module cannot parse into a glob
is a FAILURE, not a skip. That mirrors `tests/test_psql_call_sites.py`, which
fails on a subprocess call its matcher cannot read rather than passing over it.
Adding a migration loop in a spelling this guard does not understand is meant to
fail until you teach it the spelling deliberately.
"""

import fnmatch
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DRIZZLE_DIR = REPO / "drizzle"

# The glob every loop must use. Pinned as a LITERAL, not merely required to be
# consistent: five loops unanimously reverted to `drizzle/0*.sql` would satisfy a
# parity-only check while reintroducing the bug this closed. Parity is necessary,
# not sufficient. Changing this value is a deliberate decision that should fail
# here first.
EXPECTED_GLOB = "drizzle/*.sql"

# Files that can plausibly apply migrations. Shell-ish only — a Python caller
# would not use these spellings and is out of scope.
def _sources() -> list[Path]:
    out = [REPO / "Makefile"]
    for pat in (
        ".forgejo/workflows/*.yml",
        ".forgejo/workflows/*.yaml",
        "scripts/*.sh",
        "claude-config/scripts/*.sh",
    ):
        out.extend(sorted(REPO.glob(pat)))
    return [p for p in out if p.exists()]


# A line is a CANDIDATE if it names the migrations directory and is not a comment.
_MENTIONS_DRIZZLE = re.compile(r"drizzle/")
# Make recipe comments are `\t@# ...`; shell/YAML comments are `# ...`.
_COMMENT = re.compile(r"^\s*(?:@?#|//)")

# Spellings this module understands. Any candidate matching none of these FAILS.
_PARSERS = (
    # for f in drizzle/*.sql; do      /  for file in drizzle/*.sql
    re.compile(r"\bfor\s+\w+\s+in\s+(?P<glob>\S+?)\s*;?\s*(?:do\b|\\\s*$|$)"),
)


def _parse(line: str) -> str | None:
    for rx in _PARSERS:
        m = rx.search(line)
        if m:
            return m.group("glob").strip("\"'")
    return None


# A line may name drizzle/ inside an operator-facing MESSAGE rather than to apply
# anything — `echo "… re-apply drizzle/0011"` in the pending-verify drift target,
# for instance. Those are excluded, but ONLY when the line does not also parse as
# a loop, so `for f in drizzle/*.sql; do echo …` on one line is still checked.
_MESSAGE = re.compile(r"\b(?:echo|printf)\b")


def _is_message_only(line: str) -> bool:
    at = _MENTIONS_DRIZZLE.search(line)
    return bool(at and _MESSAGE.search(line[: at.start()]))


def _candidates() -> list[tuple[str, int, str]]:
    found = []
    for path in _sources():
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if _COMMENT.match(line) or not _MENTIONS_DRIZZLE.search(line):
                continue
            if _parse(line) is None and _is_message_only(line):
                continue
            found.append((str(path.relative_to(REPO)), lineno, line))
    return found


def test_every_candidate_line_is_parseable():
    """Deny by default: an unreadable migration line fails, it does not skip."""
    unparsed = [
        f"{f}:{ln}: {line.strip()}"
        for f, ln, line in _candidates()
        if _parse(line) is None
    ]
    assert not unparsed, (
        "these lines name drizzle/ in a file that applies migrations, but this "
        "guard cannot read a glob out of them — so it cannot tell whether they "
        "agree with the others:\n  " + "\n  ".join(unparsed) + "\n\n"
        "Either rewrite the line in a spelling _PARSERS understands, or add the "
        "spelling to _PARSERS deliberately. Do not silence this by narrowing "
        "_candidates()."
    )


def test_migration_loops_are_discovered():
    """A guard that finds nothing to check passes vacuously."""
    globs = [g for _, _, line in _candidates() if (g := _parse(line))]
    assert len(globs) >= 5, (
        f"expected at least 5 migration loops, found {len(globs)}. A loop was "
        "removed, or its spelling drifted far enough that it is no longer a "
        "candidate at all."
    )


def test_every_migration_loop_uses_the_expected_glob():
    loops = [(f, ln, _parse(line)) for f, ln, line in _candidates()]
    wrong = [(f, ln, g) for f, ln, g in loops if g != EXPECTED_GLOB]
    assert not wrong, (
        f"every migration loop must use {EXPECTED_GLOB!r}, or a migration applies "
        "to some databases and not others:\n"
        + "\n".join(f"  {f}:{ln}  {g}" for f, ln, g in wrong)
    )


def test_the_expected_glob_matches_every_migration_on_disk():
    """Catches a UNANIMOUS mistake, which the parity check structurally cannot.

    ⚠️ Latent today: every migration is `0000`–`0014`, so `*.sql` and `0*.sql`
    match identically and this can only fire once a differently-named migration
    exists. That is why EXPECTED_GLOB is pinned as a literal above — this
    assertion alone would not have caught the reversion.

    Uses SHELL glob semantics, not `pathlib.glob`: `Path.glob("*.sql")` matches
    a dotfile like `.hidden.sql` and a DIRECTORY named `x.sql`, while bash and
    zsh match neither. Without this the guard would count a file as applied that
    `make migrate` skips.
    """
    pattern = EXPECTED_GLOB.removeprefix("drizzle/")
    on_disk = {
        p.name
        for p in DRIZZLE_DIR.iterdir()
        if p.is_file() and p.suffix == ".sql" and not p.name.startswith(".")
    }
    assert on_disk, "no migrations found on disk — this guard has nothing to check."
    missed = sorted(n for n in on_disk if not fnmatch.fnmatchcase(n, pattern))
    assert not missed, (
        f"the pinned glob {EXPECTED_GLOB!r} does not match these migrations, so "
        f"they would never be applied: {missed}"
    )

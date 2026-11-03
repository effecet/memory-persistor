"""Enumeration guard: every psql invocation in scripts/ must go through psql_env.

`tests/test_psql_dsn.py` proves the module is correct. It cannot prove the
callers USE it. A gate review on 2026-09-06 demonstrated the gap by reverting
all eight non-`events_canary` call sites to put the raw DSN back in argv — the
entire suite stayed green.

That is this repo's recurring failure shape, not a hypothetical: the retired
`memory_name_guard.py` fired on `remember` but never on `update`, so the corpus
drifted in through the unguarded path; `codeberg_backup.py` collected zero
instinct files for weeks while exiting clean.

So these tests DISCOVER their targets by walking the AST of every script rather
than checking a hardcoded list — a list would silently omit call site #10, which
is exactly how the leak got to nine sites in the first place. A regex over the
source would go stale the moment someone reformats a call across lines.

Filed against an earlier issue, deferred follow-up 1.
"""

from __future__ import annotations

import ast
from pathlib import Path, PurePosixPath

import pytest

REPO = Path(__file__).resolve().parent.parent
SCAN_ROOTS = (
    REPO / "scripts",
    REPO / "claude-config" / "hooks",
    REPO / "claude-config" / "scripts",
)


def _is_psql_argv(node: ast.AST) -> bool:
    """Is this a list literal whose argv[0] means the psql executable?

    Matches `["psql", ...]` and `[psql, ...]` (the `shutil.which` form used by
    canary_mac.py). Deliberately does NOT match the docker-exec fallbacks, whose
    argv[0] is "docker" and which carry no DSN at all.
    """
    if not isinstance(node, ast.List) or not node.elts:
        return False
    first = node.elts[0]
    if isinstance(first, ast.Constant) and first.value == "psql":
        return True
    return isinstance(first, ast.Name) and first.id == "psql"


#: Every subprocess entry point, not the two we happen to use today.
#: `check_output` and `getoutput` were both working ways past an earlier
#: version of this guard.
_SUBPROCESS_FUNCS = frozenset({
    "run", "Popen", "call", "check_call", "check_output",
    "getoutput", "getstatusoutput",
})


def _is_sys_executable(node: ast.AST) -> bool:
    """Is this argv[0] exactly the `sys.executable` attribute access?

    `sys.executable` is, by language definition, the path to the running
    Python interpreter — it can never resolve to a psql binary. That makes
    this a SYNTACTIC exemption (the shape can only ever mean one thing), not
    a heuristic one, so no psql invocation can hide behind it. Matched
    narrowly on the exact `Attribute(attr="executable", value=Name(id="sys"))`
    shape — not attributes in general, not any name ending in "executable".
    """
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "executable"
        and isinstance(node.value, ast.Name)
        and node.value.id == "sys"
    )


def _runs_a_different_program(node: ast.AST | None) -> bool:
    """Does argv[0] name some program that is not psql?

    `["docker", "compose", "exec", ...]`, `["git", "rev-parse"]`,
    `["pg_dump", ...]`. Exempting on the literal — rather than on a `docker`
    allowlist — is what keeps the deny rule from firing on an unrelated
    subprocess call that merely shares a function with a psql one.

    Also recognises `[sys.executable, ...]` (see `_is_sys_executable`) — a
    file that mentions "psql" anywhere drags every OTHER subprocess call in
    it into deny-by-default, and `sys.executable` is a common such call
    (re-invoking the interpreter on a helper script) that is neither the
    literal-string shape above nor the psql shape.

    Compares the argv[0] literal's BASENAME, not the raw string, against
    "psql". A gate review on 2026-09-06 demonstrated that an inline absolute
    path — `["/opt/homebrew/bin/psql", dsn, ...]` — is not equal to the bare
    string `"psql"`, so the old exact-match version of this predicate wrongly
    classified it as "a different program" and exempted it from verification
    entirely, with the full suite staying green. Absolute paths to psql are
    this fleet's house style under launchd/systemd (`notify()`'s
    `/opt/homebrew/bin/terminal-notifier`, the plist's
    `/opt/homebrew/bin/python3`), so this is not a hypothetical shape.
    `PurePosixPath` is deliberate and sufficient — this fleet is macOS + Linux
    only, never Windows, so there is no backslash-separator case to handle.
    """
    if not (isinstance(node, ast.List) and bool(node.elts)):
        return False
    first = node.elts[0]
    if _is_sys_executable(first):
        return True
    if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
        return False
    return PurePosixPath(first.value).name != "psql"


#: Functions whose argv is legitimately dynamic and carries no DSN. An
#: ALLOWLIST OF EXEMPTIONS, not a list of targets — the targets are still
#: discovered by walking the AST. A new dynamic-argv call fails loudly and has
#: to be added here deliberately, and a rename breaks the test rather than
#: silently widening it.
_DYNAMIC_ARGV_OK = {
    # Shells `make backfill-embeddings-remote`; the target resolves its own DSN
    # via DOTENV_CONFIG_PATH, so nothing sensitive is ever in this argv.
    ("brain_canary.py", "_default_backfill_runner"),
    # terminal-notifier on the Mac. No database involvement at all.
    ("canary_mac.py", "notify"),
}


def _subprocess_aliases(tree: ast.AST) -> set[str]:
    """Bare names bound to subprocess entry points, including `as` aliases.

    `from subprocess import check_output as _co` then `_co([...])` was a working
    way past a version of this guard that matched only the canonical names.
    """
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "subprocess":
            for alias in node.names:
                if alias.name in _SUBPROCESS_FUNCS:
                    names.add(alias.asname or alias.name)
    return names


def _subprocess_calls(tree: ast.AST, aliases: set[str] | None = None) -> list[ast.Call]:
    """`subprocess.run(...)`, a bare `run(...)`, and any aliased import of one."""
    bare = (aliases or set()) | _SUBPROCESS_FUNCS
    found = []
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue
        func = n.func
        if isinstance(func, ast.Attribute) and func.attr in _SUBPROCESS_FUNCS:
            found.append(n)
        elif isinstance(func, ast.Name) and func.id in bare:
            found.append(n)
    return found


def _enclosing_functions(tree: ast.AST) -> dict[int, str]:
    """call id -> nearest enclosing function name (for the exemption allowlist)."""
    owner: dict[int, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for call in _subprocess_calls(node):
                owner[id(call)] = node.name
    return owner


def _calls_needing_verification(tree: ast.AST, source: str) -> list[ast.Call]:
    """Every subprocess call in a file that mentions psql at all.

    Scoping per-FUNCTION was not enough: `MOD_ARGV = ["psql", dsn]` at module
    level with `subprocess.run(MOD_ARGV)` inside a function whose own body never
    says "psql" was invisible. The file is the smallest unit that cannot be
    split that way. The breadth is affordable because the exemptions are precise
    — a literal non-psql argv[0], or a named entry in _DYNAMIC_ARGV_OK.
    """
    if "psql" not in source.lower():
        return []
    return _subprocess_calls(tree, _subprocess_aliases(tree))


def _psql_calls(tree: ast.AST) -> list[ast.Call]:
    return [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr in ("run", "Popen")
        and n.args
        and _is_psql_argv(n.args[0])
    ]


def _psql_env_targets(tree: ast.AST) -> set[str]:
    """Names bound from a `psql_env(...)` call, e.g. `argv_dsn, env = psql_env(u)`."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        call = node.value
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                and call.func.id == "psql_env"):
            continue
        for target in node.targets:
            if isinstance(target, ast.Tuple):
                names.update(e.id for e in target.elts if isinstance(e, ast.Name))
    return names


SCRIPTS = sorted(
    p
    for root in SCAN_ROOTS
    if root.is_dir()
    # Recursive: `glob("*.py")` only reached each root's top level, so a
    # future `claude-config/hooks/lib/db.py` would be invisible to every test
    # in this file. `tests/` subdirectories (test doubles that monkeypatch
    # subprocess.run rather than invoking it) and `__pycache__` are excluded —
    # they are not production call sites, and scanning them would demand
    # psql_env plumbing from mocks that carry no DSN at all.
    for p in root.rglob("*.py")
    if p.name != "psql_dsn.py"
    and "__pycache__" not in p.parts
    and "tests" not in p.relative_to(root).parts
)


def test_the_guard_actually_finds_call_sites():
    """A discovery guard that discovers nothing passes vacuously forever."""
    total = sum(len(_psql_calls(ast.parse(p.read_text()))) for p in SCRIPTS)
    assert total >= 13, f"expected at least the 13 known psql call sites, found {total}"


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: str(p.relative_to(REPO)))
def test_no_psql_invocation_hides_in_a_shape_the_guard_cannot_read(script: Path):
    """Deny by default: an unrecognised psql call must not pass silently.

    The structured matcher below only reads one shape — a literal list whose
    argv[0] is `"psql"`. A gate review on 2026-09-06 defeated it four ways, each
    of which a careless edit could produce: binding the list to a variable
    first, using a `PSQL_BIN` constant, calling `check_output` instead of `run`,
    and concatenating (`["psql", url] + extra`). All four were never discovered,
    so they passed VACUOUSLY — the same hole the guard exists to close, one
    level up.

    So: inside any function that mentions psql — and at module scope, which an
    earlier version of this test did not walk — every subprocess call must
    either be recognised by the matcher or visibly run a DIFFERENT program
    (argv[0] a string literal that is not "psql"). A new psql shape fails
    loudly and the author picks the canonical form, while an unrelated `git` or
    `pg_dump` call sharing the function is left alone.
    """
    source = script.read_text()
    tree = ast.parse(source)
    recognised = {id(c) for c in _psql_calls(tree)}

    owner = _enclosing_functions(tree)
    for call in _calls_needing_verification(tree, source):
        if id(call) in recognised:
            continue  # the canonical shape — checked by the test below
        if call.args and _runs_a_different_program(call.args[0]):
            continue  # docker / git / pg_dump — not a psql invocation at all
        if (script.name, owner.get(id(call), "")) in _DYNAMIC_ARGV_OK:
            continue  # documented dynamic argv that carries no DSN
        pytest.fail(
            f"{script.name}:{call.lineno} — this subprocess call is in a shape "
            "this guard cannot verify, so it would pass without ever being "
            "checked. Use the canonical form: `argv_dsn, env = psql_env(dsn)` "
            'then `subprocess.run(["psql", argv_dsn, ...], env=env)`.'
        )


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: str(p.relative_to(REPO)))
def test_every_psql_call_passes_a_split_dsn_and_an_env(script: Path):
    tree = ast.parse(script.read_text())
    calls = _psql_calls(tree)
    if not calls:
        pytest.skip(f"{script.name} invokes psql nowhere")

    bound = _psql_env_targets(tree)
    assert bound, (
        f"{script.name} invokes psql but never calls psql_env(). "
        "The DSN is going into argv, where /proc/<pid>/cmdline is world-readable."
    )

    for call in calls:
        line = f"{script.name}:{call.lineno}"

        argv = call.args[0].elts
        assert len(argv) >= 2, f"{line}: psql argv has no connection string"
        dsn_arg = argv[1]
        assert isinstance(dsn_arg, ast.Name) and dsn_arg.id in bound, (
            f"{line}: the DSN argument is not the value returned by psql_env(). "
            "Pass the split DSN, not the raw connection string."
        )

        env_kw = next((k for k in call.keywords if k.arg == "env"), None)
        assert env_kw is not None, (
            f"{line}: psql is invoked without env=, so PGPASSWORD never reaches it."
        )
        assert isinstance(env_kw.value, ast.Name) and env_kw.value.id in bound, (
            f"{line}: env= is not the dict returned by psql_env()."
        )


# ── Regression: absolute-path psql argv must not be exempted (2026-09-07) ──


def _pre_fix_runs_a_different_program(node: ast.AST | None) -> bool:
    """Frozen copy of `_runs_a_different_program`'s body BEFORE the 2026-09-07
    fix. Exists only so the test below can prove, mechanically, that this
    exact shape used to defeat the guard — not as a second implementation to
    keep in sync. Do not update this if `_runs_a_different_program` changes
    again; its whole purpose is to stay wrong.
    """
    if not (isinstance(node, ast.List) and bool(node.elts)):
        return False
    first = node.elts[0]
    if _is_sys_executable(first):
        return True
    return (
        isinstance(first, ast.Constant)
        and isinstance(first.value, str)
        and first.value != "psql"
    )


def _flags_call(call: ast.Call, recognised: set[int], owner: dict[int, str],
                 predicate) -> bool:
    """Re-run the exact decision `test_no_psql_invocation_hides_in_a_shape_the_guard_cannot_read`
    makes for one call, with `predicate` swapped in for `_runs_a_different_program`.
    Returns True if the guard would `pytest.fail` on this call."""
    if id(call) in recognised:
        return False
    if call.args and predicate(call.args[0]):
        return False
    if ("synthetic.py", owner.get(id(call), "")) in _DYNAMIC_ARGV_OK:
        return False
    return True


def test_inline_absolute_path_psql_call_defeats_old_predicate_but_not_new():
    """Regression for the 2026-09-06 gate finding: `subprocess.run(["/opt/homebrew/bin/psql", dsn, ...])`
    used to slip past the guard because `_runs_a_different_program` compared
    argv[0] to the literal string "psql" rather than its basename. This test
    runs the SAME end-to-end decision the real parametrized guard test makes
    (not a paraphrase) through both the pre-fix and current predicate, on a
    call that goes nowhere near `psql_env`.
    """
    source = (
        "import subprocess\n"
        "def call(dsn, q):\n"
        "    subprocess.run(['/opt/homebrew/bin/psql', dsn, '-c', q])\n"
    )
    tree = ast.parse(source)
    recognised = {id(c) for c in _psql_calls(tree)}
    owner = _enclosing_functions(tree)
    calls = _calls_needing_verification(tree, source)
    assert len(calls) == 1, "expected exactly one subprocess call to inspect"
    call = calls[0]
    assert id(call) not in recognised, (
        "sanity check: an absolute-path argv[0] must NOT be the canonical "
        "recognised shape either -- it has to be caught by the deny-by-default "
        "path, not accidentally already allow-listed"
    )

    # OLD predicate: wrongly exempts the call (the bug) -> the guard would NOT
    # have flagged it, and the leak would pass silently, exactly as the
    # 2026-09-06 gate review demonstrated.
    assert _flags_call(call, recognised, owner, _pre_fix_runs_a_different_program) is False, (
        "expected the frozen pre-fix predicate to reproduce the bug (no flag)"
    )

    # NEW predicate: correctly does not exempt it -> the guard flags it as an
    # unverified shape, same as the bare `"psql"` case it already caught.
    assert _flags_call(call, recognised, owner, _runs_a_different_program) is True, (
        "the current predicate must flag an inline absolute-path psql call"
    )


def test_docker_and_psql_lookalike_argv_are_still_exempt():
    """No over-correction: a real different program (`/usr/bin/docker`) and a
    literal that merely shares psql's name as a substring (`"psql-wrapper"`)
    must remain exempt -- only an argv[0] whose basename is EXACTLY "psql"
    counts.
    """
    docker_node = ast.parse('["/usr/bin/docker", "compose", "exec"]', mode="eval").body
    wrapper_node = ast.parse('["psql-wrapper", dsn]', mode="eval").body
    assert _runs_a_different_program(docker_node) is True
    assert _runs_a_different_program(wrapper_node) is True


def test_basename_psql_paths_are_recognised_as_psql():
    """Positive case alongside the regression above: several absolute-path
    shapes that all resolve to a `psql` basename must NOT be exempted."""
    for literal in (
        '["/opt/homebrew/bin/psql", dsn]',
        '["/usr/bin/psql", dsn]',
        '["/usr/local/bin/psql", dsn]',
    ):
        node = ast.parse(literal, mode="eval").body
        assert _runs_a_different_program(node) is False, literal

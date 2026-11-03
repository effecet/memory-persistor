"""Inverted guard: no shell-expanded secret may land in a command's argv.

`tests/test_psql_call_sites.py` is the *enumeration* guard — it walks the AST
of every Python script and proves each `psql` invocation routes its DSN through
`psql_env()`. It cannot see a Makefile recipe or a workflow step that hands a
DSN to `sed` in argv: a Makefile is not Python, so the AST guard has no reach
there at all. That is not a gap in a list — it is a gap in the DOMAIN the list
is drawn from.

So this guard is INVERTED. It does not enumerate known-dangerous call sites and
check them. It asserts a property over every file where shell expansion is the
mechanism: *a variable whose name looks like a secret is never expanded into a
word that becomes a command-line argument.*

Process argv is world-readable — `/proc/<pid>/cmdline` is `-r--r--r--` on Linux,
and `ps` discloses full arguments on macOS. A process environment block is not
(`/proc/<pid>/environ` is `-r--------`). Hence the one exemption below.

────────────────────────────────────────────────────────────────────────────
THE ONE EXEMPTION: assignment-prefix position
────────────────────────────────────────────────────────────────────────────
    DATABASE_URL="$DATABASE_URL" python3 scripts/events_canary.py
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ env, not argv — SAFE, and it is exactly the
                                 shape every fix in this class steers toward.

────────────────────────────────────────────────────────────────────────────
DENY BY DEFAULT
────────────────────────────────────────────────────────────────────────────
Regex-over-Make is brittle. The answer is not a cleverer regex. It is that any
line carrying a secret-shaped expansion which this parser cannot confidently
classify FAILS, rather than passing quietly. Brittleness becomes a loud demand
for an explicit decision instead of a silent miss — the same posture
`test_psql_call_sites.py` already takes.

────────────────────────────────────────────────────────────────────────────
WHY THE TARGET SET IS A FIXED ROOT LIST, NOT A REPO-WIDE GLOB
────────────────────────────────────────────────────────────────────────────
A guard that discovers its own targets must do so within a universe that does
not vary by machine, or its verdict describes the machine rather than the code.

The roots below are fixed and committed, and every file in them is tracked.
A clean CI checkout therefore scans a SUBSET of what a dev machine scans
(untracked scratch files exist only locally). That asymmetry is deliberate and
is the safe direction: a failure in CI necessarily reproduces locally.
`test_each_scan_root_matches_files` asserts PER ROOT, not just in total — a
total-only assert can be satisfied by one root while another matches zero.

Workflow YAML is scanned through `_extract_run_blocks`, which feeds ONLY the
bodies of `run:` steps to the shell parser. Scanning raw YAML would flag
`SOME_TOKEN: ${{ secrets.X }}` — an `env:` mapping, not a command. Leaving
workflows out entirely would leave any token-in-argv fix in them silently
revertible.

────────────────────────────────────────────────────────────────────────────
MUST-NOT-FLAG: make variables
────────────────────────────────────────────────────────────────────────────
    sed "s|@REPO@|$(CURDIR)|g" some.service.template > ...

`$(CURDIR)` is a MAKE variable holding a repo path — single `$`, expanded by
make, never by a shell — and `CURDIR` is not secret-shaped. A predicate keyed
on "sed with a substitution" rather than on the variable NAME would flag it.
Pinned by `test_allows_make_variable_substitution`.

────────────────────────────────────────────────────────────────────────────
KNOWN LIMITS (documented, not silently accepted)
────────────────────────────────────────────────────────────────────────────
Taint tracking is ONE hop: `V=$(… SECRET …)` marks `V` tainted for the rest of
the file, which catches the rename-the-variable evasion. It does not follow a
secret through a file write, an `export` in a sourced script, or `xargs`.
`test_known_limits_are_pinned` records the shapes that still pass, so the next
person widening this guard can see the edge rather than rediscover it.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

#: (root, glob) pairs. Fixed and committed — never a bare repo-wide sweep.
#: Python is deliberately absent: its mechanism is a list literal, not shell
#: expansion, and `test_psql_call_sites.py` already covers it precisely.
SCAN_SPECS: tuple[tuple[Path, str], ...] = (
    (REPO, "Makefile"),
    (REPO / "scripts", "*.sh"),
    (REPO / ".github" / "workflows", "*.yml"),
)

#: A variable name that may hold a credential. Case-insensitive: shell
#: convention is uppercase, but a lowercase `$db_password` leaks just as widely.
#: The `_KEY` / `_PASS` / `CREDENTIAL` / `_PAT` families were added after a
#: review found names like `SUPABASE_SERVICE_ROLE_KEY`, `ANON_KEY`, `SMTP_PASS` and
#: `GITEA_ACCOUNTS` all sailing past the original pattern.
SECRET_NAME_RE = re.compile(
    r"""^(
          DATABASE_URL | DB_URL | .*_DATABASE_URL | DSN | .*_DSN
        | PGPASSWORD | PASSWORD | .*_PASSWORD | .*_PASSWD | .*_PASS
        | .*CONNECTION_STRING
        | .*_SECRET | SECRET | .*_TOKEN | TOKEN | .*_PAT
        | .*_KEY | API_?KEY | .*CREDENTIAL.*
        | GITEA_ACCOUNTS
        )$""",
    re.IGNORECASE | re.VERBOSE,
)

#: Site-scoped exemptions, keyed by ``(repo-relative path, variable name)``.
#: Repo-global name exemptions were rejected in review: one entry would excuse
#: that name in every file forever, and the first use would be where its
#: semantics got discovered. Empty by design — an entry is a decision someone
#: must justify. `test_allowed_site_suppresses_a_real_violation` proves it works.
ALLOWED_ARGV_SITES: frozenset[tuple[str, str]] = frozenset()


class Unclassifiable(Exception):
    """The parser met a construct it cannot reason about safely."""


def _leading_identifier(text: str) -> str:
    """Strip parameter-expansion modifiers: `${DB_URL:-x}` -> `DB_URL`.

    Without this, `${DATABASE_URL:-}` and `${TOKEN#Bearer }` slipped past the
    anchored name pattern silently — a miss, not a deny-by-default failure.
    """
    m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", text.strip())
    return m.group(0) if m else ""


def _read_expansion(text: str, i: int) -> tuple[str | None, str | None, int]:
    """Read the `$…` expansion starting at ``text[i]``.

    Returns ``(name, subshell_body, advance)``. Exactly one of ``name`` and
    ``subshell_body`` is non-None, or both are None for a `$` that expands
    nothing we care about (`$$` = PID, a bare `$`, a Make `$(VAR)`).
    """
    n = len(text)
    rest = text[i + 1 :]

    # `${{ secrets.DATABASE_URL }}` — Actions expression syntax.
    if rest.startswith("{{"):
        end = text.find("}}", i)
        if end == -1:
            raise Unclassifiable("unterminated ${{ }} expression")
        inner = text[i + 3 : end].strip()
        return inner.split(".")[-1].strip(), None, (end + 2) - i

    # `${NAME}`, `${NAME:-default}`, `${NAME#prefix}` …
    if rest.startswith("{"):
        end = text.find("}", i)
        if end == -1:
            raise Unclassifiable("unterminated ${ }")
        return _leading_identifier(text[i + 2 : end]), None, (end + 1) - i

    # `$(...)` — a command substitution. Scanned recursively; a secret
    # interpolated inside a subshell is still a leak.
    if rest.startswith("("):
        depth, j = 0, i + 1
        while j < n:
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
                if depth == 0:
                    return None, text[i + 2 : j], (j + 1) - i
            j += 1
        raise Unclassifiable("unterminated $( )")

    # `$$` is the shell's PID, not an expansion of a named variable.
    if rest.startswith("$"):
        return None, None, 2

    m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", rest)
    if m:
        return m.group(0), None, 1 + len(m.group(0))
    return None, None, 1


#: Sentinel words emitted by the tokenizer.
_SEPARATOR = "\0sep"
_REDIRECT = "\0redir"


def _split_words(segment: str) -> list[tuple[str, list[str], list[str]]]:
    """Tokenize shell text into words, honouring quotes and nesting.

    Each word is ``(text, expanded_names, subshell_bodies)``. Names inside
    single quotes are omitted — single quotes suppress expansion, so the
    secret's *value* never reaches argv there.

    Statement separators (``; | & && ||``) and redirections (``> >> <``) are
    emitted as sentinel words rather than split out beforehand. Splitting the
    line with a regex first was wrong: it cut `$(grep … | cut …)` in half at
    the pipe *inside* the subshell and left an unbalanced paren behind.

    Raises ``Unclassifiable`` on unbalanced quoting.
    """
    words: list[tuple[str, list[str], list[str]]] = []
    cur, names, subs = "", [], []
    started = False
    quote: str | None = None
    i = 0

    def flush() -> None:
        nonlocal cur, names, subs, started
        if started or cur:
            words.append((cur, names, subs))
        cur, names, subs, started = "", [], [], False

    while i < len(segment):
        c = segment[i]
        if quote == "'":
            if c == "'":
                quote = None
            else:
                cur += c
            i += 1
            continue
        if c == "\\":
            # Outside single quotes a backslash escapes the next character.
            # Without this, sed's `'\''` idiom (close-quote, literal quote,
            # reopen) desynchronises the quote state and the whole line reads
            # as unbalanced — which deny-by-default then reports as a failure.
            cur += segment[i : i + 2]
            started = True
            i += 2
            continue
        if c == "'" and quote is None:
            quote, started = "'", True
            i += 1
            continue
        if c == '"':
            quote = None if quote == '"' else '"'
            started = True
            i += 1
            continue
        if c == "`":
            # Backtick substitution. Legacy but still valid, and it carries no
            # `$`, so an earlier fast-path skipped these lines entirely.
            end = segment.find("`", i + 1)
            if end == -1:
                raise Unclassifiable("unterminated backtick")
            subs.append(segment[i + 1 : end])
            cur += segment[i : end + 1]
            started = True
            i = end + 1
            continue
        if quote is None and c.isspace():
            flush()
            i += 1
            continue
        if quote is None and c in ";|&":
            flush()
            words.append((_SEPARATOR, [], []))
            while i < len(segment) and segment[i] in ";|&":
                i += 1
            continue
        if quote is None and c in "<>":
            flush()
            words.append((_REDIRECT, [], []))
            while i < len(segment) and segment[i] in "<>":
                i += 1
            continue
        if c == "$":
            name, body, adv = _read_expansion(segment, i)
            if name:
                names.append(name)
            if body is not None:
                subs.append(body)
            cur += segment[i : i + adv]
            started = True
            i += adv
            continue
        cur += c
        started = True
        i += 1

    if quote is not None:
        raise Unclassifiable("unbalanced quoting")
    flush()
    return words


_ASSIGNMENT_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")

#: How many following lines may be absorbed to close a multi-line `$( )`
#: or quoted string. Bounded so a genuinely broken file fails fast rather
#: than swallowing the rest of the script into one statement.
_MAX_CONTINUATION_LINES = 12

#: Words that introduce a command rather than being one. `command` resets to
#: None after each, so the NEXT word is classified as the program.
SHELL_KEYWORDS: frozenset[str] = frozenset({
    "if", "then", "elif", "else", "fi", "while", "until", "do", "done",
    "case", "esac", "for", "in", "function", "{", "}", "!", "(", ")",
    "time", "coproc",
})

#: Shell builtins fork no process, so they create no `/proc/<pid>/cmdline` and
#: no `ps` entry — a secret in their arguments is never disclosed. This is the
#: distinction between `test -n "$$DB_URL"` (a test, NOT a leak) and
#: `sed …$$DB_URL…` (an argv leak).
#:
#: `echo` and `printf` are builtins in both `dash` (Make's default `/bin/sh`)
#: and `bash`, which is what runs every recipe and CI step here. `let`,
#: `declare` and `typeset` are bash-only — absent in dash, where they would be
#: "command not found" rather than a leak, so listing them is still sound.
#:
#: `eval`, `exec`, `source` and `.` are DELIBERATELY ABSENT: each one goes on
#: to run other code, so a secret in their arguments can still reach a real
#: process's argv. Exempting them would open the widest hole in this guard.
#: Builtins that DECLARE variables. Their operands are assignments, so taint
#: must propagate through them exactly as it does for a bare `NAME=value`.
_DECLARATION_BUILTINS: frozenset[str] = frozenset({
    "export", "local", "readonly", "declare", "typeset",
})

SHELL_BUILTINS: frozenset[str] = frozenset({
    "test", "[", "[[", "echo", "printf", ":", "true", "false",
    "cd", "export", "readonly", "local", "read", "set", "unset",
    "shift", "return", "exit", "umask", "pwd", "wait", "trap",
    "alias", "unalias", "break", "continue", "let", "declare", "typeset",
})


def _normalize_make(line: str) -> str:
    """Reduce a Makefile recipe line to the shell text `make` will run.

    Make expands `$(VAR)` / `${VAR}` itself and passes the RESULT to the shell,
    so those are not shell expansions at all — they are blanked. `$$` is Make's
    escape for a literal `$`, which is what the shell then sees.
    """
    line = re.sub(r"(?<!\$)\$[({][^)}]*[)}]", "_MAKEVAR_", line)
    return line.replace("$$", "$")


def _extract_run_blocks(text: str) -> list[tuple[int, str]]:
    """Return ``(line_number, shell_line)`` for every `run:` body in a workflow.

    Only `run:` bodies are shell. Feeding raw YAML to the shell parser flagged
    `NOTIFY_TOKEN: ${{ secrets.X }}` — an `env:` mapping — as a command
    invocation, which on a single-runner CI would have blocked every push.
    A dependency-free scan is used deliberately: the CI job installs only
    pytest, httpx, respx and python-dotenv, so PyYAML is not available.
    """
    out: list[tuple[int, str]] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        # The block boundary is the column of `run:` ITSELF, not the column of
        # the list dash. Measuring from the dash put the boundary too far left,
        # so sibling keys at the step's own indent (`env:` and its mappings)
        # were swallowed into the run body and parsed as shell — reintroducing
        # exactly the `NOTIFY_TOKEN: ${{ secrets.X }}` false positive that
        # would fail CI. Only the `- run: |` spelling was
        # affected, which is why the current workflows did not expose it.
        m = re.match(r"^(\s*(?:-\s+)?)run:\s*(\S.*)?$", raw)
        if not m:
            i += 1
            continue
        indent, inline = len(m.group(1)), (m.group(2) or "").strip()
        i += 1
        if inline and inline not in {"|", ">", "|-", ">-", "|+", ">+"}:
            out.append((i, inline))  # single-line `run: cmd`
            continue
        # Block scalar: every following line indented deeper than the key.
        while i < len(lines):
            body = lines[i]
            if body.strip() and (len(body) - len(body.lstrip())) <= indent:
                break
            out.append((i + 1, body))
            i += 1
    return out


def _join_continuations(pairs: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Fold trailing-backslash continuations into one logical line.

    This must happen BEFORE any "does this line mention a secret" fast path.
    Skipping a continuation line because it has no `$` left the NEXT line to be
    parsed as a fresh statement, so its first word — often a bare argument like
    `"$ENV_TOKEN"` — was mistaken for the command, losing the builtin exemption
    and producing a false positive on correct code.
    """
    joined: list[tuple[int, str]] = []
    buf, start = "", 0
    for lineno, raw in pairs:
        stripped = raw.strip()
        if not buf:
            start = lineno
        if stripped.endswith("\\"):
            buf = f"{buf} {stripped[:-1].strip()}".strip()
            continue
        joined.append((start, f"{buf} {stripped}".strip() if buf else stripped))
        buf = ""
    if buf:
        joined.append((start, buf))
    return joined


def _strip_comment(line: str, quote: str | None = None) -> tuple[str, str | None]:
    """Remove a trailing `#` comment, respecting quote state.

    Comments are not shell words, but they ARE text, and an apostrophe in one
    ("via curl's stdin config") opens a single quote that never closes —
    desynchronising every following line in the file. That surfaced as a
    spurious "unbalanced quoting" deny-by-default failure on a correct script.

    A `#` only starts a comment at a word boundary, so `${TOKEN#Bearer }` and
    `https://host/path#frag` are left intact.

    Stripping is deliberately PER LINE, with no quote state carried in. Threading
    state across lines was tried and reverted: a single line with an odd number
    of quotes — routine in Makefile comments and in `sed 's/x/y/'` recipes —
    poisons every following line, leaving real comments unstripped and producing
    repo-wide false positives (measured: a Makefile comment parsed as a
    command named `#`). The cost of per-line is one narrow miss, pinned in
    `test_known_limits_are_pinned`: a line that STARTS with `#` while inside a
    multi-line double-quoted string is treated as a comment and dropped.
    A false negative on a contrived shape beats false positives that would block
    every push on the single CI runner.

    Truncating at the `#` also means the comment's own text never updates the
    quote state, which is what stops an apostrophe in prose ("via curl's stdin
    config") from desynchronising every following line.
    """
    i = 0
    while i < len(line):
        c = line[i]
        if quote == "'":
            if c == "'":
                quote = None
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c == "'":
            quote = "'"
            i += 1
            continue
        if c == '"':
            quote = None if quote == '"' else '"'
            i += 1
            continue
        if c == "#" and quote is None and (i == 0 or line[i - 1].isspace()):
            return line[:i], quote
        i += 1
    return line, quote


def _group_balanced(pairs: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Group physical lines into complete statements by balancing quotes.

    This runs BEFORE any "does this line mention a secret" filter, and that
    ordering is the whole point. A `$`-first fast path skipped
    `MSG="🚨 <b>CI Failed</b>` (no `$` on that line), so scanning *began* at the
    line which merely CLOSED the string — `…</a>" ;;` — read its stray quote as
    unbalanced, and absorbed forward until it hit the cap. Both CI workflows
    reported "unclosed after 12 lines" from exactly that.

    A group is emitted as soon as `_split_words` can parse it. If it still
    cannot after `_MAX_CONTINUATION_LINES`, the group is emitted anyway so
    deny-by-default gets its chance to report it rather than silently absorbing
    the rest of the file.
    """
    out: list[tuple[int, str]] = []
    buf, start, pending = "", None, 0
    for lineno, line in pairs:
        if start is None:
            start = lineno
        buf = f"{buf} {line.strip()}".strip() if buf else line.strip()
        if not buf:
            start = None
            continue
        try:
            _split_words(buf)
        except Unclassifiable:
            pending += 1
            if pending <= _MAX_CONTINUATION_LINES:
                continue
        out.append((start, buf))
        buf, start, pending = "", None, 0
    if buf:
        out.append((start or 1, buf))
    return out


def scan_text(
    text: str,
    *,
    is_make: bool = False,
    is_yaml: bool = False,
    rel_path: str = "",
) -> list[tuple[int, str]]:
    """Return ``(line_number, reason)`` for every violation in ``text``."""
    violations: list[tuple[int, str]] = []

    if is_yaml:
        pairs = _extract_run_blocks(text)
    else:
        pairs = list(enumerate(text.splitlines(), start=1))

    if is_make:
        pairs = [(n, _normalize_make(ln)) for n, ln in pairs]
    pairs = [(n, _strip_comment(ln)[0]) for n, ln in pairs]

    #: Names proven to hold a secret by an earlier assignment in this file.
    tainted: set[str] = set()

    for start_line, stmt in _group_balanced(_join_continuations(pairs)):
        if "$" not in stmt and "`" not in stmt:
            continue
        try:
            reasons = _scan_statement_tree(stmt, tainted=tainted, rel_path=rel_path)
        except Unclassifiable as exc:
            # Deny by default — but only when a secret is plausibly in play,
            # so odd-but-harmless shell does not wedge the suite.
            if _mentions_secret_name(stmt, tainted):
                violations.append(
                    (start_line, f"cannot classify a line carrying a secret name: {exc}")
                )
            continue
        violations.extend((start_line, r) for r in reasons)
    return violations


def _is_secret_name(name: str, tainted: set[str]) -> bool:
    return bool(SECRET_NAME_RE.match(name)) or name in tainted


def _mentions_secret_name(text: str, tainted: set[str] | None = None) -> bool:
    return any(
        _is_secret_name(tok, tainted or set())
        for tok in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text)
    )


def _scan_statement_tree(
    shell: str, *, tainted: set[str], rel_path: str = ""
) -> list[str]:
    """Scan one shell line, recursing into `$( )` and backtick substitutions."""
    reasons: list[str] = []
    command: str | None = None  # None => still in the assignment-prefix run
    pending_redirect = False

    for text_, names, subs in _split_words(shell):
        # A subshell's contents are their own statement tree, and a secret
        # interpolated one level down is just as exposed.
        for body in subs:
            reasons.extend(
                _scan_statement_tree(body, tainted=tainted, rel_path=rel_path)
            )

        if text_ == _SEPARATOR:
            command, pending_redirect = None, False
            continue
        if text_ == _REDIRECT:
            pending_redirect = True
            continue
        if pending_redirect:
            # A redirect target is a path the shell opens itself; it never
            # becomes an argument to the command.
            pending_redirect = False
            continue

        # Shell keywords introduce a new command rather than being one. Without
        # this, `if [ -z "$TOKEN" ]` reports its command as `if` and so misses
        # the `[` builtin exemption entirely.
        if text_ in SHELL_KEYWORDS:
            command = None
            continue

        # `export URLV="$DATABASE_URL"` is an assignment too. Without treating
        # declaration builtins this way, `command` became "export" and the
        # following word never reached the taint branch, so aliasing through
        # `export`/`local`/`readonly` laundered the secret silently.
        in_declaration = command in _DECLARATION_BUILTINS
        assign = (
            _ASSIGNMENT_RE.match(text_)
            if (command is None or in_declaration)
            else None
        )
        if assign:
            # ONE-HOP TAINT. `V=$(grep '^DATABASE_URL=' .env)` then `sed "…$V…"`
            # renames the secret and evades a name-only predicate; review
            # demonstrated exactly that against a Makefile recipe. Record the
            # alias so later uses are caught.
            lhs = assign.group(1)
            if any(_mentions_secret_name(b, tainted) for b in subs) or any(
                _is_secret_name(n, tainted) for n in names
            ):
                tainted.add(lhs)
            continue  # env assignment prefix — the safe shape, by design

        if command is None:
            command = text_

        # Builtins fork nothing, so nothing is disclosed. See SHELL_BUILTINS.
        if command in SHELL_BUILTINS:
            continue

        # A command substitution's OUTPUT is spliced into this word, which is
        # then handed to `command` as an argument. So a secret reaching the
        # subshell's stdout leaks even when the subshell itself only used
        # builtins: `cmd "$(printf %s "$PGPASSWORD")"` discloses via cmd's argv,
        # not printf's. Recursing into the body alone would miss this entirely.
        for body in subs:
            if _mentions_secret_name(body, tainted):
                reasons.append(
                    f"a command substitution whose output may carry a secret is "
                    f"spliced into an argv word ({text_!r}) passed to {command!r}; "
                    "pass it in the environment instead"
                )

        for name in names:
            if _is_secret_name(name, tainted) and (rel_path, name) not in ALLOWED_ARGV_SITES:
                reasons.append(
                    f"${name} expands into an argv word ({text_!r}) passed to "
                    f"{command!r}; pass it in the environment instead"
                )
    return reasons


def scan_files() -> list[Path]:
    found: list[Path] = []
    for root, pattern in SCAN_SPECS:
        if root.is_dir():
            found.extend(sorted(root.glob(pattern)))
        elif (root / pattern).is_file():
            found.append(root / pattern)
    return found


def _scan_path(path: Path) -> list[tuple[int, str]]:
    return scan_text(
        path.read_text(encoding="utf-8", errors="replace"),
        is_make=path.name == "Makefile",
        is_yaml=path.suffix in {".yml", ".yaml"},
        rel_path=str(path.relative_to(REPO)),
    )


# ─────────────────────────── the guard itself ───────────────────────────


def test_no_secret_is_interpolated_into_argv():
    failures: list[str] = []
    for path in scan_files():
        for lineno, reason in _scan_path(path):
            failures.append(f"{path.relative_to(REPO)}:{lineno}: {reason}")
    assert not failures, "secret expanded into argv:\n" + "\n".join(failures)


@pytest.mark.parametrize(
    "root,pattern",
    [(r, p) for r, p in SCAN_SPECS if r.name != "scripts" or p != "*.sh"],
)
def test_each_scan_root_matches_files(root, pattern):
    """Per-root, because a total-only assert hid a root matching zero files.

    A total-only assert can be satisfied by one root alone, so a moved or
    renamed root would have gone unnoticed — the vacuity this is meant to stop.
    `scripts/*.sh` is excluded above: that directory legitimately holds no shell
    scripts today, and the spec is kept so a future one is covered on arrival.
    """
    matched = sorted(root.glob(pattern)) if root.is_dir() else [root / pattern]
    assert [p for p in matched if p.is_file()], f"no files matched {root}/{pattern}"


def test_workflows_are_actually_scanned():
    """The regression cover for this commit's own workflow fixes.

    Reviewers found that omitting the workflow directory left token-in-argv
    fixes there silently revertible.
    """
    scanned = {p.name for p in scan_files()}
    assert "ci.yml" in scanned, scanned


def test_reverting_the_workflow_fix_is_caught():
    """Executes the revert rather than asserting on source text."""
    pre_fix = (
        '      - name: notify\n'
        '        run: |\n'
        '          HTTP_CODE=$(curl -sS -o /tmp/r.json -w "%{http_code}" \\\n'
        '            --data-urlencode "chat_id=${CHAT_ID}" \\\n'
        '            "https://notify.example.com/bot${NOTIFY_TOKEN}/sendMessage")\n'
    )
    assert scan_text(pre_fix, is_yaml=True), "revert of the workflow fix not caught"


def test_yaml_env_mapping_is_not_mistaken_for_a_command():
    """The false positive that would have failed CI."""
    env_block = (
        "        env:\n"
        "          NOTIFY_TOKEN: ${{ secrets.NOTIFY_CI_TOKEN }}\n"
        '          CHAT_ID: "100000000"\n'
    )
    assert not scan_text(env_block, is_yaml=True)


# ────────────────── evasion + false-positive pinning ──────────────────


def test_flags_the_sed_form_that_issue_77_found():
    """The exact shape of a DSN handed to sed in argv, as a mutation control."""
    make_line = 'sed "s|@DATABASE_URL@|$$DB_URL|" in.plist > out.plist'
    assert scan_text(make_line, is_make=True), "guard blind to the argv audit leak"


@pytest.mark.parametrize(
    "line",
    [
        'psql "$DATABASE_URL" -c "select 1"',
        "psql ${DATABASE_URL} -c 'select 1'",
        'foo --dsn="$MY_DSN"',
        'curl "https://api.example.com/bot${{ secrets.NOTIFY_TOKEN }}/send"',
        # Substitution OUTPUT becomes the outer command's argument, even though
        # the inner command is a fork-free builtin.
        'cmd "$(printf %s "$PGPASSWORD")"',
        'psql "$(cat /run/secrets/DB_URL)" -c "select 1"',
        # Parameter-expansion modifiers used to slip the anchored name match.
        'psql "${DATABASE_URL:-}" -c x',
        'curl -H "Auth: ${GITEA_TOKEN#Bearer }" u',
        # Backticks carry no `$`, so an earlier fast path skipped the line.
        "psql `cat /run/secrets/DB_URL`",
        # Secret families a review found missing from the name pattern.
        'curl -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" u',
        'mysql --password="$SMTP_PASS"',
    ],
)
def test_flags_evasion_shapes(line):
    assert scan_text(line, is_make=False), f"guard evaded by: {line}"


def test_flags_the_rename_the_variable_evasion():
    """One-hop taint: aliasing the secret must not launder it.

    Review demonstrated this against a Makefile recipe — renaming `DB_URL` to
    `URLV` left the leak byte-identical and the suite green.
    """
    make_lines = (
        "URLV=$$(grep '^DATABASE_URL=' .env.supabase | cut -d= -f2-)\n"
        'sed "s|@DATABASE_URL@|$$URLV|" in.plist > out.plist\n'
    )
    assert scan_text(make_lines, is_make=True), "alias evaded the guard"


@pytest.mark.parametrize(
    "line,is_make",
    [
        # The target pattern: env, not argv.
        ('DATABASE_URL="$$DATABASE_URL" python3 scripts/events_canary.py', True),
        ("PGPASSWORD=postgres psql -h postgres -U postgres -c 'select 1'", False),
        # Make variable holding a repo path — the near-miss that would have
        # red-CI'd an install target.
        ('sed "s|@REPO@|$(CURDIR)|g" some.service.template', True),
        # The literal NAME, never the value.
        ("grep -E '^DATABASE_URL' .env > $$ENVFILE", True),
        ('echo "plist contains DATABASE_URL"', True),
        ("node -e 'const u = process.env.DATABASE_URL'", True),
        # Single quotes suppress expansion outright.
        ("echo '$DATABASE_URL'", False),
        # Value flows on stdin, not argv.
        ("DB_URL=$$(grep '^DATABASE_URL=' .env.supabase | cut -d= -f2-)", True),
    ],
)
def test_allows_safe_shapes(line, is_make):
    assert not scan_text(line, is_make=is_make), f"false positive on: {line}"


@pytest.mark.parametrize(
    "line",
    [
        'test -n "$DB_URL"',  # a test, not a leak
        '[ -z "$NOTIFY_TOKEN" ] && exit 0',  # a test, not a leak
        '[ "$ENV_TOKEN" != "$CJSON_TOKEN" ]',  # a comparison, not a command
        'printf %s "$PGPASSWORD"',
        'export DATABASE_URL="$DATABASE_URL"',
    ],
)
def test_allows_shell_builtins(line):
    """Builtins fork no process, so they create no world-readable argv."""
    assert not scan_text(line, is_make=False), f"false positive on builtin: {line}"


def test_allows_builtin_call_split_across_continuation_lines():
    """The false positive that would have blocked the single CI runner.

    Reflowing a correct `printf … | curl --config -` so the secret sits on its
    own continuation line used to report the ARGUMENT as the command, losing
    the builtin exemption.
    """
    reflowed = (
        "printf 'header = \"Authorization: token %s\"\\n' \\\n"
        '    "$ENV_TOKEN" \\\n'
        "    | curl -sS --config - https://git.example.org/api/v1/user\n"
    )
    assert not scan_text(reflowed, is_make=False), "reflowed builtin false-positived"


def test_allows_make_variable_substitution():
    """Regression pin for the make-variable case described in the module docstring."""
    line = 'sed "s|@REPO@|$(CURDIR)|g" some.service.template > out.service'
    assert not scan_text(line, is_make=True)


def test_denies_by_default_on_unparseable_line_carrying_a_secret():
    line = 'psql "$DATABASE_URL --unbalanced'
    reasons = scan_text(line, is_make=False)
    assert reasons, "unparseable line carrying a secret must fail, not pass"
    assert "cannot classify" in reasons[0][1]


def test_unparseable_line_without_a_secret_is_not_flagged():
    """Deny-by-default is scoped to secrets, so odd shell does not wedge CI."""
    assert not scan_text('echo "unbalanced', is_make=False)


def test_continuation_cap_is_enforced():
    """A construct that never closes must fail, not swallow the whole file."""
    runaway = 'psql "$DATABASE_URL $(\n' + "".join(f"echo {i}\n" for i in range(40))
    reasons = scan_text(runaway, is_make=False)
    assert reasons and "cannot classify" in reasons[0][1]


def test_allowed_site_suppresses_a_real_violation(monkeypatch):
    """`ALLOWED_ARGV_SITES` is empty, so prove the escape hatch works at all."""
    line = 'psql "$DATABASE_URL" -c x'
    assert scan_text(line, rel_path="demo.sh")
    monkeypatch.setattr(
        sys.modules[__name__],
        "ALLOWED_ARGV_SITES",
        frozenset({("demo.sh", "DATABASE_URL")}),
    )
    assert not scan_text(line, rel_path="demo.sh")
    # Site-scoped: the same name in another file is still caught.
    assert scan_text(line, rel_path="other.sh")


@pytest.mark.parametrize(
    "line",
    [
        # Secret laundered through a file the guard does not read.
        'echo "$DATABASE_URL" > /tmp/x; psql "$(cat /tmp/x)" -c y',
        # xargs turns stdin into argv; tracking that needs real dataflow.
        'echo "$DATABASE_URL" | xargs psql -c x',
        # A `#` opening a line INSIDE a multi-line string is dropped as a
        # comment. See `_strip_comment` for why per-line stripping is the
        # deliberate trade against repo-wide false positives.
        'MSG="one\n#$DATABASE_URL\n"\ncurl -d "$MSG" https://x',
    ],
)
def test_known_limits_are_pinned(line):
    """Records what still evades, so the edge is visible rather than assumed.

    These are NOT endorsements. Taint is one hop by design; a guard that
    claimed full dataflow would be lying. If you widen the guard, delete the
    corresponding case here — it failing is the signal you succeeded.
    """
    assert not scan_text(line, is_make=False), (
        "this limit is now closed — delete this case from the parametrize list"
    )


def test_apostrophe_in_a_comment_does_not_desynchronise_the_parser():
    """An apostrophe in a comment used to open a quote that never closed.

    Every following line in the file was then mis-parsed, surfacing as a
    spurious deny-by-default failure on correct code — a false positive, which
    on this repo's single CI runner blocks every push for every machine.
    """
    script = (
        "# The header travels via curl's stdin config, never argv.\n"
        "printf 'header = \"Authorization: token %s\"\\n' \"$ENV_TOKEN\" \\\n"
        "    | curl -sS --config - https://git.example.org/api/v1/user\n"
    )
    assert not scan_text(script, is_make=False)


def test_hash_inside_a_word_is_not_treated_as_a_comment():
    """`${TOKEN#Bearer }` and URL fragments must survive comment stripping."""
    assert scan_text('curl -H "Auth: ${GITEA_TOKEN#Bearer }" https://x/y#frag')


def test_dash_run_block_does_not_swallow_sibling_keys():
    """`- run: |` measured its boundary from the dash, not from `run:`.

    That pulled the step's own `env:` mapping into the shell body, resurrecting
    the `NOTIFY_TOKEN: ${{ secrets.X }}` false positive that would fail
    CI. Only this spelling was affected, so neither current workflow
    exposed it — it was armed for the next step written this way.
    """
    dash_form = (
        "      - run: |\n"
        "          echo hi\n"
        "        env:\n"
        "          NOTIFY_TOKEN: ${{ secrets.NOTIFY_CI_TOKEN }}\n"
    )
    assert not scan_text(dash_form, is_yaml=True)


def test_dash_run_block_still_scans_its_own_body():
    """The boundary fix must not stop `- run:` bodies being scanned at all."""
    dash_form = (
        "      - run: |\n"
        '          curl "https://x/bot${NOTIFY_TOKEN}/send"\n'
    )
    assert scan_text(dash_form, is_yaml=True)


@pytest.mark.parametrize("keyword", ["export", "local", "readonly", "declare"])
def test_taint_survives_a_declaration_builtin(keyword):
    """Aliasing through `export` laundered the secret past the name predicate.

    `export DATABASE_URL="$DATABASE_URL"` is legitimately exempt (env, not
    argv), which made this refactor a likely one to reach for.
    """
    script = f'{keyword} URLV="$DATABASE_URL"\nsed "s|@X@|$URLV|" in > out\n'
    assert scan_text(script, is_make=False), f"{keyword} laundered the secret"


def test_declaring_a_secret_into_the_environment_is_still_allowed():
    """The exemption the fix above must not break."""
    assert not scan_text('export DATABASE_URL="$DATABASE_URL"')

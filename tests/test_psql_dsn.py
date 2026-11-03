"""Tests for scripts/psql_dsn.py — keeping the DB password out of psql's argv.

The security property under test is narrow and absolute: whatever comes back as
the argv DSN must not contain the password, for every DSN shape we actually
meet. Tests assert the HARM (password absent from argv) rather than the shape of
the return value, so a refactor that keeps the API but reintroduces the leak
still fails.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import psql_dsn as pd  # noqa: E402

PW = "hunter2-s3cret"


# ── the security property ────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "dsn",
    [
        f"postgresql://user:{PW}@db.example.com:6543/postgres",
        f"postgres://user:{PW}@db.example.com/postgres",
        f"postgresql://user:{PW}@db.example.com:6543/postgres?sslmode=require",
        f"host=db.example.com user=u password={PW} dbname=postgres",
    ],
)
def test_password_never_survives_into_argv(dsn):
    argv_dsn, env = pd.psql_env(dsn, base_env={})
    assert PW not in argv_dsn
    assert env["PGPASSWORD"] == PW


def test_the_rest_of_the_dsn_survives():
    argv_dsn, _ = pd.psql_env(
        f"postgresql://user:{PW}@db.example.com:6543/postgres?sslmode=require",
        base_env={},
    )
    assert argv_dsn == "postgresql://user@db.example.com:6543/postgres?sslmode=require"


# ── percent-encoding: PGPASSWORD takes the LITERAL value ─────────────────────
def test_percent_encoded_password_is_decoded_for_pgpassword():
    # @ / % in a password must be percent-encoded inside a URI, but libpq wants
    # the raw value. Handing PGPASSWORD the still-encoded form authenticates
    # with the wrong string — and it fails only for exotic passwords, so it
    # survives casual testing.
    _, env = pd.psql_env("postgresql://u:p%40ss%2Fw%25rd@h/db", base_env={})
    assert env["PGPASSWORD"] == "p@ss/w%rd"


def test_username_is_preserved_verbatim():
    argv_dsn, _ = pd.psql_env(f"postgresql://postgres.abcdefg:{PW}@h:6543/db", base_env={})
    assert argv_dsn.startswith("postgresql://postgres.abcdefg@h:6543/db")


# ── IPv6: urlsplit().hostname strips the brackets ────────────────────────────
def test_ipv6_literal_keeps_its_brackets():
    argv_dsn, env = pd.psql_env(f"postgresql://u:{PW}@[2001:db8::1]:5432/db", base_env={})
    assert argv_dsn == "postgresql://u@[2001:db8::1]:5432/db"
    assert env["PGPASSWORD"] == PW


# ── no password present ──────────────────────────────────────────────────────
def test_passwordless_uri_is_returned_unchanged():
    dsn = "postgresql://u@localhost:5432/memory_persistor"
    argv_dsn, env = pd.psql_env(dsn, base_env={})
    assert argv_dsn == dsn
    assert "PGPASSWORD" not in env


def test_passwordless_dsn_does_not_clear_an_ambient_pgpassword():
    # Supplying the password through the environment is a legitimate setup.
    # Popping it here would be an availability regression dressed as hardening.
    _, env = pd.psql_env(
        "postgresql://u@localhost/db", base_env={"PGPASSWORD": "from-the-environment"}
    )
    assert env["PGPASSWORD"] == "from-the-environment"


def test_dsn_password_overrides_an_ambient_pgpassword():
    _, env = pd.psql_env(f"postgresql://u:{PW}@h/db", base_env={"PGPASSWORD": "stale"})
    assert env["PGPASSWORD"] == PW


# ── conninfo (keyword/value) form ────────────────────────────────────────────
def test_conninfo_password_is_extracted_and_removed():
    argv_dsn, env = pd.psql_env(f"host=h user=u password={PW} dbname=db", base_env={})
    assert env["PGPASSWORD"] == PW
    assert "password" not in argv_dsn
    assert "host=h" in argv_dsn and "user=u" in argv_dsn and "dbname=db" in argv_dsn


def test_conninfo_single_quoted_password_with_spaces():
    argv_dsn, env = pd.psql_env("host=h password='two words' dbname=db", base_env={})
    assert env["PGPASSWORD"] == "two words"
    assert "two words" not in argv_dsn


def test_conninfo_without_password_is_unchanged():
    dsn = "host=h user=u dbname=db"
    argv_dsn, env = pd.psql_env(dsn, base_env={})
    assert argv_dsn == dsn
    assert "PGPASSWORD" not in env


# ── env plumbing ─────────────────────────────────────────────────────────────
def test_base_env_is_copied_not_mutated():
    base = {"PATH": "/usr/bin"}
    _, env = pd.psql_env(f"postgresql://u:{PW}@h/db", base_env=base)
    assert "PGPASSWORD" not in base, "psql_env must not mutate the caller's env"
    assert env["PATH"] == "/usr/bin"


def test_base_env_defaults_to_os_environ(monkeypatch):
    monkeypatch.setenv("PSQL_DSN_MARKER", "present")
    _, env = pd.psql_env(f"postgresql://u:{PW}@h/db")
    assert env["PSQL_DSN_MARKER"] == "present"


def test_split_reports_absent_when_there_is_no_password():
    split = pd.split_dsn_password("postgresql://u@h/db")
    assert (split.argv_dsn, split.password, split.state) == (
        "postgresql://u@h/db", None, "absent")


def test_percent_encoded_username_is_not_double_encoded():
    # quote() on an already-encoded username turns %40 into %2540. Our real
    # usernames are plain, so this would have shipped silently.
    argv_dsn, _ = pd.psql_env(f"postgresql://user%40tenant:{PW}@h:6543/db", base_env={})
    assert argv_dsn == "postgresql://user%40tenant@h:6543/db"


# ── unparseable DSNs: pass through, warn, never raise ────────────────────────
# Only shapes that make urlsplit ITSELF raise. The valid-but-awkward DSNs
# (multi-host, non-integer port) deliberately do NOT belong here any more —
# _split_uri works on the raw netloc so they parse correctly. If one of them
# reappears in this list, the netloc rewrite has regressed.
UNPARSEABLE = [
    "postgresql://u:p@[bad",     # urlsplit raises: Invalid IPv6 URL
    "postgresql://u:p@[::1/db",  # unterminated IPv6 bracket
]


@pytest.mark.parametrize("dsn", UNPARSEABLE)
def test_unparseable_dsn_passes_through_and_never_raises(dsn):
    # Decided 2026-09-06: this module sits under the hourly canary and
    # memory-decay, so a parser hole must not take monitoring down with it.
    argv_dsn, env = pd.psql_env(dsn, base_env={})
    assert argv_dsn == dsn
    assert "PGPASSWORD" not in env


@pytest.mark.parametrize("dsn", UNPARSEABLE)
def test_unparseable_dsn_warns_on_stderr(dsn, capsys):
    pd.psql_env(dsn, base_env={})
    err = capsys.readouterr().err
    assert "could not parse DSN" in err
    assert "[psql_dsn]" in err


def test_unparseable_warning_does_not_echo_the_dsn(capsys):
    # The warning fires on the one path where the password may still reach
    # argv. Printing the DSN there would leak it into the journal as well.
    pd.psql_env("postgresql://user:leaked-secret@[bad", base_env={})
    err = capsys.readouterr().err
    assert "leaked-secret" not in err
    assert "postgresql://" not in err


# ── state discriminator: "no password" vs "we failed" ────────────────────────
def test_state_distinguishes_absent_from_unparsed(capsys):
    # Both yield password=None, but they mean opposite things about whether
    # this module did its job. A caller that cannot tell them apart cannot know
    # the password is still sitting in argv.
    assert pd.split_dsn_password("postgresql://u@h/db").state == "absent"
    assert pd.split_dsn_password("postgresql://u:p@[bad").state == "unparsed"
    capsys.readouterr()


def test_state_is_split_when_a_password_was_removed():
    assert pd.split_dsn_password(f"postgresql://u:{PW}@h/db").state == "split"


def test_unparseable_warning_reveals_nothing_about_the_dsn(capsys):
    # Not even the length: every non-secret component is already in the repo,
    # so a length is a password-length oracle.
    pd.psql_env("postgresql://user:leaked-secret@[bad", base_env={})
    err = capsys.readouterr().err
    assert "leaked-secret" not in err and "postgresql://" not in err
    assert not any(ch.isdigit() for ch in err)


# ── shapes libpq accepts that the first implementation leaked ────────────────
def test_multi_host_uri_is_split_not_passed_through():
    # `.port` cannot cast "5432,host2:5432", so a hostname/port-based rebuild
    # sent this valid DSN down the unparsed path WITH the password in argv.
    argv_dsn, env = pd.psql_env(f"postgresql://u:{PW}@host1:5432,host2:5432/db", base_env={})
    assert argv_dsn == "postgresql://u@host1:5432,host2:5432/db"
    assert env["PGPASSWORD"] == PW


def test_non_integer_port_is_split_not_passed_through():
    argv_dsn, env = pd.psql_env(f"postgresql://u:{PW}@h:notaport/db", base_env={})
    assert PW not in argv_dsn
    assert env["PGPASSWORD"] == PW


def test_query_parameter_password_is_extracted():
    # Verified against the live pooler 2026-09-06: a wrong ?password= yields
    # "password authentication failed", so libpq honours it.
    argv_dsn, env = pd.psql_env(f"postgresql://u@h/db?password={PW}", base_env={})
    assert PW not in argv_dsn
    assert env["PGPASSWORD"] == PW


def test_query_parameter_password_removed_but_other_params_kept():
    argv_dsn, env = pd.psql_env(
        f"postgresql://u@h/db?sslmode=require&password={PW}", base_env={})
    assert "sslmode=require" in argv_dsn
    assert "password" not in argv_dsn
    assert env["PGPASSWORD"] == PW


def test_query_parameter_password_wins_over_userinfo():
    # libpq resolves duplicates last-wins, and the query comes after userinfo.
    _, env = pd.psql_env("postgresql://u:from-userinfo@h/db?password=from-query",
                         base_env={})
    assert env["PGPASSWORD"] == "from-query"


# ── conninfo: a regex cannot do this correctly ───────────────────────────────
def test_conninfo_password_inside_an_options_value_is_not_mistaken_for_ours():
    # `options='-c foo=1 password=bar'` is legal; a regex lifts `bar` and leaves
    # an unterminated quote behind.
    argv_dsn, env = pd.psql_env(
        f"host=h options='-c foo=1 password=bar' password={PW} dbname=db", base_env={})
    assert env["PGPASSWORD"] == PW
    assert "options='-c foo=1 password=bar'" in argv_dsn
    assert PW not in argv_dsn


def test_conninfo_duplicate_password_takes_the_last_and_removes_both():
    argv_dsn, env = pd.psql_env("host=h password=first password=second dbname=db",
                                base_env={})
    assert env["PGPASSWORD"] == "second"
    assert "first" not in argv_dsn and "second" not in argv_dsn
    assert "password" not in argv_dsn


def test_conninfo_bare_value_honours_backslash_escapes():
    # `password=a\ b` is ONE value. Splitting on whitespace truncates the
    # password and leaves a stray `b` token psql rejects.
    argv_dsn, env = pd.psql_env(r"host=h password=a\ b dbname=db", base_env={})
    assert env["PGPASSWORD"] == "a b"
    assert argv_dsn == "host=h dbname=db"


# ── regressions introduced by the first round of gate fixes ──────────────────
def test_surviving_query_params_are_not_re_encoded():
    # parse_qsl -> urlencode round-trips form-style, turning %20 into +. libpq
    # decodes %XX per RFC 3986 and never reads + as a space, so psql would get a
    # literal plus. Fires only when a password is split AND another param holds
    # a space — it survives casual testing.
    argv_dsn, _ = pd.psql_env(
        f"postgresql://u:{PW}@h/db?options=-c%20search_path%3Dfoo", base_env={})
    assert argv_dsn == "postgresql://u@h/db?options=-c%20search_path%3Dfoo"
    assert "+" not in argv_dsn


def test_conninfo_whitespace_inside_quoted_values_is_preserved():
    # `" ".join(dsn.split())` normalises INSIDE quotes, so the same DSN would
    # parse differently with and without a password.
    argv_dsn, _ = pd.psql_env(
        f"host=h options='-c  statement_timeout=0' password={PW} dbname=db",
        base_env={})
    assert argv_dsn == "host=h options='-c  statement_timeout=0' dbname=db"


def test_valueless_password_token_does_not_eat_the_real_password():
    # A bare `password` with no `=` used to win last-wins: the REAL password was
    # stripped from argv and never placed in PGPASSWORD, so psql lost auth.
    argv_dsn, env = pd.psql_env(f"password={PW} dbname=d password", base_env={})
    assert env["PGPASSWORD"] == PW
    assert PW not in argv_dsn


def test_repr_does_not_leak_the_password():
    # A frozen dataclass built to hold a credential renders it in every
    # traceback and debugger frame unless repr is suppressed.
    assert "SUPERSECRET" not in repr(pd.split_dsn_password("postgresql://u:SUPERSECRET@h/db"))


def test_state_and_password_cannot_disagree():
    with pytest.raises(ValueError, match="invariant"):
        pd.DsnSplit("postgresql://u@h/db", None, "split")
    with pytest.raises(ValueError, match="invariant"):
        pd.DsnSplit("postgresql://u@h/db", "pw", "absent")

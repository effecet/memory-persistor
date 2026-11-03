"""Keep the Postgres password out of `psql`'s argv.

Every `psql` subprocess in `scripts/` used to receive the full DSN as `argv[1]`.
`/proc/<pid>/cmdline` is world-readable; `/proc/<pid>/environ` is not:

    /proc/<pid>/cmdline   -r--r--r--
    /proc/<pid>/environ   -r--------

so moving the password from argv into `PGPASSWORD` is a real boundary change,
not a cosmetic one. Verified on Linux 2026-09-06.

This is NOT a replacement for `brain_canary.redact_dsn()`. That guards the
*output* path — `TimeoutExpired.__str__` stringifies the whole argv, and detail
strings reach stdout, the state file, `--json` and alert messages. This guards the
*process table*. Different sinks; neither subsumes the other. It is also not
redundant with it: on the `unparsed` path below the password IS still in argv,
so `redact_dsn` remains the only thing standing between it and an alert message.

Three password locations are handled, because libpq accepts all three:

    postgresql://user:pw@host/db          URI userinfo
    postgresql://user@host/db?password=pw URI query parameter
    host=... password=pw dbname=...       keyword/value conninfo

The query-parameter form is not hypothetical — verified 2026-09-06 against the
live pooler: a wrong `?password=` yields `password authentication failed`, not
"no password supplied", so libpq honours it.

Usage at a call site:

    argv_dsn, env = psql_env(get_database_url())
    subprocess.run(["psql", argv_dsn, "-t", "-A", "-c", q], env=env, ...)

Filed against an earlier issue, deferred follow-up 1.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import unquote, urlsplit, urlunsplit

# libpq accepts both spellings.
_URI_SCHEMES = ("postgresql://", "postgres://")

#: How a DSN was handled. `unparsed` is the one state where the password may
#: still be in argv — see `_on_unparseable`. It is deliberately distinguishable
#: from `absent`: both return a password of None, but they mean opposite things
#: about whether this module did its job.
SplitState = Literal["split", "absent", "unparsed"]


@dataclass(frozen=True)
class DsnSplit:
    """Result of pulling the password out of a DSN.

    `password is None` alone cannot tell you whether there was no password or
    whether parsing failed with the password left in `argv_dsn` — hence `state`.
    """

    argv_dsn: str
    #: repr=False is load-bearing, not tidiness. A frozen dataclass whose whole
    #: purpose is holding a credential renders it in every traceback, log line
    #: and debugger frame otherwise — a sink this module exists to close.
    password: str | None = field(repr=False)
    state: SplitState

    def __post_init__(self) -> None:
        # `state` is only worth having if it cannot disagree with `password`.
        # This can fire only on a coding error in this module — never on input
        # data — which is why it raises where the DSN paths deliberately do not.
        if (self.state == "split") != (self.password is not None):
            raise ValueError(f"DsnSplit invariant broken: state={self.state!r} "
                             f"with password="
                             f"{'set' if self.password is not None else 'None'}")


def _scan_value(dsn: str, i: int) -> tuple[str, int]:
    """Read one conninfo value starting at `i`; return it and the next index.

    Single-quoted values run to the closing quote and may contain whitespace;
    bare values run to the next whitespace. BOTH honour backslash escapes — a
    bare `password=a\\ b` is one value, not a value plus a stray `b` token that
    psql would reject.
    """
    n = len(dsn)
    buf: list[str] = []
    if i < n and dsn[i] == "'":
        i += 1
        while i < n and dsn[i] != "'":
            if dsn[i] == "\\" and i + 1 < n:
                i += 1
            buf.append(dsn[i])
            i += 1
        if i < n:
            i += 1  # closing quote
    else:
        while i < n and not dsn[i].isspace():
            if dsn[i] == "\\" and i + 1 < n:
                i += 1
            buf.append(dsn[i])
            i += 1
    return "".join(buf), i


def _scan_conninfo(dsn: str) -> Iterator[tuple[int, int, str, str | None]]:
    """Yield `(start, end, keyword, value)` for each keyword/value pair.

    A regex cannot do this correctly. `options='-c foo=1 password=bar'` is a
    legal conninfo whose *value* contains the token we are hunting for; a
    `password\\s*=\\s*\\S+` search lifts `bar`, and deleting that span leaves an
    unterminated quote behind. So: scan, honouring single quotes and backslash
    escapes exactly as libpq does, and only then decide which pairs are ours.
    """
    i, n = 0, len(dsn)
    while i < n:
        while i < n and dsn[i].isspace():
            i += 1
        if i >= n:
            break
        start = i
        key_start = i
        while i < n and not dsn[i].isspace() and dsn[i] != "=":
            i += 1
        keyword = dsn[key_start:i]
        while i < n and dsn[i].isspace():
            i += 1
        value: str | None = None
        if i < n and dsn[i] == "=":
            i += 1
            while i < n and dsn[i].isspace():
                i += 1
            value, i = _scan_value(dsn, i)
        yield start, i, keyword, value


def _split_conninfo(dsn: str) -> DsnSplit:
    """Split a keyword/value conninfo. No `password=` is normal, not an error."""
    # `v is not None` filters a bare `password` token carrying no `=`. Without
    # it that token wins last-wins, so the REAL password is stripped out of argv
    # and never placed in PGPASSWORD — psql simply loses authentication.
    spans = [
        (s, e, v)
        for s, e, k, v in _scan_conninfo(dsn)
        if k.lower() == "password" and v is not None
    ]
    if not spans:
        return DsnSplit(dsn, None, "absent")

    # libpq resolves duplicate keywords LAST-wins. Taking the first would hand
    # psql one password through the env while leaving the live one in argv.
    password = spans[-1][2]
    kept: list[str] = []
    prev = 0
    for start, end, _ in spans:
        kept.append(dsn[prev:start])
        # Consume the removed token's trailing whitespace so the seam leaves one
        # separator. Do NOT normalise the whole string — `" ".join(s.split())`
        # rewrites whitespace INSIDE quoted values, so the same DSN would parse
        # differently with and without a password.
        prev = end
        while prev < len(dsn) and dsn[prev].isspace():
            prev += 1
    kept.append(dsn[prev:])
    return DsnSplit("".join(kept).strip(), password, "split")


def _split_uri(dsn: str) -> DsnSplit:
    """Split a `postgresql://` URI.

    Works on the RAW netloc rather than `.hostname`/`.port`. Those accessors
    reject shapes libpq accepts — notably the multi-host form
    `postgresql://u:pw@host1:5432,host2:5432/db`, whose port fails to cast — and
    a rejected parse would send a perfectly valid DSN down the unparsed path
    with its password still in argv. Slicing the netloc also means the host part
    is preserved byte-for-byte, so IPv6 brackets and the multi-host comma
    survive without special cases, and the username is never re-encoded.
    """
    parts = urlsplit(dsn)
    netloc, password = parts.netloc, None
    state: SplitState = "absent"

    if "@" in netloc:
        # rpartition: the LAST @ separates userinfo from host, and a password
        # may legally contain an encoded one.
        userinfo, _, hostpart = netloc.rpartition("@")
        if ":" in userinfo:
            user, _, raw = userinfo.partition(":")
            # urlsplit does NOT decode userinfo — .password comes back still
            # percent-encoded. libpq wants the LITERAL value in PGPASSWORD, so
            # the decode has to be explicit. Verified 2026-09-06: .password on
            # `u:p%40ss@h` returns `p%40ss`.
            password = unquote(raw)
            netloc = f"{user}@{hostpart}" if user else hostpart
            state = "split"

    # libpq also accepts `?password=` as a URI query parameter. Surviving pairs
    # are carried over BYTE-FOR-BYTE rather than rebuilt: a parse_qsl/urlencode
    # round-trip re-encodes them form-style, turning `?options=-c%20foo%3Dbar`
    # into `?options=-c+foo%3Dbar`. libpq decodes `%XX` and never treats `+` as
    # a space, so psql would receive a literal plus — a silent wrong value in a
    # parameter nobody would think to re-check.
    query, from_query = _split_query_password(parts.query)
    if from_query is not None:
        password = from_query
        state = "split"

    if state == "absent":
        return DsnSplit(dsn, None, "absent")
    return DsnSplit(
        urlunsplit(parts._replace(netloc=netloc, query=query)), password, "split"
    )


def _split_query_password(query: str) -> tuple[str, str | None]:
    """Remove `password=` from a URI query, returning (kept query, password).

    Surviving pairs are carried BYTE-FOR-BYTE rather than rebuilt: a
    parse_qsl/urlencode round-trip re-encodes them form-style, turning
    `?options=-c%20foo%3Dbar` into `?options=-c+foo%3Dbar`. libpq decodes `%XX`
    and never reads `+` as a space, so psql would receive a literal plus — a
    silent wrong value in a parameter nobody would think to re-check.

    The key is unquoted before comparison: libpq accepts `?%70assword=` and
    reaches connect with it, so matching the raw key alone leaves a real leak.
    """
    if not query:
        return query, None
    kept: list[str] = []
    found: list[str] = []
    for pair in query.split("&"):
        if not pair:
            continue
        key, sep, value = pair.partition("=")
        if sep and unquote(key).lower() == "password":
            found.append(unquote(value))
        else:
            kept.append(pair)
    if not found:
        return query, None
    return "&".join(kept), found[-1]  # last-wins, as libpq does


def _on_unparseable(dsn: str) -> DsnSplit:
    """Policy for a DSN that looks like a URI but will not parse.

    Reached only when `urlsplit` itself raises — in practice a malformed IPv6
    literal such as `postgresql://u:p@[::1/db`. The valid-but-awkward shapes
    (multi-host, non-integer port) no longer land here; `_split_uri` works on
    the raw netloc precisely so they don't.

    DECIDED 2026-09-06 — pass the DSN through unchanged and warn on stderr.

    Raising was the alternative, and it is the stricter posture: nothing would
    silently keep leaking. It was rejected because this module sits underneath
    the hourly brain canary and `memory-decay`. A parser hole would then take
    down the process whose entire job is noticing outages — trading a narrow,
    conditional credential exposure for a guaranteed loss of monitoring. That is
    the worse trade, and an earlier issue exists precisely because monitoring went
    blind without anyone noticing.

    Passing through *silently* was also rejected: it is the "silent wrong value"
    this codebase keeps getting bitten by. stderr is the middle road with no
    real cost — systemd captures it for both the canary and decay units, so the
    hole lands in `journalctl` where it can be found, without being fatal.

    The warning names no part of the DSN, not even its length: every non-secret
    component is already in the repo and the journal, so a length is a
    password-length oracle for whoever reads it.
    """
    print(
        "[psql_dsn] WARNING: could not parse DSN; password may remain in argv",
        file=sys.stderr,
    )
    return DsnSplit(dsn, None, "unparsed")


def split_dsn_password(dsn: str) -> DsnSplit:
    """Pull the password out of a DSN. Never raises."""
    if dsn.lower().startswith(_URI_SCHEMES):
        try:
            return _split_uri(dsn)
        except ValueError:
            return _on_unparseable(dsn)
    return _split_conninfo(dsn)


def psql_env(
    dsn: str, base_env: Mapping[str, str] | None = None
) -> tuple[str, dict[str, str]]:
    """Return (DSN safe for argv, env carrying PGPASSWORD).

    `base_env` defaults to `os.environ` and is always copied, never mutated.

    A password-less DSN deliberately does NOT clear an inherited PGPASSWORD:
    supplying the password through the environment is a legitimate setup, and
    popping it would be an availability regression wearing a security fix's
    clothes.
    """
    split = split_dsn_password(dsn)
    env = dict(os.environ if base_env is None else base_env)
    if split.password is not None:
        env["PGPASSWORD"] = split.password
    return split.argv_dsn, env

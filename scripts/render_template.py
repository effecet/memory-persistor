#!/usr/bin/env python3
"""Substitute `@NAME@` placeholders in a template using values from the environment.

Written for `make install-canary`, which renders the launchd plist containing
the Supabase DSN. Two properties matter, and both are the point of the file:

1. **The secret never touches argv.** Values are read from `os.environ`, so
   they stay out of `/proc/<pid>/cmdline` (world-readable, `-r--r--r--`) and out
   of `ps`. The previous `sed "s|@DATABASE_URL@|$DB_URL|" …` put the whole DSN
   in a command line for the life of the process — an earlier issue, the last
   of the class closed by the liveness check and the DSN-in-argv fix. `tests/test_dsn_argv_interpolation.py`
   now fails if that shape comes back.

2. **XML escaping.** `sed` mangled a DSN containing `&` (it means "the whole
   match" in a sed replacement) but happened to emit a *valid* plist. A literal
   `str.replace` preserves the value correctly and therefore emits INVALID XML
   for the same input — `plutil -lint` rejects it and `launchctl bootstrap`
   aborts the install. Postgres passwords routinely contain `&`, so this is
   reachable, not theoretical. Escaping is applied for XML-ish templates only.

Usage:
    DATABASE_URL="$DB_URL" python3 scripts/render_template.py [--xml|--raw] <template>

Escaping is chosen by the `.plist`/`.xml` suffix, or stated explicitly with
`--xml` / `--raw`. An UNRECOGNISED suffix is an error, not a default: review
found that renaming the template to `org.….plist.in` made `Path.suffix` return
`.in`, silently disabling escaping and reinstating the invalid-XML bug with a
clean exit code. Guessing "probably not XML" is the wrong direction to fail in.

Exit codes:
    0  rendered to stdout
    1  template unreadable, or a placeholder is not set in the environment
    2  usage error, including an unrecognised suffix with no explicit flag
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

#: `@NAME@`, where NAME is an environment-variable-shaped identifier.
PLACEHOLDER_RE = re.compile(r"@([A-Z][A-Z0-9_]*)@")

#: Suffixes whose contents are XML and therefore need escaping.
XML_SUFFIXES = frozenset({".plist", ".xml"})

#: Suffixes that are definitively NOT XML. Anything outside both sets forces
#: the caller to say which it is, rather than defaulting to "no escaping".
RAW_SUFFIXES = frozenset({".service", ".timer", ".env", ".conf", ".ini", ".sh"})


class MissingPlaceholders(LookupError):
    """Named placeholders were absent from the environment."""

    def __init__(self, names: list[str]) -> None:
        self.names = names
        super().__init__(f"template placeholders not set in environment: {names}")


def render(text: str, env: dict[str, str], *, xml_escape: bool) -> str:
    """Replace every `@NAME@` in ``text`` with ``env[NAME]``.

    Raises ``MissingPlaceholders`` naming every placeholder the environment does
    not supply. Failing loudly matters more than a partial render here: a plist
    written with a literal `@DATABASE_URL@` would install cleanly and then fail
    at runtime, which is the silent-breakage shape this repo keeps fighting.
    """
    names = sorted(set(PLACEHOLDER_RE.findall(text)))
    missing = [n for n in names if n not in env]
    if missing:
        raise MissingPlaceholders(missing)

    def sub(match: re.Match[str]) -> str:
        value = env[match.group(1)]
        return escape(value) if xml_escape else value

    return PLACEHOLDER_RE.sub(sub, text)


def resolve_escaping(template: Path, flag: str | None) -> bool:
    """Decide XML escaping explicitly, or refuse to guess."""
    if flag == "--xml":
        return True
    if flag == "--raw":
        return False
    if template.suffix in XML_SUFFIXES:
        return True
    if template.suffix in RAW_SUFFIXES:
        return False
    raise ValueError(
        f"cannot tell whether {template.name!r} is XML from its suffix; "
        "pass --xml or --raw"
    )


def main(argv: list[str]) -> int:
    args = argv[1:]
    flag = None
    if args and args[0] in {"--xml", "--raw"}:
        flag, args = args[0], args[1:]
    if len(args) != 1:
        print(f"usage: {Path(argv[0]).name} [--xml|--raw] <template>", file=sys.stderr)
        return 2

    template = Path(args[0])
    try:
        xml_escape = resolve_escaping(template, flag)
    except ValueError as exc:
        print(f"render_template: {exc}", file=sys.stderr)
        return 2
    try:
        rendered = render(
            template.read_text(encoding="utf-8"), dict(os.environ), xml_escape=xml_escape
        )
    except (MissingPlaceholders, OSError) as exc:
        print(f"render_template: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

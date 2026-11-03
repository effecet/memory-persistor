"""Tests for `scripts/render_template.py`.

The XML-escaping case is the one with teeth: a review of the reported issue's
fix found that moving from `sed` to a literal `str.replace` fixed the secret
leak but introduced an install-breaking bug — a DSN containing `&` produced
invalid XML, so `plutil -lint` rejected the plist and `launchctl bootstrap`
aborted. Both behaviours were wrong; only one was loud.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
MODULE_PATH = REPO / "scripts" / "render_template.py"

_spec = importlib.util.spec_from_file_location("render_template", MODULE_PATH)
assert _spec and _spec.loader
render_template = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(render_template)


def test_substitutes_from_environment():
    out = render_template.render(
        "<string>@DATABASE_URL@</string>",
        {"DATABASE_URL": "postgres://u:p@h:6543/db"},
        xml_escape=True,
    )
    assert out == "<string>postgres://u:p@h:6543/db</string>"


def test_ampersand_is_xml_escaped():
    """The regression this helper exists for."""
    out = render_template.render(
        "<string>@DATABASE_URL@</string>",
        {"DATABASE_URL": "postgres://u:pa&ss@h/db?x=1&y=2"},
        xml_escape=True,
    )
    assert "&amp;" in out
    assert "pa&ss" not in out


@pytest.mark.parametrize(
    "value,expected",
    [
        ("a&b", "a&amp;b"),
        ("a<b", "a&lt;b"),
        ("a>b", "a&gt;b"),
    ],
)
def test_escapes_every_xml_metacharacter(value, expected):
    out = render_template.render("@X@", {"X": value}, xml_escape=True)
    assert out == expected


def test_no_escaping_for_non_xml_templates():
    out = render_template.render("@X@", {"X": "a&b"}, xml_escape=False)
    assert out == "a&b"


def test_missing_placeholder_fails_loudly():
    """A partial render would install cleanly and break at runtime instead."""
    with pytest.raises(render_template.MissingPlaceholders) as exc:
        render_template.render("@A@ @B@", {"A": "1"}, xml_escape=False)
    assert exc.value.names == ["B"]


def test_rendered_plist_is_valid_xml_for_an_ampersand_dsn(tmp_path):
    """End-to-end through the CLI, asserting the property `plutil` checks."""
    import xml.etree.ElementTree as ET

    template = tmp_path / "t.plist"
    template.write_text(
        '<?xml version="1.0"?><plist version="1.0"><dict>'
        "<key>DATABASE_URL</key><string>@DATABASE_URL@</string>"
        "</dict></plist>"
    )
    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(template)],
        env={"DATABASE_URL": "postgres://u:p&w@h/db", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=True,
    )
    root = ET.fromstring(proc.stdout)  # raises if the escaping is wrong
    assert root.find(".//string").text == "postgres://u:p&w@h/db"


def test_makefile_never_passes_the_dsn_as_an_argument():
    """The property the earlier version of this test only appeared to check.

    Asserting a secret is absent from an argv list the test itself constructed
    cannot fail. What matters is that the Makefile recipe invokes this script
    with the DSN in the ENVIRONMENT and only the template path in argv.
    """
    recipe = (REPO / "Makefile").read_text()
    line = next(
        ln for ln in recipe.splitlines() if "render_template.py" in ln
    )
    assert 'DATABASE_URL="$$DB_URL"' in line, line
    assert "$$DB_URL" not in line.split("render_template.py", 1)[1], (
        "the DSN must not appear after the script name, i.e. in argv"
    )


def test_reads_the_value_from_the_environment_not_argv(tmp_path):
    template = tmp_path / "t.plist"
    template.write_text("<string>@DATABASE_URL@</string>")
    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(template)],
        env={"DATABASE_URL": "postgres://u:SUPERSECRET@h/db", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert "SUPERSECRET" in proc.stdout


def test_unrecognised_suffix_refuses_to_guess(tmp_path):
    """`x.plist.in` has suffix `.in`; defaulting to raw silently un-escapes."""
    template = tmp_path / "t.plist.in"
    template.write_text("<string>@X@</string>")
    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(template)],
        env={"X": "a&b", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2, proc.stderr
    assert "--xml or --raw" in proc.stderr


def test_explicit_flag_overrides_the_suffix(tmp_path):
    template = tmp_path / "t.plist.in"
    template.write_text("<string>@X@</string>")
    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), "--xml", str(template)],
        env={"X": "a&b", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert "a&amp;b" in proc.stdout


def test_missing_template_file_exits_one_without_a_traceback(tmp_path):
    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(tmp_path / "nope.plist")],
        env={"PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1
    assert "Traceback" not in proc.stderr

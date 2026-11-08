# tests/test_memory_dedup.py
"""Tests for scripts/memory_dedup.py — the local-mirror ↔ Postgres reconciler.

Covers the pure helpers (encode / slugify / canon_name / trunc_desc / build_md /
read_fm), the tier-classification + ``--apply`` behaviour of ``main()`` against a
fixture memory dir with a stubbed entity list (no live psql), and a drift guard
that fails if ``src/file-sync.ts``'s slug/encode rules diverge from the Python.

Filed against an earlier issue.
"""

import re
import sys
from pathlib import Path

import pytest

# Import the script directly — it lives in scripts/, not an installed package.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
import memory_dedup as md  # noqa: E402


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #
class TestEncode:
    def test_users_path_with_dot(self):
        assert md.encode("/Users/foo.bar") == "-Users-foo-bar"

    def test_home_path(self):
        assert md.encode("/home/jane") == "-home-jane"

    def test_replaces_every_slash_and_dot(self):
        assert md.encode("/a.b/c.d") == "-a-b-c-d"


class TestSlugify:
    def test_basic_lowercasing_and_dashing(self):
        assert md.slugify("Keep Me") == "keep-me"

    def test_collapses_runs_of_non_alphanumeric(self):
        assert md.slugify("Foo  Bar!!Baz") == "foo-bar-baz"

    def test_strips_leading_and_trailing_dashes(self):
        assert md.slugify("--Hi--") == "hi"

    def test_caps_at_120_chars(self):
        # The bug that over-counted renames: file-sync.ts truncates to 120, so the
        # Python slug MUST too or canonical-but-truncated files look "stale".
        out = md.slugify("a" * 150)
        assert len(out) == 120

    def test_trailing_dash_after_truncation_is_preserved(self):
        # Stripping happens BEFORE the [:120] slice, so a slice landing on a
        # separator legitimately leaves a trailing dash — mirrors the TS .slice.
        out = md.slugify("a" * 119 + " " + "b" * 10)
        assert out == "a" * 119 + "-"
        assert len(out) == 120


class TestCanonName:
    def test_builds_type_slug_md(self):
        assert md.canon_name({"type": "feedback", "name": "Keep Me"}) == "feedback_keep-me.md"

    def test_uses_capped_slug(self):
        e = {"type": "project", "name": "x" * 150}
        assert md.canon_name(e) == "project_" + "x" * 120 + ".md"


class TestTruncDesc:
    def test_short_string_unchanged(self):
        assert md.trunc_desc("short text") == "short text"

    def test_newlines_flattened_and_stripped(self):
        assert md.trunc_desc("  hello\nworld  ") == "hello world"

    def test_word_bounded_cut_when_space_past_threshold(self):
        # last space comfortably past 0.6*40 → cut on the word boundary.
        s = "alpha beta gamma delta epsilon zeta eta theta iota"
        out = md.trunc_desc(s, 40)
        assert len(out) <= 40
        assert not out.endswith(" ")
        assert " " in out and out == s[: len(out)]
        assert s.startswith(out)

    def test_hard_cut_when_no_qualifying_space(self):
        # No space at/above the 0.6*max threshold → hard slice at max.
        s = "x" * 50
        out = md.trunc_desc(s, 40)
        assert len(out) == 40


class TestBuildMd:
    def test_contains_frontmatter_and_body(self):
        e = {
            "name": "Sample", "type": "feedback", "observations": "the body text",
            "temperature": 0.5, "tier": "WARM", "importance": 0.7,
            "accessCount": 3, "originHost": "Laptop-A", "id": "abc-123",
        }
        out = md.build_md(e)
        assert out.startswith("---\n")
        assert "name: Sample" in out
        assert "type: feedback" in out
        assert "pg_id: abc-123" in out
        assert "description: the body text" in out
        assert out.rstrip().endswith("the body text")


class TestReadFm:
    def test_parses_pgid_name_type(self, tmp_path):
        p = tmp_path / "feedback_x.md"
        p.write_text(
            "---\nname: Some Name\ndescription: d\ntype: feedback\npg_id: 11111111-2222\n---\nbody",
            "utf-8",
        )
        fm = md.read_fm(p)
        assert fm == {
            "pgid": "11111111-2222", "name": "Some Name", "type": "feedback",
            "tier": None, "temperature": None,
        }

    def test_missing_pgid_is_none(self, tmp_path):
        p = tmp_path / "feedback_y.md"
        p.write_text("---\nname: No Id\ntype: project\n---\nbody", "utf-8")
        fm = md.read_fm(p)
        assert fm["pgid"] is None
        assert fm["name"] == "No Id"
        assert fm["type"] == "project"


# --------------------------------------------------------------------------- #
# Index line budget — degradation when the memory dir grows past the cap
# --------------------------------------------------------------------------- #
def _memo(d, fname, name, tier, temp, mtype="fact"):
    body = f"---\nname: {name}\ndescription: d\ntype: {mtype}\n"
    if tier:
        body += f"tier: {tier}\ntemperature: {temp}\n"
    (d / fname).write_text(body + "---\n\nbody\n")


class TestIndexBudget:
    def test_under_budget_emits_all_and_no_footer(self, tmp_path, monkeypatch):
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(10):
            _memo(tmp_path, f"f{i}.md", f"n{i}", "COLD", 0)
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        assert len([l for l in out.splitlines() if l.startswith("- ")]) == 10
        assert "more — use" not in out

    def test_over_budget_caps_and_footers(self, tmp_path, monkeypatch):
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(200):
            _memo(tmp_path, f"f{i:03d}.md", f"n{i}", "COLD", 0)
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        entries = [l for l in out.splitlines() if l.startswith("- ") and "more — use" not in l]
        assert len(entries) == md.MAX_ENTRIES_WITH_FOOTER
        assert "- …and 33 more — use `recall`" in out
        assert out.count("\n") <= md.INDEX_LINE_BUDGET

    def test_ranks_on_postgres_not_frontmatter(self, tmp_path, monkeypatch):
        """169 files all HOT/1.0 in frontmatter; Postgres says z-168 is hottest.

        On frontmatter alone every entry ties and the sort falls through to the
        filename tie-break, so z-168 is cut. Ranking on the injected Postgres
        values must invert that.
        """
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(169):
            pg_id = f"00000000-0000-4000-8000-{i:012d}"
            (tmp_path / f"z-{i:03d}.md").write_text(
                f"---\nname: n{i}\ndescription: d-n{i}\ntype: reference\n"
                f"temperature: 1\ntier: HOT\npg_id: {pg_id}\n---\n\nbody\n"
            )
        # 169 > MAX_ENTRIES_NO_FOOTER (168), so exactly two are dropped: the
        # coldest live entries. Temperatures ascend with i.
        thermal = {
            f"00000000-0000-4000-8000-{i:012d}": ("HOT", 0.5 + i / 1000)
            for i in range(169)
        }
        md.regen_index(thermal=thermal)

        out = (tmp_path / "MEMORY.md").read_text()
        assert "- reference: n168 — d-n168" in out
        assert "- reference: n0 — d-n0\n" not in out
        assert "- reference: n1 — d-n1\n" not in out
        assert "- …and 2 more — use `recall`" in out

    def test_orphan_pgid_ranks_at_zero_not_frontmatter(self, tmp_path, monkeypatch):
        """A reachable DB with no row for an entry ranks it at 0, never at its
        stale frontmatter value."""
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(169):
            pg_id = f"00000000-0000-4000-8000-{i:012d}"
            (tmp_path / f"z-{i:03d}.md").write_text(
                f"---\nname: n{i}\ndescription: d-n{i}\ntype: reference\n"
                f"temperature: 1\ntier: HOT\npg_id: {pg_id}\n---\n\nbody\n"
            )
        thermal = {
            f"00000000-0000-4000-8000-{i:012d}": ("HOT", 0.5 + i / 1000)
            for i in range(1, 169)
        }
        md.regen_index(thermal=thermal)

        out = (tmp_path / "MEMORY.md").read_text()
        assert "- reference: n0 — d-n0\n" not in out
        assert "- reference: n168 — d-n168" in out

    def test_falls_back_to_frontmatter_when_thermal_is_none(self, tmp_path, monkeypatch):
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        (tmp_path / "a.md").write_text(
            "---\nname: a\ndescription: da\ntype: reference\n"
            "temperature: 1\ntier: HOT\npg_id: 00000000-0000-4000-8000-000000000001\n---\n\nb\n"
        )
        md.regen_index(thermal=None)
        assert (tmp_path / "MEMORY.md").read_text() == "# Memory Index\n\n- reference: a — da\n"

    def test_fetch_thermal_returns_none_for_empty_id_list(self):
        """A directory where no file carries a pg_id has no Postgres info.

        Returning {} instead would mark every legacy file an orphan and re-cut
        the index on filename alone. Must match src/file-sync.ts.
        """
        assert md.fetch_thermal_by_pgid([]) is None

    def test_drops_cold_before_warm(self, tmp_path, monkeypatch):
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        _memo(tmp_path, "a-warm.md", "keep-warm", "WARM", 0.5)
        # Zero-pad the NAME, not just the filename: with a name of "cold0",
        # `assert "cold000" not in out` can never fail and the test is vacuous.
        for i in range(200):
            _memo(tmp_path, f"c-cold{i:03d}.md", f"cold{i:03d}", "COLD", i / 1000)
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        assert "keep-warm" in out
        assert "cold199" in out
        assert "cold000" not in out

    def test_missing_tier_treated_as_warm(self, tmp_path, monkeypatch):
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        _memo(tmp_path, "a-legacy.md", "legacy-no-tier", None, 0)
        for i in range(200):
            _memo(tmp_path, f"c-cold{i:03d}.md", f"cold{i:03d}", "COLD", 0.9)
        md.regen_index()
        assert "legacy-no-tier" in (tmp_path / "MEMORY.md").read_text()

    def test_body_only_tier_text_is_ignored_ranks_as_warm(self, tmp_path, monkeypatch):
        # Regression: tier/temperature parsing must be scoped to the
        # frontmatter block, like read_fm/src/file-sync.ts::readFrontmatterField
        # — not a raw whole-file regex. Fill every survivor slot with real
        # HOT entries, then plant a file with NO `tier:` in frontmatter but a
        # `tier: HOT` line in its BODY (documenting the tiering system is a
        # real thing this project's memories do). Give it the highest
        # temperature of all. If the body text leaks through as HOT, its temp
        # wins it a slot at a real HOT entry's expense; correctly ranked WARM,
        # it can never outrank a full 167-entry HOT set and must be dropped.
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(167):
            _memo(tmp_path, f"h-hot{i:03d}.md", f"hot{i:03d}", "HOT", 1.0)
        (tmp_path / "z-trap.md").write_text(
            "---\nname: body-tier-trap\ndescription: d\ntype: fact\n"
            "temperature: 2.0\n---\n\ntier: HOT\n"
        )
        _memo(tmp_path, "z-dummy-cold.md", "dummy-cold", "COLD", 0)
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        assert "body-tier-trap" not in out

    def test_protected_type_survives_as_coldest_entry_present(self, tmp_path, monkeypatch):
        # PROTECTED_TYPES floor: a `feedback`/COLD/0.0 entry that is the
        # coldest thing in the whole dir must still survive the cut.
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(200):
            _memo(tmp_path, f"f{i:03d}.md", f"n{i}", "COLD", 0.5, mtype="reference")
        _memo(tmp_path, "protected-coldest.md", "protected-coldest", "COLD", 0.0, mtype="feedback")
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        assert "protected-coldest" in out
        entries = [l for l in out.splitlines() if l.startswith("- ") and "more — use" not in l]
        assert len(entries) == md.MAX_ENTRIES_WITH_FOOTER

    def test_protected_floor_is_not_an_exemption_from_the_budget(self, tmp_path, monkeypatch):
        # 200 protected (feedback) entries alone exceed the budget — the floor
        # must still cut among themselves by tier/temperature, never breach it.
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(200):
            _memo(tmp_path, f"p{i:03d}.md", f"n{i}", "COLD", i / 1000, mtype="feedback")
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        entries = [l for l in out.splitlines() if l.startswith("- ") and "more — use" not in l]
        assert len(entries) == md.MAX_ENTRIES_WITH_FOOTER
        assert "- …and 33 more — use `recall`" in out
        assert out.count("\n") <= md.INDEX_LINE_BUDGET

    def test_quoted_tier_value_is_stripped_and_ranks_correctly(self, tmp_path, monkeypatch):
        # Regression: `tier: "HOT"` (quoted) must parse the same as `tier: HOT`
        # — read_fm's g() already strips quotes, src/file-sync.ts's
        # readFrontmatterField does too. Fill every survivor slot with real
        # WARM entries, then plant a quoted-HOT entry with the LOWEST
        # temperature of all. HOT always outranks WARM regardless of
        # temperature, so a correctly quote-stripped tier must still survive
        # (displacing a same-temp WARM filler); a fallback-to-WARM bug would
        # lose the temperature tie-break and get dropped.
        monkeypatch.setattr(md, "MEMDIR", tmp_path)
        for i in range(167):
            _memo(tmp_path, f"w-warm{i:03d}.md", f"warm{i:03d}", "WARM", 1.0)
        (tmp_path / "z-quoted.md").write_text(
            '---\nname: quoted-hot\ndescription: d\ntype: fact\n'
            'tier: "HOT"\ntemperature: 0\n---\n\nbody\n'
        )
        _memo(tmp_path, "z-dummy-cold.md", "dummy-cold", "COLD", 0)
        md.regen_index()
        out = (tmp_path / "MEMORY.md").read_text()
        assert "quoted-hot" in out


# --------------------------------------------------------------------------- #
# Tier classification + --apply, against a fixture dir and stubbed entities
# --------------------------------------------------------------------------- #
def _entity(eid, name, etype, source, obs="body"):
    return {
        "id": eid, "name": name, "type": etype, "source": source,
        "observations": obs, "temperature": 0.5, "tier": "WARM",
        "importance": 0.5, "accessCount": 0, "originHost": "test-host",
    }


def _fm_file(path: Path, *, name, etype, pgid=None, body="body"):
    lines = ["---", f"name: {name}", f"type: {etype}"]
    if pgid is not None:
        lines.append(f"pg_id: {pgid}")
    lines += ["---", "", body, ""]
    path.write_text("\n".join(lines), "utf-8")


@pytest.fixture
def reconcile_env(tmp_path, monkeypatch):
    """A fixture memory dir + stubbed PG entity list wired into the module globals.

    Layout exercises every tier:
      KEEP  feedback_keep-me.md         (canonical, live pg_id, homed here)
      T1    project_dupentity-old.md    (stale dup; canonical also present)
      KEEP  project_dup-entity.md       (canonical twin of the T1 dup)
      T2    reference_elsewhere-old.md  (entity homed in another dir that has it)
      T3    project_renameme-stale.md   (sole local copy under an outdated slug)
      T4    t4_dangling.md              (pg_id not in PG)
      T4    t4_ghost.md                 (no pg_id, name not in this dir)
    """
    home_src = "/Users/test"
    other_src = "/Users/other"
    this_enc = md.encode(home_src)

    claude = tmp_path / ".claude"
    memdir = claude / "projects" / this_enc / "memory"
    memdir.mkdir(parents=True)
    # The "other machine" home dir that legitimately owns the T2 entity.
    other_mem = claude / "projects" / md.encode(other_src) / "memory"
    other_mem.mkdir(parents=True)

    e_keep = _entity("11111111-1111-4111-8111-111111111111", "Keep Me", "feedback", home_src)
    e_dup = _entity("22222222-2222-4222-8222-222222222222", "Dup Entity", "project", home_src)
    e_else = _entity("33333333-3333-4333-8333-333333333333", "Elsewhere", "reference", other_src)
    e_ren = _entity("44444444-4444-4444-8444-444444444444", "Rename Me", "project", home_src, obs="regen body")
    entities = [e_keep, e_dup, e_else, e_ren]

    # KEEP
    _fm_file(memdir / "feedback_keep-me.md", name="Keep Me", etype="feedback", pgid=e_keep["id"])
    # T1 dup + its present canonical twin (canonical itself is KEEP)
    _fm_file(memdir / "project_dup-entity.md", name="Dup Entity", etype="project", pgid=e_dup["id"])
    _fm_file(memdir / "project_dupentity-old.md", name="Dup Entity", etype="project", pgid=e_dup["id"])
    # T2 — homed in other dir, which already has the canonical file
    _fm_file(memdir / "reference_elsewhere-old.md", name="Elsewhere", etype="reference", pgid=e_else["id"])
    _fm_file(other_mem / "reference_elsewhere.md", name="Elsewhere", etype="reference", pgid=e_else["id"])
    # T3 — sole local copy under outdated slug, canonical absent
    _fm_file(memdir / "project_renameme-stale.md", name="Rename Me", etype="project", pgid=e_ren["id"])
    # T4 — dangling pg_id and a no-id ghost
    _fm_file(memdir / "t4_dangling.md", name="Ghosted", etype="feedback", pgid="99999999-9999-4999-8999-999999999999")
    _fm_file(memdir / "t4_ghost.md", name="Pure Ghost", etype="feedback", pgid=None)

    monkeypatch.setattr(md, "THIS_ENC", this_enc)
    monkeypatch.setattr(md, "CLAUDE", claude)
    monkeypatch.setattr(md, "MEMDIR", memdir)
    monkeypatch.setattr(md, "dump_entities", lambda: entities)

    return {"memdir": memdir, "entities": entities, "canon_ren": "project_rename-me.md"}


def test_report_mode_touches_nothing(reconcile_env, monkeypatch, capsys):
    monkeypatch.setattr(md, "APPLY", False)
    before = sorted(p.name for p in reconcile_env["memdir"].glob("*.md"))
    md.main()
    after = sorted(p.name for p in reconcile_env["memdir"].glob("*.md"))
    assert before == after  # read-only: no deletes, no renames, no MEMORY.md
    out = capsys.readouterr().out
    assert "T1_DELETE: 1" in out
    assert "T2_DELETE: 1" in out
    assert "T3_RENAME: 1" in out
    assert "T4_REVIEW: 2" in out
    assert "KEEP: 2" in out


def test_apply_deletes_only_t1_t2_regenerates_t3_keeps_t4(reconcile_env, monkeypatch):
    monkeypatch.setattr(md, "APPLY", True)
    memdir = reconcile_env["memdir"]
    md.main()
    present = {p.name for p in memdir.glob("*.md")}

    # T1 + T2 deleted
    assert "project_dupentity-old.md" not in present
    assert "reference_elsewhere-old.md" not in present
    # T3 regenerated to canonical from PG stub; stale removed
    assert "project_renameme-stale.md" not in present
    assert reconcile_env["canon_ren"] in present
    regen = (memdir / reconcile_env["canon_ren"]).read_text()
    assert "pg_id: 44444444-4444-4444-8444-444444444444" in regen
    assert "regen body" in regen
    # KEEP untouched
    assert "feedback_keep-me.md" in present
    assert "project_dup-entity.md" in present
    # T4 NEVER auto-touched
    assert "t4_dangling.md" in present
    assert "t4_ghost.md" in present
    # MEMORY.md regenerated and excludes itself
    idx = (memdir / "MEMORY.md").read_text()
    assert idx.startswith("# Memory Index")
    assert "- MEMORY.md —" not in idx
    assert "- project: Rename Me — regen body" in idx
    assert ".md —" not in idx


# --------------------------------------------------------------------------- #
# Drift guard — fail loudly if the TS slug/encode rules diverge from Python
# --------------------------------------------------------------------------- #
class TestTsSlugDrift:
    @pytest.fixture
    def ts_source(self):
        return (REPO / "src" / "file-sync.ts").read_text()

    def test_slugify_rule_matches_python(self, ts_source):
        body_m = re.search(r"function slugify\(name: string\): string\s*\{(.*?)\}", ts_source, re.S)
        assert body_m, "slugify() not found in file-sync.ts — did it move/rename?"
        body = body_m.group(1)
        # The four invariants the Python slugify also enforces.
        assert ".toLowerCase()" in body
        assert "/[^a-z0-9]+/g" in body, "char-class drifted from [^a-z0-9]+"
        assert re.search(r"/\^-\+\|-\+\$/g", body), "leading/trailing dash strip drifted"
        assert ".slice(0, 120)" in body, "120-char cap drifted — Python slugify must match"

    def test_encode_replaces_slash_and_dot(self, ts_source):
        # TS encodeProjectPath() must mirror the Python encode(): both / and . → -.
        enc_m = re.search(
            r"function encodeProjectPath\(source: string\): string\s*\{(.*?)\}", ts_source, re.S
        )
        assert enc_m, "encodeProjectPath() not found in file-sync.ts — did it move/rename?"
        body = enc_m.group(1)
        assert "/\\//g" in body, "slash→dash step drifted"
        assert "/\\./g" in body, "dot→dash step missing — the documented orphan bug"


class TestClaudeDir:
    """memory_dedup mirrors file-sync.ts, which writes under CLAUDE_DIR
    (src/config.ts: `process.env.CLAUDE_DIR || ${HOME}/.claude`), so it must
    read and delete under the same dir."""

    @pytest.fixture
    def reloaded(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        import importlib

        monkeypatch.setenv("CLAUDE_DIR", str(tmp_path))
        yield importlib.reload(md)
        # Restore the caller's env (CLAUDE_DIR may have been set) BEFORE the
        # reload, so the module rebinds to what it was before this test.
        monkeypatch.undo()
        importlib.reload(md)

    def test_module_paths_follow_claude_dir(self, reloaded, tmp_path: Path) -> None:
        # The module-level binding is what --apply deletes under.
        assert reloaded.CLAUDE == tmp_path
        assert reloaded.MEMDIR.is_relative_to(tmp_path)

    def test_empty_claude_dir_falls_back_to_home(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        # `||` in config.ts treats "" as unset, so the script must too.
        import importlib

        monkeypatch.setenv("CLAUDE_DIR", "")
        monkeypatch.setenv("HOME", str(tmp_path))
        try:
            assert importlib.reload(md).CLAUDE == tmp_path / ".claude"
        finally:
            monkeypatch.undo()
            importlib.reload(md)

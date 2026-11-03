/**
 * A memory `name` that is actually an old filename stem.
 *
 * Some entities in a production corpus were named things like
 * `feedback_cache_retry_rule` instead of a real title. Two consequences:
 * the MEMORY.md index line is `- <type>: <name> — <description>`, so they
 * render as filenames at session start; and prose-name matching against them
 * trigram-scores ~0.32-0.39, low enough that an orphan-file audit on
 * 2026-08-28 concluded five of them had no entity at all.
 *
 * The discriminator is the UNDERSCORE immediately after a type word. That
 * matters more than it looks: plenty of legitimate names begin with a type
 * WORD ("User prefers short answers"), and their files are named
 * `<type>_user-prefers-short-answers.md` — which looks like a doubled
 * type prefix on disk but is perfectly healthy. Rejecting on the on-disk
 * doubled-prefix pattern instead of on the underscore would have corrupted
 * 7 healthy memories out of 16 matches.
 */
import { describe, it, expect } from 'vitest';
import { isFilenameStyleName, assertMemoryNameIsTitle } from '../src/file-sync.js';
import { CategorizedError } from '../src/errors.js';
import { MEMORY_TYPES } from '../src/config.js';

describe('isFilenameStyleName', () => {
  it('rejects filename-stem names of the shapes seen in a production corpus', () => {
    for (const name of [
      'feedback_cache_retry_rule',
      'feedback_secure_env_vars',
      'feedback_chart_axis_white_bg',
      'feedback_real_data_for_demo',
      'project_slide_build_pipeline',
      'project_sample_app_rebrand',
      'reference_static_host_deprecated',
      'reference_html_to_png_renderer',
      'user_writing_style',
    ]) {
      expect(isFilenameStyleName(name), name).toBe(true);
    }
  });

  it('covers every declared memory type, including the legacy ones', () => {
    // NOTE: this cannot fail from a NEW type being added — the regex and this
    // loop expand from the same constant in lockstep. What it actually pins is
    // that the list stays DERIVED: replacing it with a hardcoded array that omits
    // `decision`/`pattern` fails here. That mutation was confirmed caught.
    for (const type of MEMORY_TYPES) {
      expect(isFilenameStyleName(`${type}_something_here`), type).toBe(true);
    }
  });

  it('does NOT reject prose names that merely START with a type word', () => {
    // These are legitimate and already exist on disk. A space (or any
    // non-underscore) after the type word means it is a real sentence.
    for (const name of [
      'User prefers short answers',
      'User prefers explicit disk partition',
      'Feedback composition style',
      'Project status notes',
      'Reference implementation notes',
      'Fact checking workflow',
    ]) {
      expect(isFilenameStyleName(name), name).toBe(false);
    }
  });

  it('does NOT reject legitimate names containing a snake_case identifier', () => {
    // The gate's highest-value finding. A prefix-only match rejected every one of
    // these. Four of the seven type words are common compound-token heads, and this
    // is a data-engineering stack where `fact_` is the standard dimensional prefix,
    // so hard-rejecting them mid-session with no escape hatch was a real defect.
    // Anchoring the pattern to `$` clears them; all nine live offenders are
    // whitespace-free and still reject.
    for (const name of [
      'user_id must never be null',
      'fact_orders grain is one row per line item',
      'project_id is the join key',
      'pattern_matching beats regex here',
      'user_agent header must be set',
      'reference_impl differs from the spec',
    ]) {
      expect(isFilenameStyleName(name), name).toBe(false);
    }
  });

  it('normalizes unicode look-alikes that would otherwise slip through', () => {
    // Both slugify to the identical malformed filename, so both must be caught.
    expect(isFilenameStyleName('\u200Buser_writing_style')).toBe(true);   // zero-width space
    expect(isFilenameStyleName('user\uFF3Fwriting_style')).toBe(true);    // fullwidth underscore
  });

  it('does not reject ordinary names', () => {
    for (const name of [
      'API merge 405 means merged',
      'Tracker closes one per line',
      'Caching a parsed config changes the startup time',
      'pending_add is fine as prose about a tool',
    ]) {
      expect(isFilenameStyleName(name), name).toBe(false);
    }
  });

  it('is case-insensitive — a capitalised stem is the same mistake', () => {
    expect(isFilenameStyleName('Feedback_aci_latest_repull')).toBe(true);
    expect(isFilenameStyleName('USER_writing_style')).toBe(true);
  });

  it('handles leading whitespace and the degenerate bare-prefix case', () => {
    expect(isFilenameStyleName('  feedback_thing')).toBe(true);
    expect(isFilenameStyleName('user_')).toBe(true);
    expect(isFilenameStyleName('')).toBe(false);
    expect(isFilenameStyleName('   ')).toBe(false);
  });

  it('does not reject a type word appearing later in the name', () => {
    expect(isFilenameStyleName('How to write a feedback_style name')).toBe(false);
  });
});

describe('assertMemoryNameIsTitle error category', () => {
  it('throws a validation CategorizedError for a filename stem', () => {
    let caught: unknown;
    try {
      assertMemoryNameIsTitle('feedback_foo_bar');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CategorizedError);
    expect((caught as CategorizedError).category).toBe('validation');
  });
});

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_DIR } from '../src/config.js';
import {
  encodeProjectPath,
  truncateDescription,
  updateMemoryIndex,
  syncToFile,
  removeFile,
  syncMerge,
  readFrontmatterField,
  DESCRIPTION_MAX,
} from '../src/file-sync.js';

describe('readFrontmatterField', () => {
  const fm = (body: string) => `---\n${body}\n---\n\nbody text\n`;

  it('reads a top-level scalar', () => {
    expect(readFrontmatterField(fm('name: A thing\ntype: fact'), 'type')).toBe('fact');
  });

  it('reads a scalar nested under a parent key', () => {
    expect(
      readFrontmatterField(fm('name: A thing\nmetadata:\n  type: reference'), 'type'),
    ).toBe('reference');
  });

  it('prefers a top-level match over a nested one', () => {
    expect(
      readFrontmatterField(fm('type: fact\nmetadata:\n  type: reference'), 'type'),
    ).toBe('fact');
  });

  it('strips surrounding quotes', () => {
    expect(readFrontmatterField(fm('name: "Quoted name"'), 'name')).toBe('Quoted name');
    expect(readFrontmatterField(fm("name: 'Single'"), 'name')).toBe('Single');
  });

  it('returns an empty string for a missing key', () => {
    expect(readFrontmatterField(fm('name: A thing'), 'type')).toBe('');
  });

  it('ignores a matching key in the body when frontmatter is present', () => {
    // The key is absent from the frontmatter and present ONLY in the body, so
    // an unscoped scan would return 'reference'. Scoping must yield ''.
    const content = `---\nname: Real\n---\n\ntype: reference\n`;
    expect(readFrontmatterField(content, 'type')).toBe('');
  });

  it('tolerates a leading BOM before the frontmatter block', () => {
    // Same shape, prefixed with a BOM. If the `---` anchor did not tolerate
    // the BOM the block match would fail, fall back to the unscoped
    // first-800-chars scan, and wrongly pick up the body's `type:`.
    const content = '﻿---\nname: Real\n---\n\ntype: reference\n';
    expect(readFrontmatterField(content, 'type')).toBe('');
    // And it still reads a real frontmatter value through the BOM.
    expect(readFrontmatterField(content, 'name')).toBe('Real');
  });
});

describe('encodeProjectPath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('handles root path', () => {
    expect(encodeProjectPath('/')).toBe('-');
  });

  it('handles path without leading slash', () => {
    expect(encodeProjectPath('Users/foo')).toBe('Users-foo');
  });

  it('handles deep nested paths with dotted username', () => {
    expect(encodeProjectPath('/Users/jane.doe/Downloads/memory-persistor'))
      .toBe('-Users-jane-doe-Downloads-memory-persistor');
  });

  it('matches the project-path encoder encoding', () => {
    // Regression for silent file-mirror drift: MCP must encode `.` the same way
    // the project-path encoder does.
    expect(encodeProjectPath('/Users/jane.doe'))
      .toBe('-Users-jane-doe');
  });

  it('handles trailing slash', () => {
    expect(encodeProjectPath('/Users/foo/')).toBe('-Users-foo-');
  });
});

describe('truncateDescription', () => {
  it('passes short strings through unchanged', () => {
    expect(truncateDescription('short note')).toBe('short note');
  });

  it('trims leading and trailing whitespace', () => {
    expect(truncateDescription('  padded  ')).toBe('padded');
  });

  it('replaces newlines with spaces', () => {
    expect(truncateDescription('line one\nline two')).toBe('line one line two');
  });

  it('accepts null and undefined', () => {
    expect(truncateDescription(null)).toBe('');
    expect(truncateDescription(undefined)).toBe('');
  });

  it('truncates at word boundary when one exists in the last 40%', () => {
    // 69 chars with spaces — word boundary should trigger
    const input = 'The quick brown fox jumps over the lazy dog and keeps running forever';
    const out = truncateDescription(input);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(out.endsWith(' ')).toBe(false);
    // Must end on a complete word — next char in input after `out` is a space
    expect(input[out.length]).toBe(' ');
  });

  it('hard-cuts to exact max when input has no spaces at all', () => {
    const out = truncateDescription('z'.repeat(200));
    expect(out).toBe('z'.repeat(DESCRIPTION_MAX));
  });

  it('preserves astral-plane emoji without mid-surrogate cuts', () => {
    // 🧉 is U+1F9C9 (2 UTF-16 code units, 1 code point). MAX-1 emoji + 1 = MAX code points.
    const emoji = '🧉'.repeat(DESCRIPTION_MAX * 2);
    const out = truncateDescription(emoji);
    expect(Array.from(out).length).toBe(DESCRIPTION_MAX);
    expect(Array.from(out).every(ch => ch === '🧉')).toBe(true);
  });

  it('is idempotent', () => {
    const long = 'The quick brown fox jumps over the lazy dog and keeps running';
    const once = truncateDescription(long);
    expect(truncateDescription(once)).toBe(once);
  });

  it('passes through an exactly DESCRIPTION_MAX-char string unchanged', () => {
    const exact = 'a'.repeat(DESCRIPTION_MAX);
    expect(truncateDescription(exact)).toBe(exact);
  });

  it('truncates a (DESCRIPTION_MAX+1)-char string via hard-cut (no interior space)', () => {
    expect(truncateDescription('b'.repeat(DESCRIPTION_MAX + 1))).toBe('b'.repeat(DESCRIPTION_MAX));
  });

  it('hard-cuts when space sits exactly at the 0.6 threshold (strict >)', () => {
    // Space at index threshold = exactly 0.6*MAX. Condition `lastSpace > threshold` is false → hard-cut.
    // Requires DESCRIPTION_MAX * 0.6 to be a whole number (true for any multiple of 5 ≥ 10).
    const threshold = Math.floor(DESCRIPTION_MAX * 0.6);
    const input = 'c'.repeat(threshold) + ' ' + 'd'.repeat(DESCRIPTION_MAX);
    const out = truncateDescription(input);
    expect(out.length).toBe(DESCRIPTION_MAX);
    expect(out).toBe('c'.repeat(threshold) + ' ' + 'd'.repeat(DESCRIPTION_MAX - threshold - 1));
  });

  it('returns empty string for empty input', () => {
    expect(truncateDescription('')).toBe('');
  });
});

describe('updateMemoryIndex', () => {
  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'mem-idx-'));
  }

  it('caps long frontmatter descriptions when rebuilding the index', () => {
    const dir = makeTmpDir();
    try {
      const longDesc = 'a'.repeat(300);
      writeFileSync(
        join(dir, 'sample.md'),
        `---\nname: sample\ndescription: ${longDesc}\ntype: feedback\n---\nbody\n`,
        'utf-8',
      );
      updateMemoryIndex(dir);
      const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
      const entry = index.split('\n').find(l => l.startsWith('- feedback: sample'))!;
      const descPart = entry.split(' — ')[1];
      expect(descPart.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits `- <type>: <name> — <desc>` and never a markdown link', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, 'feedback_some-slug.md'),
        `---\nname: Always confirm before git push\ndescription: Ask first\ntype: feedback\n---\nbody\n`,
        'utf-8',
      );
      updateMemoryIndex(dir);
      const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
      expect(index).toContain('- feedback: Always confirm before git push — Ask first');
      expect(index).not.toContain('](');
      expect(index).not.toContain('.md —');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads `type` nested under metadata: for legacy-format files', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, 'legacy.md'),
        `---\nname: some-scoped-reference\ndescription: Scoped only\n` +
          `metadata:\n  node_type: memory\n  type: reference\n---\nbody\n`,
        'utf-8',
      );
      updateMemoryIndex(dir);
      const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
      expect(index).toContain('- reference: some-scoped-reference — Scoped only');
      expect(index).not.toContain('unknown:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to filename-derived values when name or type is missing', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, 'missing.md'),
        `---\nname: missing\ntype: feedback\n---\nno description line\n`,
        'utf-8',
      );
      writeFileSync(
        join(dir, 'bare.md'),
        `---\ndescription: has desc\n---\nno name, no type\n`,
        'utf-8',
      );
      updateMemoryIndex(dir);
      const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
      expect(index).toContain('- feedback: missing — missing.md');
      expect(index).toContain('- unknown: bare — has desc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeFile pg_id glob', () => {
  // syncToFile / removeFile are anchored at CLAUDE_DIR/projects/<encoded>/memory.
  // A unique source path per test isolates the dir from real memory files.
  function makeIsolatedSource(): { source: string; dir: string; projectDir: string } {
    const source = `/tmp/mem-removeFile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projectDir = join(CLAUDE_DIR, 'projects', encodeProjectPath(source));
    const dir = join(projectDir, 'memory');
    mkdirSync(dir, { recursive: true });
    return { source, dir, projectDir };
  }

  function frontmatter(name: string, type: string, pgId: string, body = ''): string {
    return [
      '---',
      `name: ${name}`,
      `type: ${type}`,
      `pg_id: ${pgId}`,
      '---',
      '',
      body,
      '',
    ].join('\n');
  }

  it('caps the filename slug at 120 chars, not 60', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      // 200 words → a slug far longer than the cap before truncation.
      const longName = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
      syncToFile({
        id: '77777777-7777-4777-8777-777777777777',
        name: longName,
        type: 'fact',
        observations: 'long name body',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });

      const written = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      expect(written).toHaveLength(1);

      // Filename is `<type>_<slug>.md` — strip the prefix and suffix to get the slug.
      const slug = written[0].replace(/^fact_/, '').replace(/\.md$/, '');
      expect(slug).toHaveLength(120);
      // Guards the old 60-char ceiling specifically.
      expect(slug.length).toBeGreaterThan(60);
      // Whole filename still fits comfortably under the 255-byte FS limit.
      expect(written[0].length).toBeLessThan(255);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('deletes orphan files sharing the same pg_id and spares unrelated ones', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      const pgId = '11111111-1111-1111-1111-111111111111';
      const otherPgId = '22222222-2222-2222-2222-222222222222';

      // Canonical file written via the public sync path.
      syncToFile({
        id: pgId,
        name: 'current-name',
        type: 'fact',
        observations: 'canonical body',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });
      const canonicalPath = join(dir, 'fact_current-name.md');
      expect(existsSync(canonicalPath)).toBe(true);

      // Orphan from a past rename — different slug, same pg_id.
      const orphanPath = join(dir, 'fact_old-name.md');
      writeFileSync(orphanPath, frontmatter('old-name', 'fact', pgId, 'stale'), 'utf-8');

      // Bystander with a DIFFERENT pg_id — must survive.
      const bystanderPath = join(dir, 'fact_unrelated.md');
      writeFileSync(bystanderPath, frontmatter('unrelated', 'fact', otherPgId, 'keep me'), 'utf-8');

      removeFile({
        id: pgId,
        name: 'current-name',
        type: 'fact',
        observations: 'canonical body',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });

      expect(existsSync(canonicalPath)).toBe(false);
      expect(existsSync(orphanPath)).toBe(false);
      expect(existsSync(bystanderPath)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('syncToFile removes stale same-pg_id files left by a rename', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      const pgId = '55555555-5555-4555-8555-555555555555';
      const otherPgId = '66666666-6666-4666-8666-666666666666';

      // Pre-existing file under the OLD slug, same entity.
      const orphanPath = join(dir, 'fact_old-name.md');
      writeFileSync(orphanPath, frontmatter('old-name', 'fact', pgId, 'stale'), 'utf-8');

      // Bystander with a different pg_id — must survive.
      const bystanderPath = join(dir, 'fact_unrelated.md');
      writeFileSync(bystanderPath, frontmatter('unrelated', 'fact', otherPgId, 'keep'), 'utf-8');

      // Rename: same pg_id, new name → new slug.
      syncToFile({
        id: pgId,
        name: 'new name',
        type: 'fact',
        observations: 'renamed body',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });

      expect(existsSync(join(dir, 'fact_new-name.md'))).toBe(true);
      expect(existsSync(orphanPath)).toBe(false);
      expect(existsSync(bystanderPath)).toBe(true);

      // Exactly one file on disk carries this entity's pg_id.
      const mine = readdirSync(dir).filter(
        f =>
          f.endsWith('.md') &&
          f !== 'MEMORY.md' &&
          readFileSync(join(dir, f), 'utf-8').includes(`pg_id: ${pgId}`),
      );
      expect(mine).toHaveLength(1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not match pg_id mentioned only in the body', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      const pgId = '33333333-3333-3333-3333-333333333333';
      const otherPgId = '44444444-4444-4444-4444-444444444444';

      // Canonical file the entity actually owns.
      syncToFile({
        id: pgId,
        name: 'body-mention',
        type: 'fact',
        observations: 'body',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });

      // Bystander frontmatter holds a different pg_id, body mentions ours.
      const bystanderPath = join(dir, 'fact_bystander.md');
      writeFileSync(
        bystanderPath,
        frontmatter('bystander', 'fact', otherPgId, `Note: pg_id: ${pgId} appears in body only.`),
        'utf-8',
      );

      removeFile({
        id: pgId,
        name: 'body-mention',
        type: 'fact',
        observations: 'body',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });

      expect(existsSync(bystanderPath)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('handles missing canonical file when an orphan is the only match', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      const pgId = '55555555-5555-5555-5555-555555555555';

      // No syncToFile this time — only a stale orphan exists on disk.
      const orphanPath = join(dir, 'fact_only-orphan.md');
      writeFileSync(orphanPath, frontmatter('only-orphan', 'fact', pgId, 'orphan'), 'utf-8');

      removeFile({
        id: pgId,
        name: 'never-written-with-this-name',
        type: 'fact',
        observations: '',
        source,
        temperature: 0.5,
        tier: 'WARM',
      });

      expect(existsSync(orphanPath)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('truncateDescription with custom max', () => {
  it('defaults to DESCRIPTION_MAX (40) when no max provided', () => {
    const long = 'a'.repeat(100);
    expect(truncateDescription(long).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it('respects a custom max of 200', () => {
    const long = 'a'.repeat(500);
    expect(truncateDescription(long, 200).length).toBeLessThanOrEqual(200);
    expect(truncateDescription(long, 200)).toBe('a'.repeat(200));
  });

  it('word-bounds at the custom max', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const result = truncateDescription(text, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.endsWith(' ')).toBe(false);
    expect(text.startsWith(result)).toBe(true);
  });

  it('returns short input unchanged regardless of custom max', () => {
    expect(truncateDescription('short', 200)).toBe('short');
  });

  it('strips newlines before applying custom max', () => {
    expect(truncateDescription('line one\nline two\nline three', 200)).toBe('line one line two line three');
  });
});

describe('syncMerge', () => {
  function makeIsolatedSource(): { source: string; dir: string; projectDir: string } {
    const source = `/tmp/mem-syncMerge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projectDir = join(CLAUDE_DIR, 'projects', encodeProjectPath(source));
    const dir = join(projectDir, 'memory');
    mkdirSync(dir, { recursive: true });
    return { source, dir, projectDir };
  }

  it('differing slug: deletes source .md + its MEMORY.md line, keeps target', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      const srcEntity = {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'old source name', type: 'project',
        observations: 'source body', source, temperature: 0.5, tier: 'WARM',
      };
      const tgtEntity = {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        name: 'surviving target name', type: 'project',
        observations: 'target body merged', source, temperature: 0.5, tier: 'WARM',
      };
      syncToFile(srcEntity);
      syncToFile(tgtEntity);

      const srcPath = join(dir, 'project_old-source-name.md');
      const tgtPath = join(dir, 'project_surviving-target-name.md');
      expect(existsSync(srcPath)).toBe(true);
      expect(existsSync(tgtPath)).toBe(true);

      syncMerge(srcEntity, tgtEntity);

      expect(existsSync(srcPath)).toBe(false);
      expect(existsSync(tgtPath)).toBe(true);
      expect(readFileSync(tgtPath, 'utf-8')).toContain('target body merged');

      const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
      expect(index).not.toContain('old-source-name');
      const bullets = index.split('\n').filter(l => l.startsWith('- '));
      expect(bullets).toHaveLength(1);
      // Index lists `- <type>: <name>`, not the filename slug.
      expect(bullets[0]).toContain('- project: surviving target name');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('same slug: survivor written last, never left deleted', () => {
    const { source, dir, projectDir } = makeIsolatedSource();
    try {
      const shared = {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        name: 'shared name', type: 'fact',
        observations: 'original', source, temperature: 0.5, tier: 'WARM',
      };
      syncToFile(shared);
      const sharedPath = join(dir, 'fact_shared-name.md');
      expect(existsSync(sharedPath)).toBe(true);

      const sourceSnapshot = { ...shared, observations: '', temperature: 0, tier: '' };
      const survivor = { ...shared, observations: 'merged survivor body' };
      syncMerge(sourceSnapshot, survivor);

      expect(existsSync(sharedPath)).toBe(true);
      expect(readFileSync(sharedPath, 'utf-8')).toContain('merged survivor body');
      const bullets = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
        .split('\n').filter(l => l.startsWith('- '));
      expect(bullets).toHaveLength(1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

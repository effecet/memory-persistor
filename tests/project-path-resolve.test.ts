import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeProjectPath,
  resolveProjectPath,
  resolveProjectPathDetailed,
  collectProjectSources,
} from '../src/file-sync.js';

// the path-decode fix: import.ts decoded every "-" as "/", so `make seed` wrote sources like
// /Users/jane/doe/Downloads/maple/leaf/fabric. The encoding is lossy
// (both "/" and "." become "-"), so the only honest inverse is the filesystem.
let root: string;
const LONG = Array.from({ length: 23 }, (_, i) => String.fromCharCode(97 + i)).join('-'); // a-b-…-w, 22 dashes

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-'));
  for (const d of [
    'Users/foo.bar/Downloads/maple-leaf-fabric',
    'Users/foo.bar/Downloads/sample_project',
    'Users/foo.bar/.claude',
    'Users/foo.bar/proj',
    'amb/a-b',
    'amb/a/b',
    'dead/a', // prefix sibling that leads nowhere
    'dead/a-b',
    `long/${LONG}`,
    'real/proj',
    'locked/x', // made unreadable below
    'locked/x-y',
  ]) mkdirSync(join(root, d), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  symlinkSync(join(root, 'link'), join(root, 'real', 'loop')); // a cycle
  mkdirSync(join(root, 'eloop', 'x-y'), { recursive: true });
  symlinkSync('x', join(root, 'eloop', 'x')); // points at itself: stat → ELOOP, even as root
  chmodSync(join(root, 'locked', 'x'), 0o000);
});

afterAll(() => {
  chmodSync(join(root, 'locked', 'x'), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('resolveProjectPath', () => {
  it('recovers a dotted username and a hyphenated project name', () => {
    expect(resolveProjectPath('-Users-foo-bar-Downloads-maple-leaf-fabric', root))
      .toBe('/Users/foo.bar/Downloads/maple-leaf-fabric');
  });

  it('keeps underscores, which the encoding never touches', () => {
    expect(resolveProjectPath('-Users-foo-bar-Downloads-sample_project', root))
      .toBe('/Users/foo.bar/Downloads/sample_project');
  });

  it('resolves a dot-directory, which encodes as a double dash', () => {
    expect(resolveProjectPath('-Users-foo-bar--claude', root)).toBe('/Users/foo.bar/.claude');
  });

  it('explores past a prefix sibling that turns out to be a dead end', () => {
    expect(resolveProjectPath('-dead-a-b', root)).toBe('/dead/a-b');
  });

  it('follows a symlinked directory, as Claude Code may record a cwd under one', () => {
    expect(resolveProjectPath('-link-proj', root)).toBe('/link/proj');
  });

  it('terminates on a symlink cycle', () => {
    expect(resolveProjectPath('-real-loop-loop-loop-proj', root)).toBe('/real/loop/loop/loop/proj');
  });

  it('stays linear on a long dash-heavy name (the 3^n version hung on 20 dashes)', () => {
    const t = performance.now();
    expect(resolveProjectPath(`-long-${LONG}`, root)).toBe(`/long/${LONG}`);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('fails closed as "none" when no directory matches — never a guess', () => {
    expect(resolveProjectPathDetailed('-Users-foo-bar-Downloads-gone-project', root)).toEqual({ skip: 'none' });
    expect(resolveProjectPath('-Users-foo-bar-Downloads-gone-project', root)).toBeNull();
  });

  it('fails closed as "ambiguous" when two real directories encode alike', () => {
    expect(resolveProjectPathDetailed('-amb-a-b', root)).toEqual({ skip: 'ambiguous' });
  });

  it.skipIf(asRoot)('fails closed as "unreadable" when a branch that could match cannot be listed', () => {
    // /locked/x is unreadable and /locked/x-y is not: a unique answer from the
    // readable half would hide whatever /locked/x/y might have been.
    expect(resolveProjectPathDetailed('-locked-x-y', root)).toEqual({ skip: 'unreadable' });
  });

  it('fails closed as "unreadable" when a symlink that could match cannot be inspected — runs as root too', () => {
    // CI runs as root in its container, where chmod 000 blocks nothing, so the
    // test above is skipped there. ELOOP needs no permissions to reproduce.
    expect(resolveProjectPathDetailed('-eloop-x-y', root)).toEqual({ skip: 'unreadable' });
  });

  it('fails closed as "too-large" past the visit cap', () => {
    expect(resolveProjectPathDetailed(`-long-${LONG}`, root, 1)).toEqual({ skip: 'too-large' });
  });

  it('rejects a name without the leading dash', () => {
    expect(resolveProjectPathDetailed('C--WINDOWS-system32', root)).toEqual({ skip: 'none' });
  });

  it('round-trips: every resolved path re-encodes to its input', () => {
    for (const enc of ['-Users-foo-bar-Downloads-maple-leaf-fabric', '-Users-foo-bar--claude', '-dead-a-b', '-link-proj']) {
      const got = resolveProjectPath(enc, root);
      expect(got).not.toBeNull();
      expect(encodeProjectPath(got as string)).toBe(enc);
    }
  });
});

describe('collectProjectSources — what `make seed` imports', () => {
  it('resolves real projects and reports the rest with a reason', () => {
    const projects = mkdtempSync(join(tmpdir(), 'projects-'));
    try {
      for (const dir of ['-Users-foo-bar-proj', '-home-other-host', '-amb-a-b', '-no-memory-dir', '-memory-is-a-file']) {
        mkdirSync(join(projects, dir, dir === '-home-other-host' || dir === '-Users-foo-bar-proj' || dir === '-amb-a-b' ? 'memory' : ''), { recursive: true });
      }
      writeFileSync(join(projects, '-memory-is-a-file', 'memory'), '');
      writeFileSync(join(projects, '-home-other-host', 'memory', 'feedback_a.md'), '');
      writeFileSync(join(projects, '-home-other-host', 'memory', 'MEMORY.md'), '');
      writeFileSync(join(projects, 'stray-file'), '');
      symlinkSync(join(projects, '-Users-foo-bar-proj'), join(projects, '-link-proj'));
      const { resolved, skipped } = collectProjectSources(projects, root);
      expect(resolved).toEqual(
        expect.arrayContaining([
          { dir: '-Users-foo-bar-proj', source: '/Users/foo.bar/proj' },
          { dir: '-link-proj', source: '/link/proj' }, // a symlinked project dir counts
        ]),
      );
      expect(resolved).toHaveLength(2);
      expect(skipped).toEqual(
        expect.arrayContaining([
          { dir: '-home-other-host', reason: 'none', files: 1 }, // MEMORY.md is not counted
          { dir: '-amb-a-b', reason: 'ambiguous', files: 0 },
        ]),
      );
      // no memory/ dir, memory as a plain file, and stray files are not projects
      expect(skipped).toHaveLength(2);
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('is the only way import.ts derives a source', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'import.ts'), 'utf-8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(src).toMatch(/collectProjectSources\(projectsDir\)/);
    expect(src).toMatch(/for \(const \{ dir, source \} of resolved\)/);
    expect(src.match(/\bsource\s*=/g) ?? []).toHaveLength(0);
  });
});

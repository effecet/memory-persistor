/**
 * file-sync never writes outside CLAUDE_DIR during the suite.
 *
 * tests/setup.ts points CLAUDE_DIR at a per-process temp dir before
 * src/config.ts is evaluated. This pins the other half of that contract: every
 * path file-sync writes, creates or deletes is under that dir. The fs wrapper
 * refuses (throws, without touching disk) any mutation outside it, so a
 * regression fails here instead of writing into a developer's real
 * ~/.claude.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const touched: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const guard = <A extends unknown[], R>(fn: (p: string, ...rest: A) => R) =>
    (p: string, ...rest: A): R => {
      const abs = resolve(String(p));
      touched.push(abs);
      const root = resolve(process.env.CLAUDE_DIR ?? '/nonexistent-claude-dir');
      if (!abs.startsWith(root + '/') && abs !== root) {
        throw new Error(`file-sync tried to write outside CLAUDE_DIR: ${abs}`);
      }
      return fn(p, ...rest);
    };
  return {
    ...real,
    writeFileSync: guard(real.writeFileSync as never),
    mkdirSync: guard(real.mkdirSync as never),
    unlinkSync: guard(real.unlinkSync as never),
  };
});

const { syncToFile, removeFile } = await import('../src/file-sync.js');

describe('file-sync stays inside CLAUDE_DIR', () => {
  beforeEach(() => {
    touched.length = 0;
  });

  it('CLAUDE_DIR is the per-process temp dir from tests/setup.ts, not ~/.claude', () => {
    expect(process.env.CLAUDE_DIR).toBeTruthy();
    expect(resolve(process.env.CLAUDE_DIR!)).not.toBe(resolve(join(homedir(), '.claude')));
  });

  it('syncToFile and removeFile write only under CLAUDE_DIR', async () => {
    const entity = {
      id: '00000000-0000-4000-8000-0000000000aa',
      name: 'Sandbox probe memory',
      type: 'fact',
      observations: 'body',
      temperature: 0.5,
      tier: 'WARM',
      source: '/tmp/some/project',
    };
    // null = the explicit DB-unreachable sentinel: no live thermal lookup from a unit test.
    await syncToFile(entity, null);
    await removeFile(entity, null);

    expect(touched.length).toBeGreaterThan(0);
    const root = resolve(process.env.CLAUDE_DIR!);
    for (const p of touched) expect(p.startsWith(root + '/')).toBe(true);
  });
});

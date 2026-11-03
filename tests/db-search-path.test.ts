/**
 * The connection search_path must be pinned, and actually WIRED into both pools.
 *
 * Without it every recall against Supabase aborts with
 * `42883 function word_similarity(unknown, unknown) does not exist`.
 * See src/search-path.ts for the full rationale.
 *
 * The wiring assertions mock `pg` and read the real Pool constructor argument.
 * An earlier version matched source text (`/options:\s*SEARCH_PATH_OPTIONS/`)
 * and was defeated by the obvious mutation: commenting the line out leaves the
 * text in place, so the fix could be fully disabled with all tests green and
 * `tsc` clean (there is no noUnusedLocals to flag the orphaned import). Do not
 * regress to a source-text check here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEARCH_PATH_OPTIONS, SEARCH_PATH_SCHEMAS } from '../src/search-path.js';

/**
 * Point db.ts's dotenv at a throwaway .env holding `url`, and return a restore fn.
 * Setting process.env.DATABASE_URL directly does NOT work: db.ts calls
 * dotenv.config({ override: true }), which would overwrite it from ./.env.
 */
function withEnvUrl(url: string): () => void {
  const prev = process.env.DOTENV_CONFIG_PATH;
  const file = join(mkdtempSync(join(tmpdir(), 'sp-')), 'probe.env');
  writeFileSync(file, `DATABASE_URL=${url}\n`);
  process.env.DOTENV_CONFIG_PATH = file;
  return () => {
    if (prev === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = prev;
  };
}

/** Pool options captured from whichever module we import under the pg mock. */
const poolArgs: Record<string, unknown>[] = [];

vi.mock('pg', () => {
  class FakePool {
    constructor(opts: Record<string, unknown>) {
      poolArgs.push(opts);
    }
    // Touched only if a module queries at import time; none do.
    query() {
      return Promise.resolve({ rows: [] });
    }
    end() {
      return Promise.resolve();
    }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

describe('search_path value', () => {
  it('searches public first, then extensions', () => {
    // Order is load-bearing, so this is an exact match, not arrayContaining:
    // an earlier schema shadows later ones, and `public` holds the app's own
    // objects. `extensions,public` passed every earlier version of this suite.
    expect([...SEARCH_PATH_SCHEMAS]).toEqual(['public', 'extensions']);
  });

  it('renders a libpq -c option from those schemas', () => {
    expect(SEARCH_PATH_OPTIONS).toBe('-c search_path=public,extensions');
  });
});

describe('search-path.ts stays a leaf module', () => {
  // If this module ever reads process.env, importing it from db.ts reintroduces
  // the evaluation-order bug that silently disabled embed-on-write.
  // tests/env-load-order.test.ts pins the consequence; this pins the cause.
  it('reads no environment variables', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const src = readFileSync(join(resolve(__dirname, '..'), 'src/search-path.ts'), 'utf8');
    const active = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
    expect(active).not.toMatch(/process\.env/);
  });

  it('imports nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const src = readFileSync(join(resolve(__dirname, '..'), 'src/search-path.ts'), 'utf8');
    const active = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
    expect(active).not.toMatch(/^\s*import\s/m);
  });
});

describe('wiring (real Pool arguments, not source text)', () => {
  beforeEach(() => {
    poolArgs.length = 0;
    vi.resetModules();
  });

  it('src/db.ts passes the options to its Pool', async () => {
    await import('../src/db.js');
    expect(poolArgs.length).toBeGreaterThan(0);
    expect(poolArgs[0].options).toBe(SEARCH_PATH_OPTIONS);
  });

  it('does not let an options= reach the Pool via the connection string', async () => {
    // buildConnectionString() is otherwise untested, and pg lets a URL-borne
    // `options=` beat the code value outright (Object.assign order) — so
    // appending one there silently disables the pin in production while
    // poolArgs[0].options still looks correct. Assert on the URL too.
    const restore = withEnvUrl('postgresql://localhost:5432/memory_persistor');
    try {
      await import('../src/db.js');
      const cs = String(poolArgs[0].connectionString ?? '');
      expect(cs).not.toMatch(/[?&]options=/);
    } finally {
      restore();
    }
  });

  it('the integration pool passes them too, so testDb matches the code under test', async () => {
    // helpers.ts asserts a local target at module scope; give it one. Its own
    // dotenv.config() finds no override for an already-set var in CI.
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://localhost:5432/memory_persistor';
    try {
      await import('./integration/helpers.js');
      const opts = poolArgs.map((a) => a.options);
      expect(opts).toContain(SEARCH_PATH_OPTIONS);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

describe('URL-borne options= is announced, not silently obeyed', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    poolArgs.length = 0;
    vi.resetModules();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('warns on stderr when DATABASE_URL carries its own options=', async () => {
    const restore = withEnvUrl(
      'postgresql://localhost:5432/memory_persistor?options=-c%20search_path%3Dpublic',
    );
    try {
      await import('../src/db.js');
      const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toMatch(/options=/);
      expect(msg).toMatch(/42883/);
      // The warning must never echo the URL itself — it may carry credentials.
      expect(msg).not.toMatch(/postgresql:\/\//);
    } finally {
      restore();
    }
  });

  it('stays silent for a normal URL', async () => {
    const restore = withEnvUrl('postgresql://localhost:5432/memory_persistor');
    try {
      await import('../src/db.js');
      const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).not.toMatch(/WARNING: DATABASE_URL carries/);
    } finally {
      restore();
    }
  });
});

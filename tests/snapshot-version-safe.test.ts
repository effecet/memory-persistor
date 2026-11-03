/**
 * snapshotVersion's failure must be VISIBLE, not swallowed.
 *
 * The `update` handler deliberately does not let a history-write failure block
 * a user's edit — that policy is fine. What was not fine was doing it silently:
 * a transient failure permanently destroyed that edit's history with no log
 * line and no counter, which invited the (invalid) inference that zero version
 * rows means a memory was never edited.
 *
 * snapshotVersionSafe is that policy, named and testable. Mirrors the
 * non-fatal-but-logged shape already used by embedForWrite — see
 * tests/embed-write-failure.test.ts.
 *
 * Mocks ../src/db.js so the INSERT rejects deterministically, and so importing
 * intelligence.ts here never opens a real Postgres connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execute = vi.fn();

vi.mock('../src/db.js', () => ({
  db: {
    execute: (...args: unknown[]) => execute(...args),
  },
}));

beforeEach(() => {
  execute.mockReset();
  // Spies must not bleed between tests: a console.log spy left installed by an
  // earlier test reports ITS calls here, which would misattribute a failure to
  // whichever test happened to run last.
  vi.restoreAllMocks();
});

describe('snapshotVersionSafe', () => {
  it('returns false and logs to stderr instead of throwing when the insert fails', async () => {
    execute.mockRejectedValue(new Error('simulated pooler connection reset'));
    const { snapshotVersionSafe } = await import('../src/intelligence.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const id = '11111111-2222-3333-4444-555555555555';
    const result = await snapshotVersionSafe(id);

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    // stdout is the MCP JSON-RPC transport — a stray console.log here would
    // corrupt the stream, the exact shape of the 2026-08-18 dotenv-banner bug.
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('names the entity id in the log line, so a lost snapshot is traceable', async () => {
    execute.mockRejectedValue(new Error('simulated pooler connection reset'));
    const { snapshotVersionSafe } = await import('../src/intelligence.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const id = '11111111-2222-3333-4444-555555555555';
    await snapshotVersionSafe(id);

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain(id);
    // The underlying cause must survive too — "it failed" alone is not actionable.
    expect(logged).toContain('simulated pooler connection reset');
    errorSpy.mockRestore();
  });

  it('returns true and logs nothing when the snapshot succeeds', async () => {
    execute.mockResolvedValue({ rowCount: 1 });
    const { snapshotVersionSafe } = await import('../src/intelligence.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await snapshotVersionSafe('11111111-2222-3333-4444-555555555555');

    expect(result).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns false when the insert wrote no row, without throwing', async () => {
    // snapshotVersion is INSERT ... SELECT ... WHERE id = $1: a nonexistent id
    // inserts zero rows and does NOT throw. Verified against PG16 on 2026-08-31
    // (`INSERT 0 0`). Reporting that as success would recreate the lost-history fix's exact
    // blast radius — believing history exists when it does not.
    execute.mockResolvedValue({ rowCount: 0 });
    const { snapshotVersionSafe } = await import('../src/intelligence.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const id = '11111111-2222-3333-4444-555555555555';
    const result = await snapshotVersionSafe(id);

    expect(result).toBe(false);
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(id);
    errorSpy.mockRestore();
  });
});

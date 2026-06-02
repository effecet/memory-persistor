/**
 * events.ts error-visibility guard.
 *
 * A silent `.catch(() => {})` masked a misrouted DATABASE_URL for six days
 * (2026-04-07 → 2026-04-13). logEvent MUST:
 *   1. Never throw or reject (fire-and-forget semantics preserved).
 *   2. Write a structured diagnostic to stderr when the underlying insert
 *      rejects — otherwise a broken pipeline surfaces only via the
 *      freshness canary, which is days late.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const insertValuesMock = vi.fn();

vi.mock('../src/db.js', () => ({
  db: {
    insert: () => ({
      values: (...args: unknown[]) => insertValuesMock(...args),
    }),
  },
}));

// Imported after the mock is registered.
import { logEvent } from '../src/events.js';

describe('logEvent stderr visibility', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    insertValuesMock.mockReset();
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns void synchronously (never blocks)', () => {
    insertValuesMock.mockReturnValue(Promise.resolve());
    const ret = logEvent('recall', null, { query: 'x' });
    expect(ret).toBeUndefined();
  });

  it('writes a structured stderr line when the insert rejects', async () => {
    insertValuesMock.mockReturnValue(
      Promise.reject(new Error('connection refused')),
    );

    logEvent('remember', 'abc-123', { type: 'fact' });

    // Let the microtask fire so the rejection reaches .catch.
    await Promise.resolve();
    await Promise.resolve();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = (stderrSpy.mock.calls[0] as string[])[0];
    expect(line).toContain('[events] logEvent failed');
    expect(line).toContain('eventType=remember');
    expect(line).toContain('memoryId=abc-123');
    expect(line).toContain('err=connection refused');
  });

  it('renders null memoryId as the literal "null" in the diagnostic', async () => {
    insertValuesMock.mockReturnValue(Promise.reject(new Error('boom')));

    logEvent('recall', null, {});
    await Promise.resolve();
    await Promise.resolve();

    const line = (stderrSpy.mock.calls[0] as string[])[0];
    expect(line).toMatch(/memoryId=null\b/);
  });

  it('never throws when insert() itself throws synchronously', () => {
    insertValuesMock.mockImplementation(() => {
      throw new Error('synchronous throw');
    });
    // logEvent is declared to return void and must not propagate — the
    // try/catch in logEvent converts the sync throw into a stderr line.
    expect(() => logEvent('recall', null, {})).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect((stderrSpy.mock.calls[0] as string[])[0]).toContain('synchronous throw');
  });
});

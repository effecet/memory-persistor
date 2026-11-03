import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CategorizedError,
  classifyError,
  isRetryable,
  toErrorResult,
  runNonFatal,
  type ErrorCategory,
  type NonFatalWarning,
} from '../src/errors.js';

/** A pg DatabaseError-shaped object: an Error carrying a SQLSTATE `code`. */
function pgError(code: string, message = `pg failure ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

/** What drizzle 0.45 throws: message embeds SQL + params; the driver error is `cause`. */
function drizzleWrapped(cause: Error): Error {
  return Object.assign(
    new Error('Failed query: SELECT secret_body FROM entities\nparams: private memory text'),
    { cause },
  );
}

describe('classifyError', () => {
  it('passes a CategorizedError through untouched', () => {
    expect(classifyError(new CategorizedError('business', 'closed item'))).toEqual({
      category: 'business',
      message: 'closed item',
    });
  });

  it.each([
    ['08006', 'transient'],
    ['08001', 'transient'],
    ['57P01', 'transient'],
    ['57P02', 'transient'],
    ['57P03', 'transient'],
    ['53300', 'transient'],
    ['40001', 'transient'],
    ['40P01', 'transient'],
    ['22P02', 'validation'],
    ['22001', 'validation'],
    ['23502', 'validation'],
    ['23503', 'validation'],
    ['23505', 'validation'],
    ['23514', 'validation'],
    // Class 22/23 is NOT matched wholesale: these are server-side faults the
    // caller cannot fix by changing input. 22003 is the float4 underflow that
    // aborted recall (CLAUDE.md, the hub-ranking bug).
    ['22003', 'internal'],
    ['22012', 'internal'],
    ['23P01', 'internal'],
    ['42883', 'internal'],
    ['P0001', 'internal'],
  ] as [string, ErrorCategory][])('SQLSTATE %s → %s', (code, expected) => {
    expect(classifyError(pgError(code)).category).toBe(expected);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'])('errno %s → transient', (code) => {
    expect(classifyError(pgError(code)).category).toBe('transient');
  });

  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
  ])('code-less pg driver message %j → transient', (message) => {
    expect(classifyError(new Error(message)).category).toBe('transient');
  });

  it('matches a driver message on an OUTER error whose cause says something else', () => {
    // pg-pool wraps its connection-timeout error around the socket cause
    // (pg-pool/index.js:276), so the innermost message is not the one to match.
    const e = Object.assign(new Error('Connection terminated due to connection timeout'), {
      cause: new Error('socket hang up'),
    });
    expect(classifyError(e).category).toBe('transient');
  });

  it('never reports a DrizzleQueryError message, even with no Error cause', () => {
    const bare = Object.assign(
      new Error('Failed query: SELECT secret_body FROM entities\nparams: private memory text'),
      { query: 'SELECT secret_body FROM entities', params: ['private memory text'], cause: 'not an Error' },
    );
    const c = classifyError(bare);
    expect(c.message).toBe('Database query failed');
    expect(c.message).not.toContain('private memory text');
  });

  it('gives an empty-message AggregateError a usable message and category', () => {
    const agg = Object.assign(
      new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })], ''),
      { code: 'ECONNREFUSED' },
    );
    expect(classifyError(agg)).toEqual({ category: 'transient', message: 'connect ECONNREFUSED 127.0.0.1:5432' });
  });

  it('finds the code on a drizzle-wrapped cause', () => {
    expect(classifyError(drizzleWrapped(pgError('57P01'))).category).toBe('transient');
  });

  it('reports the innermost message, never the drizzle SQL + params', () => {
    const c = classifyError(drizzleWrapped(pgError('23503', 'violates foreign key constraint')));
    expect(c.message).toBe('violates foreign key constraint');
    expect(c.message).not.toContain('Failed query');
    expect(c.message).not.toContain('private memory text');
  });

  it('does not loop on a self-referential cause chain', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(classifyError(e)).toEqual({ category: 'internal', message: 'loop' });
  });

  it.each([
    [new Error('boom'), 'boom'],
    ['a thrown string', 'a thrown string'],
    [undefined, 'Unknown error'],
    [null, 'Unknown error'],
    [{ weird: true }, '[object Object]'],
  ])('unclassified %j → internal', (thrown, message) => {
    expect(classifyError(thrown)).toEqual({ category: 'internal', message });
  });
});

describe('isRetryable', () => {
  it.each([
    ['transient', true],
    ['validation', false],
    ['business', false],
    ['permission', false],
    ['internal', false],
  ] as [ErrorCategory, boolean][])('%s → %s', (category, expected) => {
    expect(isRetryable(category)).toBe(expected);
  });
});

describe('toErrorResult', () => {
  it.each(['validation', 'business', 'transient', 'permission', 'internal'] as ErrorCategory[])(
    'emits the contract shape for %s',
    (category) => {
      const result = toErrorResult({ category, message: 'm' });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual({
        error: 'm',
        errorCategory: category,
        isRetryable: category === 'transient',
      });
    },
  );
});

describe('runNonFatal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the value and records nothing on success', async () => {
    const warnings: NonFatalWarning[] = [];
    await expect(runNonFatal('dedup', async () => 42, warnings)).resolves.toBe(42);
    expect(warnings).toEqual([]);
  });

  it('swallows, classifies, records and logs to stderr on failure', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnings: NonFatalWarning[] = [];
    const result = await runNonFatal(
      'auto_relate',
      async () => {
        throw pgError('57P01', 'terminating connection');
      },
      warnings,
    );
    expect(result).toBeUndefined();
    expect(warnings).toEqual([
      { step: 'auto_relate', errorCategory: 'transient', error: 'terminating connection' },
    ]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('auto_relate'));
  });
});

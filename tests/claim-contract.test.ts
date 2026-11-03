/**
 * the claim contract — the write-time claim contract. Pure function, no database.
 *
 * Fixtures are real corpus phrasing from the 2026-10-15 measurement, so a
 * false positive here is one the production corpus would actually produce.
 */
import { describe, it, expect } from 'vitest';
import { checkClaims, assertClaimsAccepted, claimFlags, isVolatile, prepareImportRow, withVolatileTag, VOLATILE_TAG } from '../src/claim-contract.js';
import { CategorizedError } from '../src/errors.js';

describe('transcript rule (reject)', () => {
  it('rejects a body with four speaker-turn lines', () => {
    const body = 'User: why is CI red\nAssistant: jq is missing\nUser: fix it\nAssistant: done';
    expect(checkClaims(body).reject).toMatch(/conclusion, not the log/);
  });

  it('accepts three speaker-turn lines', () => {
    expect(checkClaims('User: a\nAssistant: b\nHuman: c').reject).toBeNull();
  });

  it('ignores turns inside a fenced code block: documenting a chat format is knowledge, not a log', () => {
    const body = 'The legacy prompt format:\n```\nHuman: hi\nAssistant: hello\nHuman: bye\nAssistant: ok\n```\nIt is gone in v3.';
    expect(checkClaims(body).reject).toBeNull();
  });

  it.each([
    ['an unclosed fence', 'Format:\n```\nHuman: a\nAssistant: b\nHuman: c\nAssistant: d'],
    ['a fence closed by the other marker', 'Format:\n```\nHuman: a\nAssistant: b\nHuman: c\nAssistant: d\n~~~\n'],
    ['a fence indented inside a list item', '- the format:\n  ```\n  Human: a\n  Assistant: b\n  Human: c\n  Assistant: d\n  ```'],
    ['CRLF line endings', 'Format:\r\n```\r\nHuman: a\r\nAssistant: b\r\nHuman: c\r\nAssistant: d\r\n```\r\n'],
  ])('never rejects turns inside %s', (_label, body) => {
    expect(checkClaims(body).reject).toBeNull();
  });

  it('does not treat a line opening with inline code as a fence', () => {
    const body = '```x``` is inline\nUser: a\nAssistant: b\nUser: c\nAssistant: d';
    expect(checkClaims(body).reject).not.toBeNull();
    expect(checkClaims('```x``` is inline\nCI takes ~5min.').volatile).toBe(true);
  });

  it('still rejects the turns that follow a properly closed fence', () => {
    const body = '```\ncode\n```\nUser: a\nAssistant: b\nUser: c\nAssistant: d';
    expect(checkClaims(body).reject).not.toBeNull();
  });

  it('counts only capitalised labels, as a transcript writes them', () => {
    expect(checkClaims('user: a\nassistant: b\nuser: c\nassistant: d').reject).toBeNull();
  });

  it('counts only line-leading turns, so prose that mentions "User:" is fine', () => {
    const body = 'The prompt starts with User: and ends with Assistant: — ' + 'User: x, '.repeat(5);
    expect(checkClaims(body).reject).toBeNull();
  });
});

describe('undated-volatile rule (flag)', () => {
  it.each([
    ['a size', '- **Size:** ~810KB JSON'],
    ['a percentage', "seed_dev's default status weights give ~83% (red)."],
    ['a duration', 'Result: cold-cache CI ~5min, warm-cache ~3min.'],
    ['a count noun', '~575 nodes returned as an 89KB file saved OUT of context'],
    ['a fractional seconds figure', 'the real numbers: 4.00s transit, 219px travelled'],
    ['a timeout in the 100-599 range', 'the default timeout is 300s'],
    ['a binary size', 'the cache grew to 512MiB'],
    ['"measured" with no date', 'latency measured in ms: 250ms'],
    ['a lowercase "may" before a number', 'we may 2000 rows at 40% load'],
    ['a month-like word before a year', 'Market 2025 share was 40%'],
  ])('flags %s with no date anchor', (_label, body) => {
    expect(checkClaims(body).volatile).toBe(true);
  });

  it.each([
    ['HTTP 401s', 'silently killing App Check activation and causing 401s on all API calls.'],
    ['HTTP 409s', 'If the rule already has `provenance: "api"` it 409s.'],
    ['no unit at all', 'Install 3 packages and restart.'],
    ['a decade', 'popular in the 1990s and again in the 2020s'],
    ['a loosely spaced "5 s"', 'wait a 5 s pause between retries'],
    ['a figure inside a code block', 'Use:\n```bash\nsleep 5s && retry\n```'],
  ])('does not flag %s', (_label, body) => {
    expect(checkClaims(body).volatile).toBe(false);
  });

  it.each([
    ['an ISO date', 'Measured on a production database 2026-09-17: 951 entities, 117 floored (12.3%).'],
    ['"as of"', 'As of this writing the index is ~60 KB.'],
    ['a slashed date', 'On 2026/10/15 cold-cache CI took ~5min.'],
    ['a month and year', 'In Oct 2026 cold-cache CI took ~5min.'],
    ['a full month name', 'In September 2026 cold-cache CI took ~5min.'],
    ['an ISO timestamp', 'At 2026-10-15T10:00Z cold-cache CI took ~5min.'],
    ['a date inside a code block (a dated log dates the memory)', 'CI took ~5min:\n```\n2026-10-15T10:00 done\n```'],
  ])('does not flag a figure anchored by %s', (_label, body) => {
    expect(checkClaims(body).volatile).toBe(false);
  });
});

describe('assertClaimsAccepted and claimFlags', () => {
  it('throws a validation CategorizedError on a transcript', () => {
    const body = 'User: a\nAssistant: b\nUser: c\nAssistant: d';
    expect(() => assertClaimsAccepted(body)).toThrow(CategorizedError);
    try { assertClaimsAccepted(body); } catch (e) { expect((e as CategorizedError).category).toBe('validation'); }
  });

  it('returns the check otherwise, and flags only a volatile body', () => {
    expect(claimFlags(assertClaimsAccepted('CI takes ~5min.').volatile))
      .toEqual([expect.objectContaining({ rule: 'undated-volatile' })]);
    expect(claimFlags(assertClaimsAccepted('No figures here.').volatile)).toEqual([]);
  });

  it('isVolatile is false for a rejected body', () => {
    expect(isVolatile('User: 5min\nAssistant: b\nUser: c\nAssistant: d')).toBe(false);
    expect(isVolatile('CI takes ~5min.')).toBe(true);
  });
});

describe('prepareImportRow (make seed)', () => {
  it('skips a transcript', () => {
    expect(prepareImportRow('User: a\nAssistant: b\nUser: c\nAssistant: d', '', ['ci']))
      .toEqual({ skip: expect.stringMatching(/conclusion, not the log/) });
  });

  it('tags a volatile body and keeps the other tags', () => {
    expect(prepareImportRow('CI takes ~5min.', '', ['ci'])).toEqual({ observations: 'CI takes ~5min.', tags: ['ci', VOLATILE_TAG] });
  });

  it('falls back to the description when the body is empty', () => {
    expect(prepareImportRow('', 'a dated note from 2026-10-15', ['ci'])).toEqual({ observations: 'a dated note from 2026-10-15', tags: ['ci'] });
  });
});

describe('withVolatileTag', () => {
  it('adds the tag once, keeping caller tags and order', () => {
    expect(withVolatileTag(['ci', VOLATILE_TAG], true)).toEqual(['ci', VOLATILE_TAG]);
    expect(withVolatileTag(['ci'], true)).toEqual(['ci', VOLATILE_TAG]);
  });

  it('removes only its own tag when the body is no longer volatile', () => {
    expect(withVolatileTag(['ci', VOLATILE_TAG, 'pi'], false)).toEqual(['ci', 'pi']);
  });
});

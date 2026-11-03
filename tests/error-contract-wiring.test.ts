/**
 * Every tool handler must be wrapped in withErrorContract.
 *
 * The behavioural contract tests drive failures through only some tools. An
 * UNWRAPPED handler still returns an isError result — the SDK's own catch
 * routes it through the createToolError override — so the shape looks right
 * and every behavioural test stays green, while classification is lost and a
 * DrizzleQueryError's message (full SQL + params, i.e. memory content) is what
 * reaches the caller. Only the source can show the wrapper is missing.
 *
 * Comment lines are stripped first so a commented-out wrapper cannot satisfy
 * the match, and each registration is paired with the wrapper for the SAME
 * name — a count alone passes when one tool is wrapped twice and another not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function activeSource(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

/** Each reg('X', …) — registerTools' handle-keeping registerTool — → whether its handler argument is withErrorContract('X', …). */
function registrations(src: string): { name: string; wrapped: boolean }[] {
  const starts = [...src.matchAll(/\breg\(\s*'([a-z_]+)',/g)];
  return starts.map((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
    const block = src.slice(m.index, end);
    return { name: m[1], wrapped: new RegExp(`\\n\\s*withErrorContract\\('${m[1]}', async`).test(block) };
  });
}

describe('error contract wiring', () => {
  it('registers exactly 18 tools, every one wrapped under its own name', () => {
    const regs = registrations(activeSource('src/mcp-tools.ts'));
    expect(regs).toHaveLength(18);
    expect(regs.filter((r) => !r.wrapped).map((r) => r.name)).toEqual([]);
  });

  it('the detector fires on an unwrapped or mis-named handler (positive control)', () => {
    const bare = "reg(\n    'forget',\n    { description: 'd' },\n    async ({ id }) => {\n";
    const misnamed = "reg(\n    'forget',\n    { description: 'd' },\n    withErrorContract('merge', async ({ id }) => {\n";
    const commented = "reg(\n    'forget',\n    { description: 'd' },\n    // withErrorContract('forget', async ({ id }) => {\n";
    expect(registrations(bare)[0].wrapped).toBe(false);
    expect(registrations(misnamed)[0].wrapped).toBe(false);
    expect(
      registrations(commented.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))[0].wrapped,
    ).toBe(false);
  });
});

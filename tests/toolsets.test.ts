/**
 * Toolset membership. Every registered tool must sit in exactly one set
 * — a tool missing from TOOLSETS would vanish from every narrowed server, and
 * one listed twice would make set arithmetic lie.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLSETS, parseToolsets } from '../src/config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('TOOLSETS', () => {
  const listed = Object.values(TOOLSETS).flat();

  it('lists no tool twice', () => {
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('covers exactly the tools src/mcp-tools.ts registers', () => {
    // Discovered from source, not a hardcoded list, so a new tool fails here
    // until it is given a set.
    const src = readFileSync(resolve(repoRoot, 'src/mcp-tools.ts'), 'utf-8');
    const registered = [...src.matchAll(/\breg\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual([...listed].sort());
  });
});

describe('registration guards', () => {
  const src = readFileSync(resolve(repoRoot, 'src/mcp-tools.ts'), 'utf-8');

  it('server.registerTool is called exactly once in mcp-tools.ts — inside reg()', () => {
    // A tool registered directly would bypass both reg-discovering guards
    // (this file, error-contract-wiring) and could never be narrowed away.
    const direct = [...src.matchAll(/server\.registerTool\(/g)];
    expect(direct).toHaveLength(1);
    expect(src).toMatch(/const reg: McpServer\['registerTool'\] = \(name, config, cb\) => \{\s*const handle = server\.registerTool\(/);
  });

  it('every registerResource handler goes through withResourceContract', () => {
    const res = readFileSync(resolve(repoRoot, 'src/mcp-resources.ts'), 'utf-8');
    const registrations = res.split('server.registerResource(').slice(1);
    expect(registrations.length).toBe(6);
    for (const block of registrations) {
      const name = block.match(/^\s*'([a-z-]+)'/)![1];
      expect(block, name).toMatch(new RegExp(`withResourceContract\\('${name}',`));
    }
  });
});

describe('parseToolsets', () => {
  it('reports unknown names so the caller can warn', () => {
    expect(parseToolsets('core,bogus').unknown).toEqual(['bogus']);
    expect([...parseToolsets('core,bogus').tools].sort()).toEqual([...TOOLSETS.core].sort());
  });

  it('still warns about a typo listed next to "all"', () => {
    expect(parseToolsets('all,coer').unknown).toEqual(['coer']);
    expect(parseToolsets('all,coer').tools.size).toBe(18);
  });

  it('treats unset, empty and "all" as every tool', () => {
    for (const v of [undefined, '', '  ', 'all', 'core,all']) {
      expect(parseToolsets(v).tools.size).toBe(18);
    }
  });
});

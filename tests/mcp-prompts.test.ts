/**
 * Prompt registration without a database: which prompts a server offers is
 * decided by the procedure files that exist, and the repo root is found the
 * same way from src/ (tsx, tests) and dist/ (the built server).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PROMPT_SOURCES, registerPrompts } from '../src/mcp-prompts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALL_TOOLS = new Set(['pending_list', 'pending_resolve']);

type Register = (server: McpServer, tools: Set<string>, root?: string) => void;

async function promptNames(register: Register, root?: string): Promise<string[]> {
  const server = new McpServer({ name: 'prompt-test', version: '0.0.0' });
  register(server, ALL_TOOLS, root);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'prompt-test-client', version: '0.0.0' });
  await client.connect(c);
  try {
    // A server with no prompts registered has no prompts capability at all.
    if (!client.getServerCapabilities()?.prompts) return [];
    return (await client.listPrompts()).prompts.map((p) => p.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('prompt registration', () => {
  it('ships exactly one prompt source, clear_pending, under prompts/', () => {
    expect(PROMPT_SOURCES).toEqual({ clear_pending: 'prompts/clear-pending.md' });
    expect(existsSync(join(REPO, PROMPT_SOURCES.clear_pending))).toBe(true);
  });

  it('a prompt whose file is missing is not registered and does not throw', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mp-prompts-empty-'));
    await expect(promptNames(registerPrompts, empty)).resolves.toEqual([]);
  });

  it('a prompt whose file exists under the given root is registered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-prompts-root-'));
    mkdirSync(join(root, 'prompts'));
    writeFileSync(join(root, PROMPT_SOURCES.clear_pending), '# Clear\n');
    await expect(promptNames(registerPrompts, root)).resolves.toEqual(['clear_pending']);
  });

  it('a prompt whose file disappears after registration fails cleanly, without the absolute path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-prompts-gone-'));
    mkdirSync(join(root, 'prompts'));
    writeFileSync(join(root, PROMPT_SOURCES.clear_pending), '# Clear\n');
    const server = new McpServer({ name: 'prompt-test', version: '0.0.0' });
    registerPrompts(server, ALL_TOOLS, root);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 'prompt-test-client', version: '0.0.0' });
    await client.connect(c);
    try {
      rmSync(join(root, PROMPT_SOURCES.clear_pending));
      const err = await client.getPrompt({ name: 'clear_pending', arguments: {} }).then(
        () => null,
        (e: unknown) => e as { code?: number; message?: string },
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe(-32603); // InternalError
      expect(err!.message).toContain('prompts/clear-pending.md is unreadable (ENOENT)');
      expect(err!.message).not.toContain(root);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('resolves the repo root from both src/ and the built dist/', async () => {
    expect(await promptNames(registerPrompts)).toEqual(['clear_pending']);
    const built = join(REPO, 'dist', 'mcp-prompts.js');
    expect(existsSync(built), 'dist/mcp-prompts.js is missing: run `npm run build` first').toBe(true);
    const dist = (await import(pathToFileURL(built).href)) as { registerPrompts: Register };
    expect(await promptNames(dist.registerPrompts)).toEqual(['clear_pending']);
  });
});

/**
 * MCP prompts: the user-initiated memory workflows, served over the
 * protocol so any MCP client can start them — not only Claude Code, where they
 * also exist as a skill or slash command.
 *
 * Prompts are the user-controlled primitive: a fixed procedure a person
 * decides to start. That is exactly what these are, and exposing them as
 * tools instead would hand the model discretion over whether and when to run
 * them.
 *
 * SINGLE SOURCE OF TRUTH: the procedure text is read from its file under
 * `prompts/` on every `prompts/get`, never copied here. Editing the file
 * changes the prompt with no restart. A prompt whose file is missing is not
 * registered at all (with a stderr warning), so a checkout without it offers
 * fewer prompts instead of one that fails when fetched. To add your own
 * workflow, drop a markdown file under `prompts/` and add it to
 * PROMPT_SOURCES and PROMPTS.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PENDING_CATEGORIES } from './config.js';
import { logEvent, logFailure } from './events.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Prompt name → the file holding its procedure, relative to the repo root. */
export const PROMPT_SOURCES = {
  clear_pending: 'prompts/clear-pending.md',
} as const;

/** Drop a leading `---` YAML frontmatter block; it is Claude Code metadata, not procedure. */
export function stripFrontmatter(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? md.slice(m[0].length) : md).trimStart();
}

async function procedure(name: keyof typeof PROMPT_SOURCES, root: string): Promise<string> {
  const path = resolve(root, PROMPT_SOURCES[name]);
  try {
    return stripFrontmatter(await readFile(path, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    logFailure('prompt', name, err);
    throw new McpError(ErrorCode.InternalError, `prompt ${name}: procedure file ${PROMPT_SOURCES[name]} is unreadable (${code})`);
  }
}

/**
 * One user message: the procedure, then the caller's arguments as an explicit
 * block (only those actually supplied), so the model applies them rather than
 * guessing where they belong in the text.
 */
async function promptResult(
  name: keyof typeof PROMPT_SOURCES,
  description: string,
  args: Record<string, string | undefined>,
  root: string,
): Promise<GetPromptResult> {
  const body = await procedure(name, root);
  // Newlines collapsed so a value cannot add lines of its own to the block.
  const supplied = Object.entries(args)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1].trim() !== '')
    .map(([k, v]) => [k, v.replace(/\s*\r?\n\s*/g, ' ').trim()] as const);
  const argBlock = supplied.length
    ? `\n\n---\nArguments for this run:\n${supplied.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n`
    : '';
  logEvent('prompt_get', null, { prompt: name });
  return {
    description,
    messages: [{ role: 'user', content: { type: 'text', text: body + argBlock } }],
  };
}

/** Prompt metadata. Arguments are optional strings (MCP prompt arguments are strings). */
/**
 * `requires` is the tools the procedure calls. A prompt is registered only when
 * every one of them is — under a narrowed MEMORY_PERSISTOR_TOOLSETS,
 * offering a workflow whose tools are gone would only end in unknown-tool errors.
 */
const PROMPTS: Record<keyof typeof PROMPT_SOURCES, { title: string; description: string; args: Record<string, string>; requires: string[] }> = {
  clear_pending: {
    title: 'Clear the pending queue',
    description: 'Review the open pending queue across all hosts and resolve or archive what is done.',
    args: { category: `Only review one category: ${PENDING_CATEGORIES.join(', ')}` },
    requires: ['pending_list', 'pending_resolve'],
  },
};

/**
 * Every argument here is optional, and the spec lets a client omit
 * `arguments` entirely — but SDK 1.30 parses `request.params.arguments` with
 * the prompt's object schema as-is, so an omitted value fails as InvalidParams
 * ("expected object, received undefined"). Measured, not assumed.
 *
 * Defaulting it to `{}` means wrapping the SDK's `prompts/get` handler, which
 * lives in Protocol's PRIVATE `_requestHandlers` map — the same trade
 * installErrorContract makes for a private method. If a future SDK moves it,
 * this warns and does nothing: prompts still work for clients that send `{}`.
 * tests/integration/mcp-resources-prompts.test.ts ("omits `arguments`") is the
 * alarm for that upgrade.
 */
function defaultPromptArguments(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => unknown> })
    ._requestHandlers;
  const original = handlers?.get('prompts/get');
  if (!handlers || !original) {
    console.error('[memory-persistor] WARNING: cannot reach the SDK prompts/get handler — prompts will require an explicit `arguments: {}`');
    return;
  }
  handlers.set('prompts/get', (req, extra) => {
    const r = req as { params?: { arguments?: unknown } };
    return original({ ...r, params: { ...r.params, arguments: r.params?.arguments ?? {} } }, extra);
  });
}

export function registerPrompts(server: McpServer, tools: Set<string>, root: string = REPO_ROOT): void {
  let registered = 0;
  for (const [name, meta] of Object.entries(PROMPTS) as [keyof typeof PROMPT_SOURCES, (typeof PROMPTS)[keyof typeof PROMPTS]][]) {
    if (!meta.requires.every((t) => tools.has(t))) continue;
    if (!existsSync(resolve(root, PROMPT_SOURCES[name]))) {
      console.error(`[memory-persistor] prompt ${name} not offered: ${PROMPT_SOURCES[name]} is missing`);
      continue;
    }
    registered++;
    const argsSchema = Object.fromEntries(
      Object.entries(meta.args).map(([arg, describe]) => [arg, z.string().optional().describe(describe)]),
    );
    server.registerPrompt(
      name,
      { title: meta.title, description: meta.description, argsSchema },
      async (args: Record<string, string | undefined>) => promptResult(name, meta.description, args, root),
    );
  }
  if (registered > 0) defaultPromptArguments(server);
}

// helpers.js MUST be imported before anything that loads src/db.ts — it points
// DOTENV_CONFIG_PATH's pool at the test database. See helpers.ts:10-23.
import './helpers.js';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer, type CreateServerOptions } from '../../src/mcp-tools.js';

export type Harness = { client: Client; close: () => Promise<void> };

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * A real Client ↔ server pair over the SDK's in-memory transport, so a test
 * exercises registration, SDK input validation and the handler together —
 * the wiring, not just the function.
 */
export async function connectHarness(
  setup?: (server: McpServer) => void,
  options?: CreateServerOptions,
): Promise<Harness> {
  const server = createServer(options);
  setup?.(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-contract-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function resultText(r: ToolResult): string {
  const content = r.content as { type: string; text?: string }[];
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return content[0].text as string;
}

/** Assert a success result and return its parsed JSON body. */
export function parseOk(r: ToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(resultText(r)) as Record<string, unknown>;
}

/** Assert a contract-shaped failure and return its parsed body. */
export function parseErrorResult(r: ToolResult): { error: string; errorCategory: string; isRetryable: boolean } {
  expect(r.isError).toBe(true);
  const body = JSON.parse(resultText(r));
  expect(Object.keys(body).sort()).toEqual(['error', 'errorCategory', 'isRetryable']);
  expect(typeof body.error).toBe('string');
  expect(body.isRetryable).toBe(body.errorCategory === 'transient');
  return body;
}

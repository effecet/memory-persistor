/**
 * installErrorContract's replacement for the SDK's private createToolError
 *. The contract tests reach the -32602 branch through a real client; the
 * other branches — a message from a handler that ESCAPED withErrorContract, the
 * SQL scrub, and a future SDK without the method — can only be reached here,
 * by calling the replaced method directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installErrorContract } from '../src/mcp-tools.js';

type ToolErrorFactory = { createToolError: (message: string) => { isError: boolean; content: { text: string }[] } };

function shaped(message: string): { error: string; errorCategory: string; isRetryable: boolean } {
  const server = new McpServer({ name: 't', version: '0' });
  installErrorContract(server);
  const result = (server as unknown as ToolErrorFactory).createToolError(message);
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0].text);
}

afterEach(() => vi.restoreAllMocks());

describe('installErrorContract', () => {
  it('an SDK invalid-params message (-32602) → validation', () => {
    expect(shaped('MCP error -32602: Tool nope not found').errorCategory).toBe('validation');
  });

  it('anything else reaching the override → internal, not retryable', () => {
    expect(shaped('boom from an unwrapped handler')).toEqual({
      error: 'boom from an unwrapped handler',
      errorCategory: 'internal',
      isRetryable: false,
    });
  });

  it('never echoes a DrizzleQueryError message (full SQL + params)', () => {
    const e = shaped('Failed query: SELECT observations FROM entities\nparams: private memory text');
    expect(e.error).toBe('Database query failed');
    expect(e.errorCategory).toBe('internal');
  });

  it('warns and leaves the server usable when the SDK no longer has the method', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = {} as unknown as McpServer;
    expect(() => installErrorContract(fake)).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('createToolError is gone'));
    expect((fake as unknown as Partial<ToolErrorFactory>).createToolError).toBeUndefined();
  });
});

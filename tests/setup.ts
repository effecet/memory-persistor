/**
 * Vitest setup — runs before any test module is imported.
 *
 * file-sync's CLAUDE_DIR is resolved once, at `src/config.ts` import time,
 * from `process.env.CLAUDE_DIR` (falling back to `$HOME/.claude`). Several
 * file-sync tests write real files under `<CLAUDE_DIR>/projects/...`, so
 * without this the suite would create and delete directories inside the
 * developer's actual Claude Code config — and fail outright wherever that
 * path isn't writable.
 *
 * Pinning it to one per-process temp directory keeps the suite hermetic. It
 * must be set HERE rather than in a test file: by the time a test module runs,
 * `src/config.ts` has already been evaluated and the constant is frozen.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CLAUDE_DIR) {
  process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'memory-persistor-test-'));
}

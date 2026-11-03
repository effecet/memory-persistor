import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Redirects CLAUDE_DIR at a temp dir before src/config.ts is evaluated,
    // so file-sync tests never touch a real Claude Code config directory.
    // See tests/setup.ts.
    setupFiles: ['./tests/setup.ts'],
    // Slow shared CI runners can push millisecond tests past vitest's 5s
    // default; a higher ceiling keeps runner slowness from masquerading as a
    // test failure.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

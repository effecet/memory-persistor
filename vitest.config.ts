import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Redirects CLAUDE_DIR at a temp dir before src/config.ts is evaluated,
    // so file-sync tests never touch a real Claude Code config directory.
    // See tests/setup.ts.
    setupFiles: ['./tests/setup.ts'],
  },
});

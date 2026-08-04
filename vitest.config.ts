import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test file. See tests/setup.ts for why the suite needs it.
    setupFiles: ['./tests/setup.ts'],
  },
});

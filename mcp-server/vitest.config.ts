import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: ['src/**/*.ts'],
      // index.ts is the stdio bootstrap; it is exercised by running the server,
      // not by unit tests, and importing it would connect a transport.
      exclude: ['src/index.ts'],
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests that require a running Redis are tagged with the
    // `integration` describe/test name and skipped by default. Enable with
    // `pnpm test -- --testNamePattern integration` or a dedicated script later.
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/index.ts'],
      thresholds: { statements: 95, lines: 95, functions: 95, branches: 90 },
      reporter: ['text', 'html']
    }
  }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fixtures launch Bash, Git and Python processes. Bound process pressure on macOS;
    // concurrent lifecycle behavior is exercised explicitly inside its regression tests.
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});

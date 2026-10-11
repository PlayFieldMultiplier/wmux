import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.runtime.test.{ts,tsx}',
      'scripts/__tests__/**/*.runtime.test.mjs',
      'integrations/**/__tests__/**/*.runtime.test.{ts,tsx}',
    ],
    environment: 'node',
    fileParallelism: false,
    // Same temp HOME + data suffix as the parallel lane: runtime tests spawn real
    // sessions whose shell integration writes under the wmux data dir.
    setupFiles: ['./src/test-utils/isolateDataDir.ts'],
    // CI only: retry a failed test once, so one flake no longer costs a full
    // rerun. Vitest's github-actions reporter (on by default in Actions) lists
    // every test that passed only on retry in the job summary.
    retry: process.env.CI ? 1 : 0,
  },
});

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/javascript/web',
      reporter: ['text-summary', ['lcov', { projectRoot: '../..' }]],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/__tests__/**', 'src/**/*.test.*', 'src/setupTests.js'],
      all: true,
    },
    environment: 'jsdom',
    fileParallelism: false,
    setupFiles: ['./src/setupTests.js'],
    globals: true,
    testTimeout: 15_000,
  },
})

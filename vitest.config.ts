import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
  resolve: {
    alias: { 'server-only': fileURLToPath(new URL('./test/support/empty.ts', import.meta.url)) },
  },
})

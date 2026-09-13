import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-0123456789abcdef',
      MONGODB_URI: 'mongodb://definido-pelos-testes',
      GOOGLE_CLIENT_ID: 'test-client-id',
      ALLOW_DEV_LOGIN: 'true',
      CRON_SECRET: 'cron-secret-de-teste-123',
    },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
})

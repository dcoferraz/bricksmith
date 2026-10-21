import { defineConfig } from 'vitest/config';

// Dummy NON-fake env. Service tests opt into fake mode per file with
// vi.hoisted(() => { process.env.USE_FAKE_DB = 'true' }) — never globally (it flips the OBO fallback).
export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    env: {
      APP_ENV: 'test',
      DATABRICKS_HOST: 'https://example.cloud.databricks.com',
      DATABRICKS_HTTP_PATH: 'test-warehouse-id',
      DATABRICKS_CATALOG: 'test_catalog',
      DATABRICKS_SCHEMA: 'test_schema',
    },
  },
});

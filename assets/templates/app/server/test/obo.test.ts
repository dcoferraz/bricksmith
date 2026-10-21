import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

// Non-fake env (see vitest.config.ts): no forwarded headers and no fallback.
describe('OBO middleware', () => {
  it('returns 401 MISSING_OBO_TOKEN without forwarded identity', async () => {
    const res = await request(createApp()).get('/api/permissions');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('MISSING_OBO_TOKEN');
  });

  it('serves /healthz without identity', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
  });
});

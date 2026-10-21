import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Opt into fake mode for THIS file only.
vi.hoisted(() => {
  process.env.USE_FAKE_DB = 'true';
});

const { createApp } = await import('../src/app.js');
const { entities } = await import('../src/config.js');
const { resetFakeDb } = await import('../src/db/fakeDb.js');
import type { FieldDef } from '../src/types.js';

function sample(f: FieldDef, n: number): unknown {
  if (f.options && 'values' in f.options) return f.options.values[0];
  switch (f.type) {
    case 'integer':
      return n;
    case 'number':
      return n + 0.5;
    case 'boolean':
      return n % 2 === 0;
    case 'date':
      return `2026-01-${String(10 + n).padStart(2, '0')}`;
    default:
      return `S${n}`.slice(0, f.maxLength ?? 10);
  }
}

const app = createApp();

describe.each(entities.map((e) => [e.name, e] as const))('%s (fake DB)', (_name, e) => {
  const values = (n: number) => Object.fromEntries(e.fields.map((f) => [f.name, sample(f, n)]));
  const dataField = e.fields.find((f) => !e.key.includes(f.name) && !f.options && f.type !== 'boolean');

  beforeEach(() => {
    resetFakeDb();
    process.env.FAKE_GRANTS = 'all';
  });

  it('creates, lists, no-op updates, updates, and logically deletes', async () => {
    const created = await request(app).post(`/api/entities/${e.name}`).send(values(1));
    expect(created.status).toBe(201);
    const uid = created.body.row.row_uid;

    const dup = await request(app).post(`/api/entities/${e.name}`).send(values(1));
    expect(dup.status).toBe(409);

    const list = await request(app).get(`/api/entities/${e.name}`);
    expect(list.body.total).toBe(1);
    expect(list.body.permissions.canCreate).toBe(true);

    const same = await request(app).put(`/api/entities/${e.name}/${uid}`).send(values(1));
    expect(same.body.changed).toBe(false);

    if (dataField) {
      const changed = await request(app).put(`/api/entities/${e.name}/${uid}`).send({ ...values(1), [dataField.name]: sample(dataField, 2) });
      expect(changed.body.changed).toBe(true);
      const after = await request(app).get(`/api/entities/${e.name}`);
      expect(after.body.total).toBe(1); // still one CURRENT row
    }

    const del = await request(app).delete(`/api/entities/${e.name}/${uid}`);
    expect(del.status).toBe(200);
    const empty = await request(app).get(`/api/entities/${e.name}`);
    expect(empty.body.total).toBe(0);
  });

  it('read-only users get 403 PERMISSION_CHANGED on writes and view-only permissions', async () => {
    process.env.FAKE_GRANTS = 'read';
    const res = await request(app).post(`/api/entities/${e.name}`).send(values(1));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PERMISSION_CHANGED');
    const list = await request(app).get(`/api/entities/${e.name}`);
    expect(list.body.permissions).toMatchObject({ canRead: true, canCreate: false, canUpdate: false, canDelete: false });
  });

  it('rejects invalid payloads with VALIDATION', async () => {
    const res = await request(app).post(`/api/entities/${e.name}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

// In-memory, bi-temporal-aware fake. TEST HARNESS ONLY — config.ts refuses USE_FAKE_DB elsewhere.
// It never validates authorization, scopes, warehouse binding, or UC grants: use live e2e for those.
import { createHash } from 'node:crypto';
import type { EntityDef, Row } from '../types.js';
import { dataFields, keyFields } from './sql.js';
import type { Db, Store, UcPermissions } from './userClient.js';

interface Version {
  row_uid: string;
  checksum: string;
  values: Record<string, unknown>;
  is_current: boolean;
  created_by: string;
  updated_by: string;
  system_start_ts: Date;
}

const tables = new Map<string, Version[]>();
const tableOf = (e: EntityDef) => tables.get(e.name) ?? tables.set(e.name, []).get(e.name)!;
const hash = (algo: string, parts: unknown[]) =>
  createHash(algo).update(parts.map((p) => (p === null || p === undefined ? '#NULL#' : String(p))).join('|')).digest('hex');
const current = (e: EntityDef) => tableOf(e).filter((v) => v.is_current);

function toRow(e: EntityDef, v: Version): Row {
  const ts = v.system_start_ts.toISOString();
  return {
    row_uid: v.row_uid,
    ...Object.fromEntries(e.fields.map((f) => [f.name, v.values[f.name] ?? null])),
    updated_by: v.updated_by,
    updated_at: `${ts.slice(0, 10)} ${ts.slice(11, 16)}`,
  };
}

/** FAKE_GRANTS picks a permission scenario: all (default) | read | none. */
function fakeGrants(): UcPermissions {
  switch (process.env.FAKE_GRANTS ?? 'all') {
    case 'none':
      return { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
    case 'read':
      return { canRead: true, canCreate: false, canUpdate: false, canDelete: false };
    default:
      return { canRead: true, canCreate: true, canUpdate: true, canDelete: true };
  }
}

export function resetFakeDb(): void {
  tables.clear();
}

function createFakeDb(email: string): Db {
  return {
    async list(e, query) {
      const needle = query.search?.trim().toLowerCase();
      let rows = current(e).filter(
        (v) => !needle || e.fields.some((f) => String(v.values[f.name] ?? '').toLowerCase().includes(needle)),
      );
      const sortField = e.fields.find((f) => f.name === query.sort)?.name;
      const sign = query.dir === 'asc' ? 1 : -1;
      rows = rows.sort((a, b) => {
        const av = sortField ? a.values[sortField] : a.system_start_ts.getTime();
        const bv = sortField ? b.values[sortField] : b.system_start_ts.getTime();
        return av === bv ? 0 : (av as number) > (bv as number) ? sign : -sign;
      });
      const start = (query.page - 1) * query.pageSize;
      return { rows: rows.slice(start, start + query.pageSize).map((v) => toRow(e, v)), total: rows.length };
    },

    async get(e, rowUid) {
      const v = current(e).find((x) => x.row_uid === rowUid);
      return v ? toRow(e, v) : null;
    },

    async create(e, values) {
      const rowUid = hash('md5', keyFields(e).map((f) => values[f.name]));
      if (current(e).some((v) => v.row_uid === rowUid)) return null;
      const v: Version = {
        row_uid: rowUid,
        checksum: hash('sha1', dataFields(e).map((f) => values[f.name])),
        values: Object.fromEntries(e.fields.map((f) => [f.name, values[f.name] ?? null])),
        is_current: true,
        created_by: email,
        updated_by: email,
        system_start_ts: new Date(),
      };
      tableOf(e).push(v);
      return toRow(e, v);
    },

    async update(e, rowUid, values) {
      const cur = current(e).find((v) => v.row_uid === rowUid);
      if (!cur) return null;
      const checksum = hash('sha1', dataFields(e).map((f) => values[f.name]));
      if (checksum === cur.checksum) return { row: toRow(e, cur), changed: false };
      cur.is_current = false; // expire + insert, like the MERGE
      const next: Version = {
        ...cur,
        checksum,
        values: { ...cur.values, ...Object.fromEntries(dataFields(e).map((f) => [f.name, values[f.name] ?? null])) },
        is_current: true,
        updated_by: email,
        system_start_ts: new Date(Math.max(Date.now(), cur.system_start_ts.getTime() + 1)),
      };
      tableOf(e).push(next);
      return { row: toRow(e, next), changed: true };
    },

    async remove(e, rowUid) {
      const cur = current(e).find((v) => v.row_uid === rowUid);
      if (!cur) return false;
      cur.is_current = false;
      cur.updated_by = email;
      return true;
    },

    async options(e, fieldName) {
      const field = e.fields.find((f) => f.name === fieldName);
      if (!field?.options) return [];
      if ('values' in field.options) return field.options.values.map((v) => ({ value: v, label: v }));
      return [
        { value: 'SAMPLE_A', label: 'Sample A' },
        { value: 'SAMPLE_B', label: 'Sample B' },
      ];
    },

    async tablePermissions() {
      return fakeGrants();
    },

    async groupMembership(groups) {
      const mine = (process.env.FAKE_GROUPS ?? '').split(',').map((g) => g.trim());
      return Object.fromEntries(groups.map((g) => [g, mine.includes(g)]));
    },
  };
}

export const fakeStore: Store = {
  run: (ctx, _label, fn) => fn(createFakeDb(ctx.email)),
};

// Databricks SQL implementation of the Db facade. Every statement runs as the calling user.
import { config, lookupTableName, tableName } from '../config.js';
import type { EntityDef, Row } from '../types.js';
import { appendVersion, expireVersion, insertFirstVersion } from './bitemporal.js';
import { withUserSql, type Exec } from './databricksClient.js';
import { buildGet, buildGetByKey, buildGroupMembership, buildList, buildOptions, fieldParams, keyFields } from './sql.js';
import type { Db, Option, Store, UcPermissions } from './userClient.js';

const NONE: UcPermissions = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
const ALL: UcPermissions = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

const col = (r: Row, name: string) => String(r[name] ?? r[name.toLowerCase()] ?? '');

function fromPrivileges(privileges: Set<string>): UcPermissions {
  if (privileges.has('ALL PRIVILEGES') || privileges.has('OWN')) return ALL;
  const write = privileges.has('MODIFY'); // MODIFY implies all three writes
  return { canRead: privileges.has('SELECT') || write, canCreate: write, canUpdate: write, canDelete: write };
}

function createDb(exec: Exec, email: string): Db {
  const me = email.toLowerCase();

  const db: Db = {
    async list(e, query) {
      const table = tableName(e);
      const { sql, countSql, params } = buildList(e, table, query);
      const rows = await exec(sql, params, `${e.name}.list`);
      const [count] = await exec(countSql, params, `${e.name}.count`);
      return { rows, total: Number(count?.total ?? rows.length) };
    },

    async get(e, rowUid) {
      const [row] = await exec(buildGet(e, tableName(e)), { row_uid: rowUid }, `${e.name}.get`);
      return row ?? null;
    },

    async create(e, values) {
      const table = tableName(e);
      const { inserted } = await insertFirstVersion(exec, email, e, table, values);
      if (inserted === 0) return null;
      const [row] = await exec(buildGetByKey(e, table), fieldParams(keyFields(e), values), `${e.name}.getByKey`);
      return row ?? null;
    },

    async update(e, rowUid, values) {
      const table = tableName(e);
      const { inserted } = await appendVersion(exec, email, e, table, rowUid, values);
      const row = await db.get(e, rowUid);
      return row ? { row, changed: inserted > 0 } : null;
    },

    async remove(e, rowUid) {
      const { affected, updated } = await expireVersion(exec, email, e, tableName(e), rowUid);
      return Math.max(affected, updated) > 0;
    },

    async options(e, fieldName) {
      const field = e.fields.find((f) => f.name === fieldName);
      if (!field?.options) return [];
      if ('values' in field.options) return field.options.values.map((v) => ({ value: v, label: v }));
      const { table, valueColumn, labelColumn, currentOnly } = field.options.lookup;
      const rows = await exec(buildOptions(lookupTableName(table), valueColumn, labelColumn, currentOnly), {}, `${e.name}.options.${fieldName}`);
      return rows.map((r): Option => ({ value: col(r, 'value'), label: col(r, 'label') }));
    },

    async tablePermissions(e) {
      const table = tableName(e);
      let grants: Row[];
      try {
        grants = await exec(`SHOW GRANTS ON TABLE ${table}`, {}, `${e.name}.grants`);
      } catch {
        // Some principals cannot list grants. Fall back to a read probe; UC still enforces writes.
        return (await canSelect(table)) ? { ...NONE, canRead: true } : NONE;
      }
      const principals = [...new Set(grants.map((g) => col(g, 'Principal')))];
      const groups = principals.filter((p) => p && !p.includes('@') && p.toLowerCase() !== 'account users');
      const member = await db.groupMembership(groups);
      const applies = (p: string) => p.toLowerCase() === me || p.toLowerCase() === 'account users' || member[p];
      const privileges = new Set(
        grants.filter((g) => applies(col(g, 'Principal'))).map((g) => col(g, 'ActionType').toUpperCase()),
      );
      const result = fromPrivileges(privileges);
      if (!result.canRead && (await isOwner(table, member))) return ALL;
      return result;
    },

    async groupMembership(groups) {
      if (!groups.length) return {};
      const { sql, params } = buildGroupMembership(groups);
      const [row] = await exec(sql, params, 'access.groupMembership');
      return Object.fromEntries(groups.map((g, i) => [g, row?.[`g${i}`] === true]));
    },
  };

  async function canSelect(table: string): Promise<boolean> {
    try {
      await exec(`SELECT 1 FROM ${table} LIMIT 0`, {}, 'permissions.probe');
      return true;
    } catch {
      return false;
    }
  }

  async function isOwner(table: string, member: Record<string, boolean>): Promise<boolean> {
    try {
      const rows = await exec(`DESCRIBE TABLE EXTENDED ${table}`, {}, 'permissions.owner');
      const owner = rows.find((r) => col(r, 'col_name') === 'Owner');
      const name = owner ? col(owner, 'data_type') : '';
      if (!name) return false;
      if (name.toLowerCase() === me) return true;
      return member[name] ?? (await db.groupMembership([name]))[name] ?? false;
    } catch {
      return false;
    }
  }

  return db;
}

export const sqlStore: Store = {
  run(ctx, label, fn) {
    if (!config.host || !config.httpPath) throw new Error('Databricks connection is not configured');
    return withUserSql(ctx, label, (exec) => fn(createDb(exec, ctx.email)));
  },
};

import { getStore } from '../db/userClient.js';
import { AppError, type EntityDef, type ListQuery, type UserSqlContext } from '../types.js';
import { discoverPermissions, requireCap } from './permissions.js';

// Every data response carries fresh permissions so the UI re-hides affordances without polling.
// Every call below is ONE OBO session (permission check + statement share it).

export async function listEntity(ctx: UserSqlContext, e: EntityDef, query: ListQuery) {
  const store = await getStore();
  return store.run(ctx, `${e.name}.list`, async (db) => {
    const permissions = await discoverPermissions(db, ctx, e);
    if (!permissions.canRead) return { rows: [], total: 0, page: query.page, pageSize: query.pageSize, permissions };
    const { rows, total } = await db.list(e, query);
    return { rows, total, page: query.page, pageSize: query.pageSize, permissions };
  });
}

export async function getEntityRow(ctx: UserSqlContext, e: EntityDef, rowUid: string) {
  const store = await getStore();
  return store.run(ctx, `${e.name}.get`, async (db) => {
    const permissions = await discoverPermissions(db, ctx, e);
    const row = await db.get(e, rowUid);
    if (!row) throw new AppError('NOT_FOUND', 404, `${e.label}: record not found`);
    return { row, permissions };
  });
}

export async function createEntityRow(ctx: UserSqlContext, e: EntityDef, values: Record<string, unknown>) {
  const store = await getStore();
  return store.run(ctx, `${e.name}.create`, async (db) => {
    const permissions = await requireCap(db, ctx, e, 'canCreate');
    const row = await db.create(e, values);
    if (!row) throw new AppError('CONFLICT', 409, `${e.label}: a record with this key already exists`);
    return { row, permissions };
  });
}

export async function updateEntityRow(ctx: UserSqlContext, e: EntityDef, rowUid: string, values: Record<string, unknown>) {
  const store = await getStore();
  return store.run(ctx, `${e.name}.update`, async (db) => {
    const permissions = await requireCap(db, ctx, e, 'canUpdate');
    const result = await db.update(e, rowUid, values);
    if (!result) throw new AppError('NOT_FOUND', 404, `${e.label}: record not found`);
    return { ...result, permissions };
  });
}

export async function deleteEntityRow(ctx: UserSqlContext, e: EntityDef, rowUid: string) {
  const store = await getStore();
  return store.run(ctx, `${e.name}.delete`, async (db) => {
    const permissions = await requireCap(db, ctx, e, 'canDelete');
    if (!(await db.remove(e, rowUid))) throw new AppError('NOT_FOUND', 404, `${e.label}: record not found`);
    return { ok: true, permissions };
  });
}

export async function entityOptions(ctx: UserSqlContext, e: EntityDef, field: string) {
  if (!e.fields.some((f) => f.name === field && f.options)) {
    throw new AppError('NOT_FOUND', 404, `${e.label}: field ${field} has no options`);
  }
  const store = await getStore();
  return store.run(ctx, `${e.name}.options`, async (db) => ({ options: await db.options(e, field) }));
}

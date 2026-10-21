import { entities } from '../config.js';
import type { Db } from '../db/userClient.js';
import { AppError, type Capability, type EntityDef, type TablePermissions, type UserSqlContext } from '../types.js';
import { canWrite } from './access.js';

/** UC grants, narrowed by the write group. Write caps survive only if BOTH allow them. */
export async function discoverPermissions(db: Db, ctx: UserSqlContext, e: EntityDef): Promise<TablePermissions> {
  const uc = await db.tablePermissions(e);
  const anyWrite = uc.canCreate || uc.canUpdate || uc.canDelete;
  const write = anyWrite ? await canWrite(db, ctx) : false;
  return {
    canRead: uc.canRead,
    canCreate: uc.canCreate && write,
    canUpdate: uc.canUpdate && write,
    canDelete: uc.canDelete && write,
    checkedAt: new Date().toISOString(),
  };
}

export async function discoverAll(db: Db, ctx: UserSqlContext): Promise<Record<string, TablePermissions>> {
  const out: Record<string, TablePermissions> = {};
  for (const e of entities) out[e.name] = await discoverPermissions(db, ctx, e); // sequential: one session
  return out;
}

/**
 * Re-check a capability before a mutation, inside the mutation's own session.
 * UI hiding is manners; this is the fast server answer; Unity Catalog stays the authority.
 */
export async function requireCap(db: Db, ctx: UserSqlContext, e: EntityDef, cap: Capability): Promise<TablePermissions> {
  const permissions = await discoverPermissions(db, ctx, e);
  if (!permissions[cap]) {
    throw new AppError('PERMISSION_CHANGED', 403, 'Your access changed. This action is no longer allowed.', { permissions });
  }
  return permissions;
}

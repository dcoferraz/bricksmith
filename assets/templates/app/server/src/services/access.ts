// Group entitlement gates on top of Unity Catalog. Uses is_account_group_member() under the user's
// token — NOT workspace SCIM /Me, which omits account-level groups synced via identity federation.
import { config } from '../config.js';
import type { Db } from '../db/userClient.js';
import type { UserSqlContext } from '../types.js';

const TTL_MS = 60_000;
const cache = new Map<string, { member: boolean; at: number }>();

export async function isMember(db: Db, ctx: UserSqlContext, groups: string[]): Promise<Record<string, boolean>> {
  const now = Date.now();
  const result: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const g of groups) {
    const hit = cache.get(`${ctx.email.toLowerCase()}|${g}`);
    if (hit && now - hit.at < TTL_MS) result[g] = hit.member;
    else missing.push(g);
  }
  if (missing.length) {
    const fresh = await db.groupMembership(missing);
    for (const g of missing) {
      result[g] = fresh[g] ?? false;
      cache.set(`${ctx.email.toLowerCase()}|${g}`, { member: result[g], at: now });
    }
  }
  return result;
}

/** Read gate: "may use the app". Admits the write group too, or write-only members get locked out. */
export async function canUseApp(db: Db, ctx: UserSqlContext): Promise<boolean> {
  if (!config.groupGateEnabled) return true;
  const groups = [config.readGroup, config.writeGroup].filter((g): g is string => Boolean(g));
  try {
    const member = await isMember(db, ctx, groups);
    return groups.some((g) => member[g]);
  } catch (err) {
    console.warn('[access] group lookup failed', err instanceof Error ? err.message : err);
    return config.groupGateFailOpen;
  }
}

/** Write gate: "may mutate". Applied inside discoverPermissions so UI and server share one answer. */
export async function canWrite(db: Db, ctx: UserSqlContext): Promise<boolean> {
  if (!config.groupGateEnabled || !config.writeGroup) return true;
  try {
    return (await isMember(db, ctx, [config.writeGroup]))[config.writeGroup];
  } catch (err) {
    console.warn('[access] write-group lookup failed', err instanceof Error ? err.message : err);
    return config.groupGateFailOpen;
  }
}

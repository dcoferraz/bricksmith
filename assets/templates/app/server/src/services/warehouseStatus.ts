import { config } from '../config.js';
import type { UserSqlContext } from '../types.js';

export type WarehouseState = 'RUNNING' | 'STARTING' | 'STOPPING' | 'STOPPED' | 'DELETING' | 'DELETED' | 'UNKNOWN';

/** Reads warehouse state with the user's token (CAN_USE can read it). 5 s timeout. Never throws. */
export async function getWarehouseStatus(ctx: UserSqlContext): Promise<{ state: WarehouseState; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  const forced = process.env.FORCE_WAREHOUSE_STATE; // local-only hook for testing the banner
  if (forced && (config.isLocal || config.isTestHarness)) return { state: forced as WarehouseState, checkedAt };
  if (config.useFakeDb || !config.host || !config.warehouseId) return { state: 'UNKNOWN', checkedAt };
  try {
    const res = await fetch(`https://${config.host}/api/2.0/sql/warehouses/${encodeURIComponent(config.warehouseId)}`, {
      headers: { Authorization: `Bearer ${ctx.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { state: 'UNKNOWN', checkedAt };
    const body = (await res.json()) as { state?: string };
    return { state: (body.state as WarehouseState) ?? 'UNKNOWN', checkedAt };
  } catch {
    return { state: 'UNKNOWN', checkedAt };
  }
}

// The ONE place that writes entity tables: audit columns, hashing, atomic expire+insert, Delta retry.
import { config } from '../config.js';
import type { EntityDef, SqlParams } from '../types.js';
import type { Exec } from './databricksClient.js';
import { buildCreate, buildDelete, buildUpdate, dataFields, fieldParams } from './sql.js';

const DELTA_CONFLICT = /ConcurrentAppendException|ConcurrentModificationException|ConcurrentDeleteReadException|DELTA_CONCURRENT/i;
const CONFLICT_BACKOFF_MS = [200, 500, 1200];

interface DmlCounts {
  inserted: number;
  updated: number;
  affected: number;
}

function counts(rows: Record<string, unknown>[]): DmlCounts {
  const r = rows[0] ?? {};
  return {
    inserted: Number(r.num_inserted_rows ?? 0),
    updated: Number(r.num_updated_rows ?? 0),
    affected: Number(r.num_affected_rows ?? 0),
  };
}

/** A failed Delta commit wrote nothing, so retrying optimistic-concurrency conflicts is safe. */
async function runDml(exec: Exec, sql: string, params: SqlParams, label: string): Promise<DmlCounts> {
  for (let attempt = 0; ; attempt++) {
    try {
      return counts(await exec(sql, params, label));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!DELTA_CONFLICT.test(msg) || attempt >= CONFLICT_BACKOFF_MS.length) throw err;
      await new Promise((r) => setTimeout(r, CONFLICT_BACKOFF_MS[attempt]));
    }
  }
}

const auditParams = (user: string): SqlParams => ({
  app_user: user,
  process_id: config.processId,
  source_system: config.sourceSystem,
});

export async function insertFirstVersion(exec: Exec, user: string, e: EntityDef, table: string, values: Record<string, unknown>) {
  const params = { ...fieldParams(e.fields, values), ...auditParams(user) };
  return runDml(exec, buildCreate(e, table), params, `${e.name}.create`);
}

export async function appendVersion(exec: Exec, user: string, e: EntityDef, table: string, rowUid: string, values: Record<string, unknown>) {
  const params = { ...fieldParams(dataFields(e), values), ...auditParams(user), row_uid: rowUid };
  return runDml(exec, buildUpdate(e, table), params, `${e.name}.update`);
}

export async function expireVersion(exec: Exec, user: string, e: EntityDef, table: string, rowUid: string) {
  const { app_user, process_id } = auditParams(user);
  return runDml(exec, buildDelete(table), { app_user, process_id, row_uid: rowUid }, `${e.name}.delete`);
}

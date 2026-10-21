// Pure SQL builders. Values are always bound as named parameters; identifiers are validated + quoted.
import { q } from '../identifiers.js';
import type { EntityDef, FieldDef, FieldType, ListQuery, SqlParams } from '../types.js';

export const OPEN_END_DATE = "DATE'9999-12-31'";
export const OPEN_END_TS = "TIMESTAMP'9999-12-31 00:00:00'";
const NULL_MARKER = "'#NULL#'"; // concat_ws skips NULLs; without a marker ('a',NULL) == (NULL,'a')

const SQL_TYPE: Record<FieldType, string> = {
  string: 'STRING',
  text: 'STRING',
  integer: 'INT', // INT, not BIGINT: BIGINT can come back as bigint, which JSON cannot serialize
  number: 'DOUBLE',
  boolean: 'BOOLEAN',
  date: 'DATE',
};

export const sqlType = (f: FieldDef): string => SQL_TYPE[f.type];
export const paramName = (f: FieldDef): string => `p_${f.name}`;
const typedParam = (f: FieldDef): string => `CAST(:${paramName(f)} AS ${sqlType(f)})`;
const hashPart = (expr: string): string => `coalesce(CAST(${expr} AS STRING), ${NULL_MARKER})`;

export const keyFields = (e: EntityDef): FieldDef[] => e.key.map((k) => e.fields.find((f) => f.name === k)!);
export const dataFields = (e: EntityDef): FieldDef[] => e.fields.filter((f) => !e.key.includes(f.name));

/** Stable across versions. Same expression must be used by backfills and dbt. */
export function rowUidExpr(exprs: string[]): string {
  return `md5(concat_ws('|', ${exprs.map(hashPart).join(', ')}))`;
}

/** Equal checksum ⇒ update is a no-op. */
export function checksumExpr(exprs: string[]): string {
  return exprs.length ? `sha1(concat_ws('|', ${exprs.map(hashPart).join(', ')}))` : "sha1('')";
}

function selectField(f: FieldDef, alias = ''): string {
  const col = `${alias}${q(f.name)}`;
  return f.type === 'date' ? `date_format(${col}, 'yyyy-MM-dd') AS ${q(f.name)}` : `${col} AS ${q(f.name)}`;
}

export function selectList(e: EntityDef): string {
  return [
    'row_uid',
    ...e.fields.map((f) => selectField(f)),
    'updated_by',
    "date_format(system_start_ts, 'yyyy-MM-dd HH:mm') AS updated_at",
  ].join(', ');
}

/** `!` as the LIKE escape: backslash escapes parse differently across warehouses. */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (c) => `!${c}`);
}

export function buildList(e: EntityDef, table: string, query: ListQuery) {
  const params: SqlParams = {};
  const where = ['is_current = true'];
  const search = query.search?.trim();
  if (search) {
    params.search = `%${escapeLike(search.toLowerCase())}%`;
    const preds = e.fields.map((f) => `lower(CAST(${q(f.name)} AS STRING)) LIKE :search ESCAPE '!'`);
    where.push(`(${preds.join(' OR ')})`);
  }
  const sortField = e.fields.find((f) => f.name === query.sort);
  const orderBy = sortField ? q(sortField.name) : 'system_start_ts';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  // Integers are validated/clamped by the route; inlining them avoids parameter-marker support gaps in LIMIT.
  const limit = Math.trunc(query.pageSize);
  const offset = Math.trunc((query.page - 1) * query.pageSize);
  const whereSql = where.join(' AND ');
  return {
    sql: `SELECT ${selectList(e)} FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy} ${dir}, row_uid LIMIT ${limit} OFFSET ${offset}`,
    countSql: `SELECT CAST(count(*) AS INT) AS total FROM ${table} WHERE ${whereSql}`,
    params,
  };
}

export function buildGet(e: EntityDef, table: string): string {
  return `SELECT ${selectList(e)} FROM ${table} WHERE row_uid = :row_uid AND is_current = true`;
}

export function buildGetByKey(e: EntityDef, table: string): string {
  const uid = rowUidExpr(keyFields(e).map(typedParam));
  return `SELECT ${selectList(e)} FROM ${table} WHERE row_uid = ${uid} AND is_current = true`;
}

const AUDIT_INSERT_COLS = [
  'business_start_date', 'business_end_date', 'system_start_ts', 'system_end_ts',
  'is_current', 'process_id', 'source_system_cd', 'created_by', 'updated_by',
];

function insertClause(e: EntityDef, createdByExpr: string): string {
  const cols = ['row_uid', 'row_checksum', ...e.fields.map((f) => q(f.name)), ...AUDIT_INSERT_COLS];
  const checksum = checksumExpr(dataFields(e).map((f) => `src.${q(f.name)}`));
  const values = [
    'src.row_uid',
    checksum,
    ...e.fields.map((f) => `src.${q(f.name)}`),
    'current_date()', OPEN_END_DATE, 'current_timestamp()', OPEN_END_TS,
    'true', ':process_id', ':source_system', createdByExpr, ':app_user',
  ];
  return `INSERT (${cols.join(', ')}) VALUES (${values.join(', ')})`;
}

/** Insert the first version; no-op (0 inserted) when a current row with the same key exists. */
export function buildCreate(e: EntityDef, table: string): string {
  const uid = rowUidExpr(keyFields(e).map(typedParam));
  const srcCols = [`${uid} AS row_uid`, ...e.fields.map((f) => `${typedParam(f)} AS ${q(f.name)}`)];
  return [
    `MERGE INTO ${table} AS tgt`,
    `USING (SELECT ${srcCols.join(', ')}) AS src`,
    'ON tgt.row_uid = src.row_uid AND tgt.is_current = true',
    `WHEN NOT MATCHED THEN ${insertClause(e, ':app_user')}`,
  ].join('\n');
}

/**
 * Atomic expire + insert. The source is derived from the current row itself, so nothing is inserted
 * when the row is missing or the checksum is unchanged. Keys are immutable (taken from the current row).
 */
export function buildUpdate(e: EntityDef, table: string): string {
  const srcCols = [
    'cur.row_uid AS row_uid',
    'cur.created_by AS created_by',
    ...keyFields(e).map((f) => `cur.${q(f.name)} AS ${q(f.name)}`),
    ...dataFields(e).map((f) => `${typedParam(f)} AS ${q(f.name)}`),
  ].join(', ');
  const changed = checksumExpr(dataFields(e).map(typedParam));
  const cur = `FROM ${table} AS cur WHERE cur.row_uid = :row_uid AND cur.is_current = true AND cur.row_checksum <> ${changed}`;
  return [
    `MERGE INTO ${table} AS tgt`,
    'USING (',
    `  SELECT cur.row_uid AS merge_key, ${srcCols} ${cur}`,
    '  UNION ALL',
    `  SELECT CAST(NULL AS STRING) AS merge_key, ${srcCols} ${cur}`,
    ') AS src',
    'ON tgt.row_uid = src.merge_key AND tgt.is_current = true',
    'WHEN MATCHED THEN UPDATE SET is_current = false, system_end_ts = current_timestamp(), business_end_date = current_date()',
    `WHEN NOT MATCHED THEN ${insertClause(e, 'src.created_by')}`,
  ].join('\n');
}

/** Logical delete: expire the current version, insert nothing. */
export function buildDelete(table: string): string {
  return [
    `UPDATE ${table}`,
    'SET is_current = false, system_end_ts = current_timestamp(), business_end_date = current_date(),',
    '    updated_by = :app_user, process_id = :process_id',
    'WHERE row_uid = :row_uid AND is_current = true',
  ].join('\n');
}

export function fieldParams(fields: FieldDef[], values: Record<string, unknown>): SqlParams {
  const params: SqlParams = {};
  for (const f of fields) {
    const v = values[f.name];
    params[paramName(f)] = v === undefined || v === '' ? null : (v as string | number | boolean | null);
  }
  return params;
}

export function buildOptions(table: string, valueColumn: string, labelColumn: string, currentOnly?: boolean): string {
  const where = currentOnly ? ' WHERE is_current = true' : '';
  return `SELECT DISTINCT CAST(${q(valueColumn)} AS STRING) AS value, CAST(${q(labelColumn)} AS STRING) AS label FROM ${table}${where} ORDER BY label LIMIT 1000`;
}

export function buildGroupMembership(groups: string[]): { sql: string; params: SqlParams } {
  const params: SqlParams = {};
  const cols = groups.map((g, i) => {
    params[`g${i}`] = g;
    return `is_account_group_member(:g${i}) AS g${i}`;
  });
  return { sql: `SELECT ${cols.join(', ')}`, params };
}

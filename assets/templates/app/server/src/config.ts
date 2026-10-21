import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertIdentifier,
  normalizeHost,
  normalizeHttpPath,
  qualified,
  warehouseIdFromPath,
} from './identifiers.js';
import type { EntityDef, FieldType } from './types.js';

const env = process.env;
const deployed = Boolean(env.DATABRICKS_APP_PORT); // set by the Databricks Apps platform only
const isTestHarness = Boolean(env.VITEST) || env.NODE_ENV === 'test' || env.E2E === 'true';

// Local convenience: load server/.env (written by the setup step). Never used when deployed or under tests.
if (!deployed && !isTestHarness) loadDotEnv(path.resolve(process.cwd(), 'server/.env'));

const appEnv = env.APP_ENV ?? (deployed ? 'dev' : 'local');
const isLocal = appEnv === 'local' && !deployed;
const useFakeDb = env.USE_FAKE_DB === 'true';

// Mock mode is a test fixture, not a run mode.
if (useFakeDb && !isTestHarness) {
  throw new Error('USE_FAKE_DB=true is only allowed under the test harness (VITEST, NODE_ENV=test, E2E=true).');
}

const httpPath = normalizeHttpPath(env.DATABRICKS_HTTP_PATH);
const host = normalizeHost(env.DATABRICKS_HOST);

if (!useFakeDb) {
  if (!httpPath) throw new Error('Missing required environment variable: DATABRICKS_HTTP_PATH');
  if (!host) throw new Error('Missing required environment variable: DATABRICKS_HOST');
}

const localToken = env.DATABRICKS_TOKEN?.trim();
if (isLocal && !useFakeDb && (!localToken || /^<|changeme|placeholder|x{6,}/i.test(localToken))) {
  throw new Error('APP_ENV=local needs a real personal access token in DATABRICKS_TOKEN (server/.env). Refusing to start.');
}

const catalog = assertIdentifier(env.DATABRICKS_CATALOG ?? '{{DEFAULT_CATALOG}}', 'catalog');
const schema = assertIdentifier(env.DATABRICKS_SCHEMA ?? '{{DEFAULT_SCHEMA}}', 'schema');
const readGroup = env.APP_READ_GROUP?.trim() || undefined;
const writeGroup = env.APP_WRITE_GROUP?.trim() || undefined;
const groupGateMode = (env.GROUP_GATE ?? 'auto') as 'auto' | 'force' | 'off';

export const config = {
  appEnv,
  deployEnv: env.DEPLOY_ENV ?? appEnv,
  deployed,
  isLocal,
  isTestHarness,
  useFakeDb,
  host,
  httpPath,
  warehouseId: warehouseIdFromPath(httpPath),
  catalog,
  schema,
  localToken: isLocal || useFakeDb ? localToken : undefined,
  devUserEmail: env.DEV_USER_EMAIL ?? 'dev.user@example.com',
  readGroup,
  writeGroup,
  // Gate only applies on the OBO path unless forced (local/fake have no real identity).
  groupGateEnabled:
    groupGateMode !== 'off' &&
    Boolean(readGroup || writeGroup) &&
    (groupGateMode === 'force' || (!isLocal && !useFakeDb)),
  // Deliberate choice: UC still gates data either way. Default fail-closed.
  groupGateFailOpen: env.GROUP_GATE_FAIL_OPEN === 'true',
  warmSessionCache: env.WARM_SESSION_CACHE === 'true',
  warmSessionTtlMs: Number(env.WARM_SESSION_TTL_MS ?? 60_000),
  sqlTiming: env.SQL_TIMING === 'true',
  processId: env.PROCESS_ID ?? '{{APP_NAME}}-app',
  sourceSystem: env.SOURCE_SYSTEM_CD ?? '{{APP_NAME}}',
  port: Number(env.DATABRICKS_APP_PORT ?? env.PORT ?? 8000),
};

const FIELD_TYPES: FieldType[] = ['string', 'text', 'integer', 'number', 'boolean', 'date'];
const RESERVED = new Set([
  'row_uid', 'row_checksum', 'business_start_date', 'business_end_date', 'system_start_ts',
  'system_end_ts', 'is_current', 'process_id', 'source_system_cd', 'created_by', 'updated_by', 'updated_at',
]);

function loadEntities(): EntityDef[] {
  const file = path.resolve(process.cwd(), env.ENTITIES_FILE ?? 'shared/entities.json');
  const list = JSON.parse(readFileSync(file, 'utf8')) as EntityDef[];
  for (const e of list) {
    assertIdentifier(e.name, 'entity');
    assertIdentifier(e.table, 'table');
    if (!e.key.length) throw new Error(`Entity ${e.name} needs at least one key field`);
    for (const f of e.fields) {
      assertIdentifier(f.name, 'field');
      if (RESERVED.has(f.name)) throw new Error(`Field ${e.name}.${f.name} uses a reserved audit column name`);
      if (!FIELD_TYPES.includes(f.type)) throw new Error(`Field ${e.name}.${f.name} has unknown type ${f.type}`);
      if (f.options && 'lookup' in f.options) {
        f.options.lookup.table.split('.').forEach((p) => assertIdentifier(p, 'lookup table'));
        assertIdentifier(f.options.lookup.valueColumn, 'lookup column');
        assertIdentifier(f.options.lookup.labelColumn, 'lookup column');
      }
    }
    for (const k of e.key) if (!e.fields.some((f) => f.name === k)) throw new Error(`Key ${e.name}.${k} is not a field`);
  }
  return list;
}

export const entities: EntityDef[] = loadEntities();

export function getEntity(name: string): EntityDef | undefined {
  return entities.find((e) => e.name === name);
}

/** `<ENTITY>_TABLE` may override the table name or give a fully-qualified catalog.schema.table. */
export function tableName(entity: EntityDef): string {
  const override = env[`${entity.name.toUpperCase()}_TABLE`]?.trim();
  if (override?.includes('.')) return qualified(override.split('.'));
  return qualified([catalog, schema, override || entity.table]);
}

export function lookupTableName(table: string): string {
  return table.includes('.') ? qualified(table.split('.')) : qualified([catalog, schema, table]);
}

/** Effective config at boot — the fastest way to catch precedence bugs. Never includes the token. */
export function describeConfig(): Record<string, unknown> {
  return {
    appEnv: config.appEnv,
    deployEnv: config.deployEnv,
    deployed: config.deployed,
    useFakeDb: config.useFakeDb,
    host: config.host,
    httpPath: config.httpPath,
    catalog: config.catalog,
    schema: config.schema,
    tables: Object.fromEntries(entities.map((e) => [e.name, tableName(e)])),
    readGroup: config.readGroup,
    writeGroup: config.writeGroup,
    groupGateEnabled: config.groupGateEnabled,
    warmSessionCache: config.warmSessionCache,
  };
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

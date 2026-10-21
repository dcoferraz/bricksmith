// Per-request OBO connection to the SQL warehouse. A session is NEVER shared across identities.
import { config } from '../config.js';
import { AppError, type Row, type SqlParams, type UserSqlContext } from '../types.js';
import * as warmCache from './warmSessionCache.js';

type SqlModule = typeof import('@databricks/sql');
type DBSQLClient = InstanceType<SqlModule['DBSQLClient']>;
// Not exported by name from the package root in every version — derive it.
export type DBSQLSession = Awaited<ReturnType<DBSQLClient['openSession']>>;

export interface Lease {
  session: DBSQLSession;
  release(ok: boolean): Promise<void>;
}

export type Exec = (sql: string, params?: SqlParams, label?: string) => Promise<Row[]>;

// Lazy-load the driver (~1.3 s import) so tests and the fake store never pay for it.
let driver: Promise<SqlModule> | undefined;
function loadDriver(): Promise<SqlModule> {
  driver ??= import('@databricks/sql').then((m) => {
    const mod = m as SqlModule & { default?: SqlModule };
    return mod.DBSQLClient ? mod : mod.default!;
  });
  return driver;
}

const BACKOFF_MS = [400, 900, 1800];
const SESSION_OPEN_TRANSIENT = /failed to open new session|couldn't create directory|sparksession is null/i;
const STATEMENT_TRANSIENT = /not fully initialized yet|no sparksession is attached/i;
const UNCLASSIFIED_SUSPECT = /session|warehouse/i;
const PERMISSION_DENIED = /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have [A-Z_ ]+ (privilege|permission)/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function redact(text: string): string {
  return text
    .replace(/dapi[0-9a-f]{20,}(-\d+)?/gi, '[REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

export const isSessionOpenTransient = (err: unknown) => SESSION_OPEN_TRANSIENT.test(messageOf(err));
export const isStatementTransient = (err: unknown) => STATEMENT_TRANSIENT.test(messageOf(err));
export const isPermissionDenied = (err: unknown) => PERMISSION_DENIED.test(messageOf(err));

function connectError(err: unknown): unknown {
  const msg = messageOf(err);
  if (/\b403\b|forbidden/i.test(msg)) {
    return new AppError('WAREHOUSE_FORBIDDEN', 403, 'You cannot use the SQL warehouse (CAN_USE missing) or are not entitled.');
  }
  if (/\b404\b|not found/i.test(msg)) {
    return new AppError('WAREHOUSE_UNAVAILABLE', 503, 'SQL warehouse not found. Check DATABRICKS_HTTP_PATH for this environment.');
  }
  if (isSessionOpenTransient(err)) {
    return new AppError('WAREHOUSE_UNAVAILABLE', 503, 'The SQL warehouse is starting. Try again in a moment.');
  }
  return err;
}

/** Session open fails before any user SQL runs, so retrying is safe even for writes. */
async function openSession(ctx: UserSqlContext, label: string): Promise<{ client: DBSQLClient; session: DBSQLSession }> {
  const { DBSQLClient, DBSQLLogger, LogLevel } = await loadDriver();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const client = new DBSQLClient({ logger: new DBSQLLogger({ level: LogLevel.warn }) });
    try {
      await client.connect({ host: config.host!, path: config.httpPath!, token: ctx.token, telemetryEnabled: false });
      const session = await client.openSession();
      return { client, session };
    } catch (err) {
      lastErr = err;
      await client.close().catch(() => undefined);
      if (!isSessionOpenTransient(err) || attempt === BACKOFF_MS.length) break;
      console.warn(`[sql] ${label}: session open transient (attempt ${attempt + 1}), retrying`);
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw connectError(lastErr);
}

async function closeSession(client: DBSQLClient, session: DBSQLSession): Promise<void> {
  await session.close().catch(() => undefined);
  await client.close().catch(() => undefined);
}

async function openEphemeral(ctx: UserSqlContext, label: string): Promise<Lease> {
  const { client, session } = await openSession(ctx, label);
  return { session, release: () => closeSession(client, session) };
}

async function execute(session: DBSQLSession, sql: string, params: SqlParams, label: string): Promise<Row[]> {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const op = await session.executeStatement(sql, { namedParameters: params });
      try {
        const rows = (await op.fetchAll()) as Row[];
        if (config.sqlTiming) console.info(`[sql-timing] ${label} ${Date.now() - started}ms rows=${rows.length}`);
        return rows;
      } finally {
        await op.close().catch(() => undefined);
      }
    } catch (err) {
      if (isStatementTransient(err) && attempt < BACKOFF_MS.length) {
        console.warn(`[sql] ${label}: SparkSession not attached yet (attempt ${attempt + 1}), retrying`);
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      if (!isPermissionDenied(err) && UNCLASSIFIED_SUSPECT.test(messageOf(err))) {
        // How new transient variants get discovered.
        console.warn(`[sql] ${label}: unclassified session/warehouse error: ${redact(messageOf(err))}`);
      }
      throw err;
    }
  }
}

/**
 * Run `fn` with one session authenticated as the calling user. Statement labels go to logs;
 * bound values never do.
 */
export async function withUserSql<T>(ctx: UserSqlContext, label: string, fn: (exec: Exec) => Promise<T>): Promise<T> {
  const lease = config.warmSessionCache
    ? await warmCache.acquire(ctx, label, openSession, closeSession)
    : await openEphemeral(ctx, label);
  const exec: Exec = (sql, params = {}, stmtLabel = label) => execute(lease.session, sql, params, stmtLabel);
  try {
    const result = await fn(exec);
    await lease.release(true);
    return result;
  } catch (err) {
    await lease.release(false);
    if (err instanceof AppError) throw err;
    if (isPermissionDenied(err)) {
      throw new AppError('PERMISSION_CHANGED', 403, 'Your access to this data changed.');
    }
    throw err;
  }
}

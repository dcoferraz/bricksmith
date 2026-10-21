#!/usr/bin/env node
// "Users see no data" — walks the six layers in order using the CALLER's own identity. Read-only:
// GET calls, SELECT and SHOW only. Never collects tokens, never changes grants.
//
// To diagnose a specific user, have THAT user run it with their own CLI profile.
//
// Usage:
//   node diagnose-access.mjs --target <t> [--dir <repo>] [-p <profile>]            # reads bundle + shared/entities.json
//   node diagnose-access.mjs --app <name> --warehouse <id> --table c.s.t [--table ...] [-p <profile>]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { dir: '.', tables: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--app') a.app = argv[++i];
    else if (k === '--target' || k === '-t') a.target = argv[++i];
    else if (k === '--dir') a.dir = argv[++i];
    else if (k === '--warehouse') a.warehouse = argv[++i];
    else if (k === '--table') a.tables.push(argv[++i]);
    else if (k === '--profile' || k === '-p') a.profile = argv[++i];
    else if (k === '--json') a.json = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`Unknown argument: ${k}`);
  }
  return a;
}

function cli(args, { profile, cwd, json = true } = {}) {
  const full = [...args, ...(json ? ['-o', 'json'] : []), ...(profile ? ['-p', profile] : [])];
  const r = spawnSync('databricks', full, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`Cannot run the databricks CLI: ${r.error.message}`);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'CLI call failed').trim().split('\n').slice(-3).join(' '));
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

const bq = (t) => t.split('.').map((p) => `\`${p.replace(/`/g, '``')}\``).join('.');

function sql(warehouseId, statement, profile) {
  const body = JSON.stringify({ warehouse_id: warehouseId, statement, wait_timeout: '30s', on_wait_timeout: 'CONTINUE' });
  let res = cli(['api', 'post', '/api/2.0/sql/statements', '--json', body], { profile, json: false });
  for (let i = 0; i < 20 && ['PENDING', 'RUNNING'].includes(res.status?.state); i++) {
    spawnSync('sleep', ['5']); // warehouse cold start: 30 s – 5 min
    res = cli(['api', 'get', `/api/2.0/sql/statements/${res.statement_id}`], { profile, json: false });
  }
  if (res.status?.state !== 'SUCCEEDED') throw new Error(res.status?.error?.message ?? `statement ${res.status?.state ?? 'failed'}`);
  const cols = (res.manifest?.schema?.columns ?? []).map((c) => c.name);
  return (res.result?.data_array ?? []).map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v])));
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.app && !a.target)) {
    console.log('Usage: node diagnose-access.mjs (--target <t> [--dir <repo>] | --app <name> --warehouse <id> --table c.s.t ...) [-p <profile>] [--json]');
    process.exit(a.help ? 0 : 2);
  }

  const layers = [];
  const layer = (n, name, status, detail, owner) => layers.push({ n, name, status, detail, owner });

  // Resolve app, warehouse, tables
  let appName = a.app;
  let warehouseId = a.warehouse;
  let tables = [...a.tables];
  let groups = {};
  if (a.target) {
    const summary = cli(['bundle', 'summary', '-t', a.target], { profile: a.profile, cwd: path.resolve(a.dir) });
    const [app] = Object.values(summary?.resources?.apps ?? {});
    const vars = Object.fromEntries(Object.entries(summary.variables ?? {}).map(([n, v]) => [n, v?.value ?? v?.default]));
    appName ??= app?.name;
    warehouseId ??= vars.warehouse_id;
    groups = { read: vars.app_group_read, write: vars.app_group_write };
    const entitiesFile = path.resolve(a.dir, 'shared/entities.json');
    if (!tables.length && existsSync(entitiesFile) && vars.catalog && vars.schema) {
      tables = JSON.parse(readFileSync(entitiesFile, 'utf8')).map((e) => `${vars.catalog}.${vars.schema}.${e.table}`);
    }
  }

  const me = cli(['current-user', 'me'], { profile: a.profile });
  const myGroups = (me.groups ?? []).map((g) => g.display);
  const who = me.userName ?? me.displayName ?? 'caller';

  // 1. App access
  let app;
  try {
    app = cli(['apps', 'get', appName], { profile: a.profile });
  } catch (err) {
    layer(1, 'App access', 'FAIL', `cannot read app ${appName}: ${err.message}`, 'Admin: app CAN_USE for the user’s group');
  }
  if (app) {
    try {
      const acl = cli(['apps', 'get-permissions', appName], { profile: a.profile }).access_control_list ?? [];
      const canUse = acl.filter((e) => (e.all_permissions ?? []).some((p) => ['CAN_USE', 'CAN_MANAGE'].includes(p.permission_level)));
      const principals = canUse.map((e) => e.group_name ?? e.user_name ?? e.service_principal_name).filter(Boolean);
      const hit = canUse.some((e) => e.user_name === who || (e.group_name && myGroups.includes(e.group_name)));
      layer(1, 'App access', hit ? 'PASS' : 'UNKNOWN', `CAN_USE: ${principals.join(', ') || 'none'}; ${who} groups (workspace view): ${myGroups.join(', ') || 'none'}`,
        hit ? undefined : 'Admin: add the user to an app group. Note: account-level groups may not show here — the app checks is_account_group_member()');
    } catch {
      layer(1, 'App access', 'UNKNOWN', 'cannot read the app ACL (needs CAN_MANAGE). You can open the app object, so it exists.', 'Admin: confirm app CAN_USE');
    }
    if (groups.read || groups.write) layers.at(-1).detail += `; API gate groups: read=${groups.read ?? '-'} write=${groups.write ?? '-'}`;

    // 2. OBO scope
    const eff = app.effective_user_api_scopes ?? [];
    layer(2, 'OBO scope & identity', eff.includes('sql') ? 'PASS' : 'FAIL', `effective_user_api_scopes=[${eff.join(', ')}]`,
      eff.includes('sql') ? undefined : 'Platform/admin: user-token passthrough + allow `sql`; bundle: user_api_scopes at app level');
    warehouseId ??= (app.resources ?? []).find((r) => r.sql_warehouse)?.sql_warehouse?.id;
  }

  // 3. Warehouse
  let warehouseOk = false;
  if (!warehouseId) layer(3, 'Warehouse', 'FAIL', 'no warehouse id (bundle variable or app resource)', 'App team: set warehouse_id per target');
  else {
    try {
      const w = cli(['warehouses', 'get', warehouseId], { profile: a.profile });
      warehouseOk = true;
      layer(3, 'Warehouse', w.state === 'RUNNING' ? 'PASS' : 'WARN', `${w.name ?? warehouseId}: ${w.state}${w.enable_serverless_compute ? ' (serverless)' : ''}`,
        w.state === 'RUNNING' ? undefined : 'Expected while starting (30 s – 5 min on classic). Prefer serverless for apps.');
    } catch (err) {
      layer(3, 'Warehouse', 'FAIL', `${who} cannot read warehouse ${warehouseId}: ${err.message}`, 'Admin: grant the user’s group CAN_USE on the warehouse');
    }
  }

  // 4 + 5. Unity Catalog and data
  if (warehouseOk) {
    for (const t of tables) {
      try {
        const grants = sql(warehouseId, `SHOW GRANTS ON TABLE ${bq(t)}`, a.profile);
        const mine = grants.filter((g) => g.Principal === who || myGroups.includes(g.Principal) || g.Principal === 'account users');
        const privs = [...new Set(mine.map((g) => g.ActionType))];
        layer(4, `Unity Catalog: ${t}`, privs.length ? 'PASS' : 'UNKNOWN', `privileges via user/workspace groups: ${privs.join(', ') || 'none visible (account groups are not listed here)'}`);
      } catch (err) {
        layer(4, `Unity Catalog: ${t}`, 'FAIL', err.message, 'Data owner/admin: USE CATALOG, USE SCHEMA, SELECT (MODIFY for writes) to the group');
        continue;
      }
      try {
        const [row] = sql(warehouseId, `SELECT count(*) AS n FROM ${bq(t)} WHERE is_current = true`, a.profile);
        const n = Number(row?.n ?? 0);
        layer(5, `Data: ${t}`, n > 0 ? 'PASS' : 'WARN', `${n} current rows`, n > 0 ? undefined : 'Data owner: seed/ingest for this environment; check catalog name typos (_qa vs _sqa)');
      } catch (err) {
        layer(5, `Data: ${t}`, 'FAIL', err.message, 'Check the table exists in THIS environment’s catalog (bootstrap DDL, not only the test seed)');
      }
    }
    if (!tables.length) layer(4, 'Unity Catalog', 'UNKNOWN', 'no tables given (--table or --target with shared/entities.json)');
  }

  // 6. Query/UI
  layer(6, 'Query/UI', 'MANUAL', 'If 1–5 pass: compare /api response shape with the client, check stale option caches, cold-start retries in app logs (databricks apps logs).');

  const order = { FAIL: 0, WARN: 1, UNKNOWN: 2, PASS: 3, MANUAL: 4 };
  const first = [...layers].sort((x, y) => order[x.status] - order[y.status] || x.n - y.n)[0];
  if (a.json) {
    console.log(JSON.stringify({ caller: who, app: appName, warehouseId, layers, firstProblem: first.status === 'PASS' ? null : first }, null, 2));
  } else {
    console.log(`Diagnosing as ${who} (app ${appName ?? '-'}, warehouse ${warehouseId ?? '-'})`);
    for (const l of layers) {
      console.log(`${l.status.padEnd(7)} ${l.n}. ${l.name}: ${l.detail}`);
      if (l.owner) console.log(`        → ${l.owner}`);
    }
    if (['FAIL', 'WARN'].includes(first.status)) console.log(`\nFirst problem: layer ${first.n} (${first.name}). Layers 1–4 are usually admin actions — say so, do not change grants.`);
  }
  process.exit(layers.some((l) => l.status === 'FAIL') ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

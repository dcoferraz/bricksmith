#!/usr/bin/env node
// Proof of green after a deploy: active deployment SUCCEEDED, app RUNNING, `sql` in effective scopes,
// warehouse resource bound. Read-only. Zero dependencies; shells out to the Databricks CLI.
//
// Usage: node verify-deploy.mjs (--app <name> | --target <t> [--dir <repo>] [--key <resource-key>]) [-p <profile>] [--json]
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const a = { dir: '.', json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--app') a.app = argv[++i];
    else if (k === '--target' || k === '-t') a.target = argv[++i];
    else if (k === '--dir') a.dir = argv[++i];
    else if (k === '--key') a.key = argv[++i];
    else if (k === '--profile' || k === '-p') a.profile = argv[++i];
    else if (k === '--json') a.json = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`Unknown argument: ${k}`);
  }
  return a;
}

export function cli(args, { profile, cwd } = {}) {
  const full = [...args, '-o', 'json', ...(profile ? ['-p', profile] : [])];
  const r = spawnSync('databricks', full, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`Cannot run the databricks CLI: ${r.error.message}`);
  if (r.status !== 0) {
    const err = new Error((r.stderr || r.stdout || `databricks ${args.join(' ')} failed`).trim());
    err.cliFailed = true;
    throw err;
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

export function resolveFromBundle({ target, dir, key, profile }) {
  const summary = cli(['bundle', 'summary', '-t', target], { profile, cwd: path.resolve(dir) });
  const apps = summary?.resources?.apps ?? {};
  const keys = Object.keys(apps);
  const k = key ?? keys[0];
  if (!k || !apps[k]) throw new Error(`No app resource ${key ?? ''} in bundle target ${target} (found: ${keys.join(', ') || 'none'})`);
  const vars = Object.fromEntries(Object.entries(summary.variables ?? {}).map(([n, v]) => [n, v?.value ?? v?.default]));
  return { key: k, name: apps[k].name, vars };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.app && !a.target)) {
    console.log('Usage: node verify-deploy.mjs (--app <name> | --target <t> [--dir <repo>] [--key <resource-key>]) [-p <profile>] [--json]');
    process.exit(a.help ? 0 : 2);
  }

  let name = a.app;
  let expectedWarehouse;
  if (!name) {
    const b = resolveFromBundle(a);
    name = b.name;
    expectedWarehouse = b.vars.warehouse_id;
  }

  const app = cli(['apps', 'get', name], { profile: a.profile });
  const checks = [];
  const check = (ok, label, detail, owner) => checks.push({ status: ok ? 'PASS' : 'FAIL', label, detail, owner: ok ? undefined : owner });

  const dep = app.active_deployment;
  const depState = dep?.status?.state;
  check(depState === 'SUCCEEDED', 'Active deployment SUCCEEDED', `${depState ?? 'none'}${dep?.status?.message ? ` — ${dep.status.message}` : ''}`, 'App team: read `databricks apps logs` (Logs tab); was `bundle run` executed?');
  if (app.pending_deployment) {
    checks.push({ status: 'INFO', label: 'Pending deployment', detail: `${app.pending_deployment.status?.state ?? ''} ${app.pending_deployment.status?.message ?? ''}`.trim() });
  }
  const appState = app.app_status?.state;
  check(appState === 'RUNNING', 'App RUNNING', `${appState ?? 'unknown'}${app.app_status?.message ? ` — ${app.app_status.message}` : ''}`, 'App team: start command / build output / logs');
  const compute = app.compute_status?.state;
  check(compute === 'ACTIVE', 'Compute ACTIVE', compute ?? 'unknown', 'Platform: app compute');

  const effective = app.effective_user_api_scopes ?? [];
  const declared = app.user_api_scopes ?? [];
  check(
    effective.includes('sql'),
    'effective_user_api_scopes contains sql',
    `effective=[${effective.join(', ')}] declared=[${declared.join(', ')}]`,
    declared.includes('sql')
      ? 'Platform/admin: enable user-token passthrough and allow `sql` (allowedAppsUserApiScopes); users may need to consent'
      : 'App team: put user_api_scopes: [sql] at the app level of the bundle (not under config:)',
  );

  const wh = (app.resources ?? []).find((r) => r.sql_warehouse);
  check(Boolean(wh), 'sql_warehouse resource bound', wh ? `${wh.name}: ${wh.sql_warehouse.id} (${wh.sql_warehouse.permission})` : 'none', 'App team: add the sql_warehouse resource (CAN_USE) to the bundle');
  if (wh && expectedWarehouse && wh.sql_warehouse.id !== expectedWarehouse) {
    check(false, 'Warehouse matches bundle target', `deployed ${wh.sql_warehouse.id}, bundle ${expectedWarehouse}`, 'App team: a stale resource or app.yaml is still effective — inspect and redeploy');
  }

  const info = {
    app: name,
    url: app.url,
    deploymentId: dep?.deployment_id,
    sourceCodePath: dep?.source_code_path,
    deployedAt: dep?.update_time ?? dep?.create_time,
    servicePrincipal: app.service_principal_name ?? app.service_principal_client_id,
  };

  // Best effort: echo the deployed env (names + non-secret values) to catch precedence bugs.
  let env;
  if (dep?.deployment_id) {
    try {
      const d = cli(['apps', 'get-deployment', name, dep.deployment_id], { profile: a.profile });
      const found = JSON.stringify(d).match(/"env(_vars)?":\s*(\[[^\]]*\])/);
      if (found) {
        env = JSON.parse(found[2]).map((e) => ({ name: e.name, value: /TOKEN|SECRET|PASSWORD/i.test(e.name ?? '') ? '[REDACTED]' : e.value ?? e.value_from }));
      }
    } catch {
      env = undefined;
    }
  }

  const failed = checks.some((c) => c.status === 'FAIL');
  if (a.json) {
    console.log(JSON.stringify({ ok: !failed, info, checks, env }, null, 2));
  } else {
    console.log(`App ${name}${info.url ? `  ${info.url}` : ''}`);
    console.log(`  deployment ${info.deploymentId ?? '-'} from ${info.sourceCodePath ?? '-'} at ${info.deployedAt ?? '-'}`);
    for (const c of checks) {
      console.log(`${c.status.padEnd(5)} ${c.label}: ${c.detail}`);
      if (c.owner) console.log(`      → ${c.owner}`);
    }
    if (env) {
      console.log('Deployed env:');
      for (const e of env) console.log(`  ${e.name}=${e.value ?? ''}`);
    }
    console.log(failed ? '\nNOT green.' : '\nGreen: deployment SUCCEEDED, app RUNNING, sql scope effective.');
  }
  process.exit(failed ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

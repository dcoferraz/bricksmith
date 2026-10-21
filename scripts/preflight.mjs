#!/usr/bin/env node
// Databricks App deploy preflight. Zero dependencies. Each rule = one real production failure.
// Exits 1 on any ERROR. Usage: node preflight.mjs [repo-dir] [--answers <file>] [--json]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_SIDE = [
  'CI secret bound to the right environment (else "Failed to decrypt secret ... sts:AssumeRole 403")',
  'User-token passthrough enabled and `sql` allowed for apps (check effective_user_api_scopes after deploy)',
  'The three independent grants: app CAN_USE, warehouse CAN_USE, Unity Catalog grants (incl. USE CATALOG/SCHEMA)',
  'CI delegate/runner selector names per environment ("no eligible delegates")',
  'Apps log domain reachable from the corporate network (logs 403)',
  'An app created by hand must be bound once: databricks bundle deployment bind <key> <name>',
  'Branch protection / the first deploy is the PR-merge push',
  'CI scan/environment gate matches the target environment',
];

// ---------------------------------------------------------------- tiny YAML key-path reader
// Not a YAML parser: enough structure (paths, list items, flow maps) for lint rules.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

function splitFlowMap(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of body) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out
    .map((p) => /^\s*([^:]+?)\s*:\s*(.*)$/.exec(p))
    .filter(Boolean)
    .map((m) => [unquote(m[1]), m[2].trim()]);
}

export function readYaml(text) {
  const entries = [];
  const stack = []; // { indent, key }
  let itemSeq = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim() || line.trim() === '---') return;
    let indent = line.length - line.trimStart().length;
    let content = line.trim();
    let item = null;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (content.startsWith('- ') || content === '-') {
      item = ++itemSeq;
      stack.push({ indent, key: '[]', item });
      content = content.slice(1).trim();
      indent += 2;
      if (!content) return;
    }
    const parentItem = [...stack].reverse().find((s) => s.item)?.item ?? null;
    const base = stack.map((s) => s.key);
    if (content.startsWith('{') && content.endsWith('}')) {
      // List item written as a flow map: - { name: X, value: Y }
      for (const [k, v] of splitFlowMap(content.slice(1, -1))) {
        entries.push({ path: [...base, k].join('.'), key: k, value: unquote(v), raw: v, line: idx + 1, item: parentItem });
      }
      return;
    }
    const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(\s+(.*))?$/.exec(content);
    if (!m) {
      entries.push({ path: base.join('.'), key: null, value: unquote(content), line: idx + 1, item: parentItem });
      return;
    }
    const key = unquote(m[1]);
    const value = (m[3] ?? '').trim();
    const p = [...base, key].join('.');
    entries.push({ path: p, key, value: unquote(value), raw: value, line: idx + 1, item: parentItem });
    if (value.startsWith('{') && value.endsWith('}')) {
      for (const [k, v] of splitFlowMap(value.slice(1, -1))) {
        entries.push({ path: `${p}.${k}`, key: k, value: unquote(v), raw: v, line: idx + 1, item: parentItem });
        if (v.startsWith('{') && v.endsWith('}')) {
          for (const [k2, v2] of splitFlowMap(v.slice(1, -1)))
            entries.push({ path: `${p}.${k}.${k2}`, key: k2, value: unquote(v2), raw: v2, line: idx + 1, item: parentItem });
        }
      }
    }
    if (!value) stack.push({ indent, key });
  });
  return entries;
}

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const args = { dir: '.', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--answers') args.answers = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
    else args.dir = argv[i];
  }
  return args;
}

const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

function walk(dir, depth = 0, out = []) {
  if (!existsSync(dir) || depth > 4) return out;
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.databricks'].includes(e)) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

function ciFiles(root) {
  const dirs = ['.github/workflows', '.harness', '.azure-pipelines', 'pipelines', '.pipelines', 'ci', '.circleci', '.buildkite'];
  const single = ['.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'];
  return [
    ...dirs.flatMap((d) => walk(path.join(root, d)).filter((f) => /\.(ya?ml|json|groovy|sh)$/i.test(f))),
    ...single.map((f) => path.join(root, f)).filter(existsSync),
  ];
}

function versionGte(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return true;
}

// ---------------------------------------------------------------- rules

export function runChecks(root, opts = {}) {
  const findings = [];
  const add = (sev, rule, message, file, line) => findings.push({ sev, rule, message, file: file ? path.relative(root, file) || file : undefined, line });

  const bundleFile = ['databricks.yml', 'databricks.yaml'].map((f) => path.join(root, f)).find(existsSync);
  const bundleText = bundleFile ? readFileSync(bundleFile, 'utf8') : '';
  const y = bundleFile ? readYaml(bundleText) : [];
  const get = (p) => y.find((e) => e.path === p);
  const ci = ciFiles(root);
  const ciText = ci.map((f) => [f, readFileSync(f, 'utf8')]);
  const pkgFile = path.join(root, 'package.json');
  const isNode = existsSync(pkgFile);

  if (!bundleFile) {
    add('ERROR', 'no-bundle', 'No databricks.yml: deploy with an Asset Bundle (bundle deploy + bundle run), not native git source');
  } else {
    // cli-floor
    const cli = get('bundle.databricks_cli_version');
    const min = cli && /(\d+\.\d+\.\d+)/.exec(cli.value)?.[1];
    if (!cli) add('ERROR', 'cli-floor', 'bundle.databricks_cli_version missing — CLIs < 0.239.0 silently ignore resources.apps', bundleFile);
    else if (!min || !versionGte(min, '0.239.0')) add('ERROR', 'cli-floor', `CLI floor ${cli.value} is below 0.239.0`, bundleFile, cli.line);

    // valueFrom
    const vf = bundleText.split(/\r?\n/).findIndex((l) => /\bvalueFrom\s*:/.test(stripComment(l)));
    if (vf >= 0) add('ERROR', 'value-from-spelling', '`valueFrom` is the app.yaml spelling; the bundle schema uses `value_from`', bundleFile, vf + 1);

    // app resources
    const appKeys = [...new Set(y.map((e) => /^resources\.apps\.([^.]+)\./.exec(e.path)?.[1]).filter(Boolean))];
    if (!appKeys.length) add('ERROR', 'no-app-resource', 'No resources.apps entry in the bundle', bundleFile);

    for (const k of appKeys) {
      const pre = `resources.apps.${k}`;
      const scopes = get(`${pre}.user_api_scopes`);
      const underConfig = get(`${pre}.config.user_api_scopes`);
      const scopeItems = y.filter((e) => e.path === `${pre}.user_api_scopes.[]`).map((e) => e.value);
      if (underConfig) add('ERROR', 'scopes-under-config', `${k}: user_api_scopes is under config: (ignored). Move it to the app level`, bundleFile, underConfig.line);
      else if (!scopes) add('ERROR', 'scopes-missing', `${k}: user_api_scopes: [sql] missing — OBO SQL will fail`, bundleFile);
      else if (!/\bsql\b/.test(scopes.raw ?? '') && !scopeItems.includes('sql')) add('ERROR', 'scopes-missing', `${k}: user_api_scopes does not include sql`, bundleFile, scopes.line);

      if (!y.some((e) => e.path.startsWith(`${pre}.resources.[].sql_warehouse`))) {
        add('WARN', 'no-warehouse-resource', `${k}: no sql_warehouse resource — the app service principal lacks CAN_USE`, bundleFile);
      }

      const cmd = get(`${pre}.config.command`);
      const committedDist = existsSync(path.join(root, 'server/dist')) || existsSync(path.join(root, 'dist'));
      if (isNode && !/build/.test(cmd?.raw ?? '') && !committedDist) {
        add('WARN', 'node-no-build', `${k}: Node app without build-at-start (e.g. "npm ci && npm run build && node ...") — no artifacts at runtime`, bundleFile, cmd?.line);
      }

      // env items grouped by list item
      const envEntries = y.filter((e) => e.path.startsWith(`${pre}.config.env.[]`));
      const items = new Map();
      for (const e of envEntries) {
        const it = items.get(e.item) ?? {};
        it[e.key] = e;
        items.set(e.item, it);
      }
      for (const it of items.values()) {
        const name = it.name?.value ?? '';
        if (/TOKEN|SECRET|PASSWORD|_PAT$/i.test(name) && it.value) {
          add('ERROR', 'secret-in-env', `${k}: env ${name} has a plain value — the running app would act as the deployer and bypass OBO`, bundleFile, it.value.line);
        }
        if (/^(DEPLOY_ENV|APP_ENV)$/.test(name) && it.value && !it.value.value.includes('${')) {
          add('WARN', 'env-not-templated', `${k}: ${name} is a literal (${it.value.value}); it must follow the target (\${var.env})`, bundleFile, it.value.line);
        }
      }
      if (!opts.answers && !/^[a-z0-9]+_.+_app$/.test(k)) {
        add('WARN', 'resource-key-contract', `${k}: shared deploy templates often expect <type>_<app_name>_app; a mismatch deploys but never starts`, bundleFile);
      }
    }

    if (/\bgit_source\s*:/.test(bundleText)) add('ERROR', 'git-source', 'git_source deploys only tracked files (no dist/, node_modules/) → "did not start within 10 minutes"', bundleFile);

    // targets
    const targets = [...new Set(y.map((e) => /^targets\.([^.]+)/.exec(e.path)?.[1]).filter(Boolean))];
    for (const t of ['dev', 'sqa', 'prd']) if (!targets.includes(t)) add('WARN', 'missing-target', `No "${t}" target (expected dev, sqa, prd)`, bundleFile);
    const hosts = new Map();
    for (const t of targets) {
      const mode = get(`targets.${t}.mode`);
      if (mode?.value === 'development') add('WARN', 'mode-development', `targets.${t}: mode: development renames the app "[dev user] ..." and forces per-user paths`, bundleFile, mode.line);
      const host = get(`targets.${t}.workspace.host`)?.value?.replace(/\/$/, '');
      if (host) hosts.set(host, [...(hosts.get(host) ?? []), t]);
      const root = get(`targets.${t}.workspace.root_path`) ?? get('workspace.root_path');
      if (!root) add('WARN', 'root-path-default', `targets.${t}: no root_path — defaults to the deployer's /Workspace/Users home`, bundleFile);
      const wh = get(`targets.${t}.variables.warehouse_id`)?.value ?? get('variables.warehouse_id.default')?.value;
      if (y.some((e) => e.path === 'variables.warehouse_id') && !wh) add('ERROR', 'warehouse-per-target', `targets.${t}: warehouse_id does not resolve (templates usually do not pass --var)`, bundleFile);
    }
    for (const [host, ts] of hosts) if (ts.length > 1) add('WARN', 'shared-workspace', `Targets ${ts.join(', ')} share ${host} — the dev pipeline deploys into prod`, bundleFile);
    for (const e of y.filter((x) => x.key === 'root_path' && /\/Users\//.test(x.value))) {
      add('ERROR', 'personal-root-path', `root_path ${e.value} is personal — ownership dies with the person`, bundleFile, e.line);
    }
    for (const e of y.filter((x) => typeof x.value === 'string' && /<[a-z][^<>]*>|\bchangeme\b|\bTODO\b/i.test(x.value))) {
      add('WARN', 'placeholder', `Leftover placeholder at ${e.path}: ${e.value}`, bundleFile, e.line);
    }
  }

  // app.yaml precedence
  const appYaml = ['app.yaml', 'app.yml'].map((f) => path.join(root, f)).filter(existsSync);
  if (appYaml.length === 2) add('WARN', 'app-yaml-both', 'Both app.yaml and app.yml exist — the runtime reads one; ambiguous', appYaml[0]);
  for (const f of appYaml) {
    const t = readFileSync(f, 'utf8');
    if (/^\s*env\s*:/m.test(t)) add('ERROR', 'app-yaml-env', `${path.basename(f)} has env: — it overrides bundle config.env for EVERY target (sqa/prd run the dev catalog)`, f);
    else add('WARN', 'app-yaml-present', `${path.basename(f)} present — it wins over the bundle config; keep config in bundle targets`, f);
  }

  // npm traps
  if (isNode) {
    if (!existsSync(path.join(root, 'package-lock.json'))) add('ERROR', 'no-lockfile', 'No package-lock.json — npm ci fails at app start', pkgFile);
    const npmrc = path.join(root, '.npmrc');
    const rc = read(npmrc);
    if (rc) {
      const lines = rc.split(/\r?\n/);
      const reg = lines.findIndex((l) => /^\s*(@[^:]+:)?registry\s*=/.test(l));
      if (reg >= 0) add('ERROR', 'registry-pinned', '.npmrc pins a registry — an internal mirror is unreachable from Databricks cloud ("Installing packages" hangs)', npmrc, reg + 1);
    }
  }
  const omitTargets = [path.join(root, '.npmrc'), pkgFile, bundleFile, ...appYaml, ...walk(root, 3).filter((f) => /Dockerfile/.test(path.basename(f))), ...ci].filter(
    (f) => f && existsSync(f),
  );
  for (const f of omitTargets) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => /omit[=\s]+optional|NPM_CONFIG_OMIT\s*[:=]\s*["']?optional/i.test(stripComment(l)));
    if (i >= 0) add('ERROR', 'omit-optional', 'omit=optional drops esbuild/rollup native binaries → "Error installing packages"', f, i + 1);
  }

  // runtime tag format
  for (const f of [...ci, ...walk(root, 1).filter((x) => /runtime|dbr/i.test(path.basename(x)))]) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => /\b\d+\.\d+\.x-scala\d/.test(l));
    if (i >= 0) add('ERROR', 'runtime-tag', 'Runtime tag in cluster form (15.4.x-scala2.12) → ImagePullBackOff; use image form (15.4-LTS)', f, i + 1);
  }

  // CI traps
  for (const [f, t] of ciText) {
    const lines = t.split(/\r?\n/);
    const trig = lines.findIndex((l) => /<\+trigger\.(branch|targetBranch|sourceBranch)>|<\+codebase\.branch>/.test(l));
    if (trig >= 0) add('ERROR', 'trigger-branch', 'Branch from a trigger expression resolves to null on manual re-runs (refs/heads/null) — hardcode per environment', f, trig + 1);
    const pw = lines.findIndex((l) => /playwright install[^\n]*--with-deps/.test(l));
    if (pw >= 0) add('WARN', 'ci-browser-install', 'playwright install --with-deps needs OS-package egress CI pods often lack', f, pw + 1);
    const starts = lines.map((l) => stripComment(l).match(/bundle run|apps deploy/g)?.length ?? 0).reduce((x, n) => x + n, 0);
    if (starts > 1) add('WARN', 'duplicate-start', `${starts} start steps (bundle run / apps deploy) in one pipeline — double start / double token`, f);
    if (/\b(prd|prod|production)\b/i.test(t) && !/approv/i.test(t)) add('WARN', 'prod-no-approval', 'Pipeline mentions prod but has no approval stage', f);
  }

  // answers file for shared deploy templates
  if (opts.answers) {
    const file = path.resolve(root, opts.answers);
    const t = read(file);
    if (!t) add('ERROR', 'answers-missing', `Answers file ${opts.answers} not found — the shared template will not bundle run the app`, file);
    else {
      const kv = Object.fromEntries(readYaml(t).filter((e) => e.key).map((e) => [e.key, e.value]));
      for (const k of ['include_databricks_app', 'app_name', 'databricks_app_type']) if (!kv[k]) add('ERROR', 'answers-keys', `Answers file missing ${k}`, file);
      if (kv.include_databricks_app && !/^(yes|true)$/i.test(kv.include_databricks_app)) add('ERROR', 'answers-keys', 'include_databricks_app is not yes', file);
      const expected = `${kv.databricks_app_type}_${kv.app_name}_app`;
      if (kv.app_name && kv.databricks_app_type && !y.some((e) => e.path.startsWith(`resources.apps.${expected}.`))) {
        add('ERROR', 'resource-key-mismatch', `Template composes resource key ${expected}, not found in the bundle — deploys, never starts`, bundleFile);
      }
    }
  }

  // local secrets
  const gi = read(path.join(root, '.gitignore')) ?? '';
  if (existsSync(path.join(root, 'server/.env')) && !/(^|\/)\.env\b/m.test(gi)) add('ERROR', 'env-file-tracked', 'server/.env exists and .gitignore does not exclude .env files');

  const order = { ERROR: 0, WARN: 1 };
  return findings.sort((a, b) => order[a.sev] - order[b.sev]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node preflight.mjs [repo-dir] [--answers <file>] [--json]');
    return;
  }
  const root = path.resolve(args.dir);
  const findings = runChecks(root, args);
  const errors = findings.filter((f) => f.sev === 'ERROR').length;
  if (args.json) {
    console.log(JSON.stringify({ root, errors, warnings: findings.length - errors, findings, platformSide: PLATFORM_SIDE }, null, 2));
  } else {
    if (!findings.length) console.log('No repo-side findings.');
    for (const f of findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      console.log(`${f.sev.padEnd(5)} ${f.rule.padEnd(24)} ${f.message}${loc}`);
    }
    console.log(`\n${errors} error(s), ${findings.length - errors} warning(s).`);
    console.log('\nNot checkable from the repo (platform-owned — confirm, do not guess):');
    for (const p of PLATFORM_SIDE) console.log(`  - ${p}`);
  }
  process.exit(errors ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

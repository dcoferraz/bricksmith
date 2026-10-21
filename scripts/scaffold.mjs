#!/usr/bin/env node
// Zero-dependency generator: validated app-spec.json -> Databricks App (OBO server, gated React UI,
// bundle with dev/sqa/prd targets, bi-temporal DDL + grants, tests that pass on the fake DB).
//
// Usage: node scaffold.mjs --spec app-spec.json --out ../my-app [--force] [--validate-only]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '../assets/templates/app');
const ENVS = ['dev', 'sqa', 'prd'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APP_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const FIELD_TYPES = ['string', 'text', 'integer', 'number', 'boolean', 'date'];
const RESERVED = new Set([
  'row_uid', 'row_checksum', 'business_start_date', 'business_end_date', 'system_start_ts',
  'system_end_ts', 'is_current', 'process_id', 'source_system_cd', 'created_by', 'updated_by', 'updated_at',
]);
const SQL_TYPE = { string: 'STRING', text: 'STRING', integer: 'INT', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE' };

function parseArgs(argv) {
  const args = { force: false, validateOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') args.spec = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--validate-only') args.validateOnly = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------- validation

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const isPlaceholder = (v) => typeof v === 'string' && /<[^>]+>|changeme|todo/i.test(v);

  const app = spec.app ?? {};
  if (!app.name || !APP_NAME.test(app.name)) err('app.name must be lowercase letters, digits, hyphens (e.g. "inventory-app")');
  else if (app.name.length + '-prd'.length > 30) err(`app.name "${app.name}" is too long: "<name>-<env>" must be <= 30 characters`);
  if (!app.title) warn('app.title missing — using app.name');
  if (app.type && !IDENT.test(app.type)) err('app.type must be an identifier (e.g. "node")');

  const envs = spec.environments ?? {};
  for (const env of ENVS) {
    const e = envs[env];
    if (!e) {
      err(`environments.${env} is required (every bundle needs dev, sqa, and prd targets)`);
      continue;
    }
    if (!/^https:\/\/[^/\s]+\/?$/.test(e.host ?? '')) err(`environments.${env}.host must be https://<workspace-host>`);
    for (const k of ['catalog', 'schema']) {
      if (!e[k] || !IDENT.test(e[k])) err(`environments.${env}.${k} must be a SQL identifier`);
    }
    if (!e.warehouseId) err(`environments.${env}.warehouseId is required (deploy templates usually do not pass --var)`);
    else if (!isPlaceholder(e.warehouseId) && !/^[A-Za-z0-9]+$/.test(e.warehouseId)) err(`environments.${env}.warehouseId must be the bare id, not a path`);
    if (!e.readGroup || !e.writeGroup) err(`environments.${env}.readGroup and writeGroup are required (grant to groups, never individuals)`);
    if (e.rootPath && /\/Users\//.test(e.rootPath)) err(`environments.${env}.rootPath must not be a personal /Workspace/Users path`);
    for (const [k, v] of Object.entries(e)) if (isPlaceholder(v)) warn(`environments.${env}.${k} still looks like a placeholder: ${v}`);
  }
  const hosts = ENVS.map((e) => envs[e]?.host?.replace(/\/$/, '')).filter(Boolean);
  if (new Set(hosts).size < hosts.length) warn('Two targets share a workspace host — a dev pipeline would deploy into prod. Prefer one workspace per env.');
  const catalogs = ENVS.map((e) => envs[e]?.catalog).filter(Boolean);
  if (new Set(catalogs).size < catalogs.length) warn('Two environments share a catalog — check for _qa/_sqa or _prod/_prd typos.');

  const entities = spec.entities ?? [];
  if (!entities.length) err('entities must contain at least one entity');
  const names = new Set();
  for (const [i, ent] of entities.entries()) {
    const where = `entities[${i}]${ent?.name ? ` (${ent.name})` : ''}`;
    if (!ent.name || !/^[a-z][a-z0-9_]*$/.test(ent.name)) err(`${where}.name must be lowercase snake_case`);
    if (names.has(ent.name)) err(`${where}.name is duplicated`);
    names.add(ent.name);
    if (ent.table && !IDENT.test(ent.table)) err(`${where}.table must be a SQL identifier`);
    if (!Array.isArray(ent.fields) || !ent.fields.length) {
      err(`${where}.fields must be a non-empty array`);
      continue;
    }
    const fieldNames = new Set();
    for (const f of ent.fields) {
      if (!f.name || !IDENT.test(f.name)) err(`${where}: field name ${JSON.stringify(f.name)} must be a SQL identifier`);
      if (RESERVED.has(f.name)) err(`${where}: field ${f.name} collides with a bi-temporal audit column`);
      if (fieldNames.has(f.name)) err(`${where}: field ${f.name} is duplicated`);
      fieldNames.add(f.name);
      if (!FIELD_TYPES.includes(f.type)) err(`${where}: field ${f.name} type must be one of ${FIELD_TYPES.join(', ')}`);
      if (f.options) {
        if (Array.isArray(f.options.values)) {
          if (!f.options.values.length) err(`${where}: field ${f.name} options.values is empty`);
        } else if (f.options.lookup) {
          const l = f.options.lookup;
          if (!l.table || !l.table.split('.').every((p) => IDENT.test(p))) err(`${where}: field ${f.name} lookup.table is invalid`);
          if (!IDENT.test(l.valueColumn ?? '') || !IDENT.test(l.labelColumn ?? '')) err(`${where}: field ${f.name} lookup columns are invalid`);
        } else err(`${where}: field ${f.name} options needs "values" or "lookup"`);
      }
    }
    if (!Array.isArray(ent.key) || !ent.key.length) err(`${where}.key must list at least one field (stable entity key)`);
    else for (const k of ent.key) if (!fieldNames.has(k)) err(`${where}.key ${k} is not a field`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- normalization

function normalize(spec) {
  const name = spec.app.name;
  const type = spec.app.type ?? 'node';
  return {
    ...spec,
    app: {
      ...spec.app,
      title: spec.app.title ?? name,
      type,
      // Shared deploy templates often compose the key as <type>_<app_name>_app — keep that contract.
      resourceKey: spec.app.resourceKey ?? `${type}_${name.replace(/-/g, '_')}_app`,
    },
    entities: spec.entities.map((e) => ({
      name: e.name,
      label: e.label ?? titleCase(e.name),
      table: e.table ?? e.name,
      key: e.key,
      fields: e.fields.map((f) => ({
        ...f,
        label: f.label ?? titleCase(f.name),
        required: e.key.includes(f.name) ? true : Boolean(f.required), // keys are always required
      })),
    })),
  };
}

const titleCase = (s) => s.split(/[_-]+/).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
const yq = (v) => JSON.stringify(String(v)); // JSON strings are valid YAML double-quoted scalars
const bq = (v) => `\`${String(v).replace(/`/g, '``')}\``;
const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- generators

function bundleYaml(s) {
  const { app } = s;
  const target = (env) => {
    const e = s.environments[env];
    const rootPath = (e.rootPath ?? '/Workspace/Shared/apps').replace(/\/$/, '');
    return [
      `  ${env}:`,
      env === 'dev' ? '    default: true # NO `mode: development` — it renames the app "[dev user] ..." and forces per-user paths' : null,
      env === 'prd' ? '    mode: production' : null,
      '    variables:',
      `      env: ${env}`,
      `      deploy_app_name: ${app.name}-${env}`,
      `      catalog: ${e.catalog}`,
      `      schema: ${e.schema}`,
      `      warehouse_id: ${yq(e.warehouseId)}`,
      `      app_group_read: ${yq(e.readGroup)}`,
      `      app_group_write: ${yq(e.writeGroup)}`,
      '    workspace:',
      `      host: ${e.host.replace(/\/$/, '')}`,
      `      root_path: ${rootPath}/.bundle/\${bundle.name}/\${bundle.target} # shared path, never /Workspace/Users/<person>`,
    ]
      .filter((l) => l !== null)
      .join('\n');
  };
  const sameGroups = ENVS.every((env) => s.environments[env].readGroup === s.environments[env].writeGroup);
  return `# Generated by bricksmith. Runtime config lives HERE, per target. Do not add app.yaml.
bundle:
  name: ${app.name}
  databricks_cli_version: ">= 0.239.0, <= 2.0.0" # resources.apps landed in 0.239.0; older CLIs IGNORE it silently

variables:
  deploy_app_name:
    description: Per-environment app name (immutable once created)
    default: ${app.name}-dev
  env:
    default: dev
  catalog:
    default: ${s.environments.dev.catalog}
  schema:
    default: ${s.environments.dev.schema}
  warehouse_id:
    description: SQL warehouse id (bare id, not a path)
    default: ""
  app_group_read:
    description: Group that may open the app (read)
    default: ""
  app_group_write:
    description: Group that may mutate data
    default: ""

targets:
${ENVS.map(target).join('\n')}

resources:
  apps:
    ${app.resourceKey}: # key contract: <type>_<app_name>_app
      name: \${var.deploy_app_name}
      description: ${yq(app.title)}
      source_code_path: ./
      user_api_scopes: # APP-LEVEL. Under config: it is ignored
        - sql
      config:
        command: ["sh", "-c", "npm ci --include=dev && npm run build && node server/dist/index.js"]
        env:
          - name: DATABRICKS_HTTP_PATH
            value: /sql/1.0/warehouses/\${var.warehouse_id} # literal path; value_from did not inject reliably
          - name: APP_ENV
            value: \${var.env}
          - name: DEPLOY_ENV
            value: \${var.env} # must follow the target
          - name: DATABRICKS_CATALOG
            value: \${var.catalog}
          - name: DATABRICKS_SCHEMA
            value: \${var.schema}
          - name: APP_READ_GROUP
            value: \${var.app_group_read}
          - name: APP_WRITE_GROUP
            value: \${var.app_group_write}
      permissions: # App ACL from the same variables; the deployer gets CAN_MANAGE automatically
        - level: CAN_USE
          group_name: \${var.app_group_write}${sameGroups ? '' : `
        - level: CAN_USE
          group_name: \${var.app_group_read}`}
      resources:
        - name: sql-warehouse
          sql_warehouse: # the app service principal needs ONLY this
            id: \${var.warehouse_id}
            permission: CAN_USE
`;
}

function tableDdl(e, catalog, schema) {
  const cols = [
    "  row_uid STRING NOT NULL COMMENT 'md5 of the entity key, stable across versions'",
    "  row_checksum STRING NOT NULL COMMENT 'sha1 of non-key columns; equal checksum = no-op update'",
    ...e.fields.map((f) => `  ${bq(f.name)} ${SQL_TYPE[f.type]}${e.key.includes(f.name) ? ' NOT NULL' : ''}`),
    '  business_start_date DATE NOT NULL',
    "  business_end_date DATE NOT NULL COMMENT '9999-12-31 while open'",
    '  system_start_ts TIMESTAMP NOT NULL',
    '  system_end_ts TIMESTAMP NOT NULL',
    '  is_current BOOLEAN NOT NULL',
    '  process_id STRING',
    '  source_system_cd STRING',
    '  created_by STRING',
    '  updated_by STRING',
  ];
  return `CREATE TABLE IF NOT EXISTS ${bq(catalog)}.${bq(schema)}.${bq(e.table)} (\n${cols.join(',\n')}\n) USING DELTA\nCOMMENT ${sqlString(`${e.label} (bi-temporal, written by the app via OBO)`)};`;
}

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

function lookupTables(s) {
  const entityTables = new Set(s.entities.map((e) => e.table));
  const out = new Map();
  for (const e of s.entities)
    for (const f of e.fields)
      if (f.options?.lookup && !entityTables.has(f.options.lookup.table)) out.set(f.options.lookup.table, f.options.lookup);
  return [...out.values()];
}

function ddlFiles(s, env) {
  const { catalog, schema, readGroup, writeGroup } = s.environments[env];
  const lookups = lookupTables(s);
  const fq = (t) => (t.includes('.') ? t.split('.').map(bq).join('.') : `${bq(catalog)}.${bq(schema)}.${bq(t)}`);
  const tables = `-- ${env}: tables the app reads and writes. Owned by the contracts / data-product repo.
-- Run one statement at a time (the Statement Execution API takes one statement per call).
-- ASCII only: string bodies with unicode comments were rejected (HTTP 400) by the REST API.

${s.entities.map((e) => tableDdl(e, catalog, schema)).join('\n\n')}
${lookups.length ? `\n-- Lookup tables referenced by dropdowns. They must exist here, not only in a test seed:\n${lookups.map((l) => `--   ${fq(l.table)} (${l.valueColumn}, ${l.labelColumn})`).join('\n')}\n` : ''}`;
  const groups = [...new Set([readGroup, writeGroup])];
  const grants = `-- ${env}: Unity Catalog grants. ADMIN ACTION — an agent must never run these autonomously.
-- Grant to groups, never individuals. Users also need warehouse CAN_USE and app CAN_USE (bundle ACL).

${groups.map((g) => `GRANT USE CATALOG ON CATALOG ${bq(catalog)} TO ${bq(g)};\nGRANT USE SCHEMA ON SCHEMA ${bq(catalog)}.${bq(schema)} TO ${bq(g)};`).join('\n')}

${s.entities
  .map((e) => {
    const t = `${bq(catalog)}.${bq(schema)}.${bq(e.table)}`;
    return [
      readGroup !== writeGroup ? `GRANT SELECT ON TABLE ${t} TO ${bq(readGroup)};` : null,
      `GRANT SELECT, MODIFY ON TABLE ${t} TO ${bq(writeGroup)};`,
    ]
      .filter(Boolean)
      .join('\n');
  })
  .join('\n')}
${lookups.map((l) => groups.map((g) => `GRANT SELECT ON TABLE ${fq(l.table)} TO ${bq(g)};`).join('\n')).join('\n')}
`;
  return { tables, grants };
}

function readme(s) {
  const rows = ENVS.map((env) => {
    const e = s.environments[env];
    return `| ${env} | \`${s.app.name}-${env}\` | ${e.host} | \`${e.catalog}.${e.schema}\` | \`${e.warehouseId}\` | \`${e.readGroup}\` / \`${e.writeGroup}\` |`;
  });
  return `# ${s.app.title}

Generated Databricks App. Read \`AGENTS.md\` before changing anything.

| Env | App name | Host | Catalog.schema | Warehouse | Read / write group |
|---|---|---|---|---|---|
${rows.join('\n')}

Entities: ${s.entities.map((e) => `**${e.label}** (\`${e.table}\`, key: ${e.key.join(', ')})`).join(', ')}.

## First run

1. \`npm install\` — creates \`package-lock.json\`. Commit it (\`npm ci\` at app start needs it).
2. \`npm test\` — unit tests on the fake DB (no warehouse needed).
3. \`npm run preflight\` — repo-side deploy lint. Fix every ERROR.
4. Platform asks below are done (or ticketed).
5. \`databricks bundle validate -t dev\` → \`databricks bundle deploy -t dev\` → \`databricks bundle run ${s.app.resourceKey} -t dev\`.
6. \`databricks apps get ${s.app.name}-dev\`: deployment \`SUCCEEDED\`, and \`effective_user_api_scopes\` contains \`sql\`.

If the app was created by hand earlier, bind it before the first bundle deploy:
\`databricks bundle deployment bind ${s.app.resourceKey} ${s.app.name}-dev --target dev --auto-approve\`.

## Platform asks (admin-owned, per environment)

- [ ] Workspace allows the \`sql\` user API scope for apps, and user-token passthrough is enabled.
- [ ] Groups exist and are synced into the workspace: read and write groups per the table above.
- [ ] Both groups have \`CAN_USE\` on the SQL warehouse (prefer serverless — fewer cold-start transients).
- [ ] Tables exist: \`ddl/<env>/001_tables.sql\` (data-product / contracts owner).
- [ ] Grants applied: \`ddl/<env>/002_grants.sql\` (includes \`USE CATALOG\` / \`USE SCHEMA\`).
- [ ] CI deploy principal: \`CAN_MANAGE\` on the app + write on the bundle root. No table grants.
- [ ] Apps log domain reachable from the corporate network (otherwise \`databricks apps logs\` returns 403).
`;
}

// ---------------------------------------------------------------- copy

function copyTemplate(src, dest, vars) {
  for (const entry of readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTemplate(from, to, vars);
      continue;
    }
    let text = readFileSync(from, 'utf8');
    const isHtml = entry.endsWith('.html');
    text = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? (isHtml ? htmlEscape(vars[k]) : vars[k]) : m));
    writeFileSync(to, text);
  }
}

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.spec || (!args.out && !args.validateOnly)) {
    console.log('Usage: node scaffold.mjs --spec app-spec.json --out <dir> [--force] [--validate-only]');
    process.exit(args.help ? 0 : 2);
  }
  const spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  const { errors, warnings } = validateSpec(spec);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  if (errors.length) {
    console.log(`\nSpec invalid: ${errors.length} error(s). Nothing generated.`);
    process.exit(1);
  }
  if (args.validateOnly) {
    console.log('Spec valid.');
    return;
  }

  const s = normalize(spec);
  const out = path.resolve(args.out);
  if (existsSync(out) && readdirSync(out).length && !args.force) {
    console.log(`Refusing to write into non-empty ${out} (pass --force to overwrite generated files).`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });

  copyTemplate(TEMPLATE, out, {
    APP_NAME: s.app.name,
    APP_TITLE: s.app.title,
    DEFAULT_CATALOG: s.environments.dev.catalog,
    DEFAULT_SCHEMA: s.environments.dev.schema,
    RESOURCE_KEY: s.app.resourceKey,
  });
  write(path.join(out, 'shared/entities.json'), `${JSON.stringify(s.entities, null, 2)}\n`);
  write(path.join(out, 'databricks.yml'), bundleYaml(s));
  for (const env of ENVS) {
    const { tables, grants } = ddlFiles(s, env);
    write(path.join(out, `ddl/${env}/001_tables.sql`), tables);
    write(path.join(out, `ddl/${env}/002_grants.sql`), grants);
  }
  write(path.join(out, 'README.md'), readme(s));
  write(path.join(out, 'app-spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
  copyFileSync(path.join(HERE, 'preflight.mjs'), path.join(out, 'scripts/preflight.mjs'));

  console.log(`Generated ${s.app.title} in ${out}`);
  console.log(`  resource key: ${s.app.resourceKey}`);
  console.log(`  entities:     ${s.entities.map((e) => e.name).join(', ')}`);
  const lookups = lookupTables(s);
  if (lookups.length) console.log(`  lookup tables that must already exist: ${lookups.map((l) => l.table).join(', ')}`);
  console.log('\nNext: cd into it, `npm install` (commit package-lock.json), `npm test`, `npm run preflight`.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

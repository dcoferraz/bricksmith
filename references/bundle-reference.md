# Bundle, app.yaml, and env var reference

> Generated from the knowledge base (§5) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

## 5. Configuration: `databricks.yml`, `app.yaml`, env vars

### 5.1 Annotated bundle (the shape that works)

```yaml
bundle:
  name: <app>
  databricks_cli_version: ">= 0.239.0, <= 2.0.0"   # resources.apps landed in 0.239.0; older CLIs IGNORE it silently

variables:
  deploy_app_name: { default: <app>-dev }   # per-env app NAME
  env:             { default: dev }
  catalog:         { default: <catalog_dev> }
  schema:          { default: <schema> }
  warehouse_id:    { default: "" }
  app_group_read:  { default: "" }
  app_group_write: { default: "" }

targets:
  dev:
    default: true   # NO `mode: development` — it renames the app "[dev user] …" and forces per-user paths
    variables: { env: dev, deploy_app_name: <app>-dev, catalog: <catalog_dev>, warehouse_id: <id>, app_group_read: <g>, app_group_write: <g> }
    workspace:
      host: https://<dev-host>
      root_path: /Workspace/<shared-path>/.bundle/${bundle.name}/${bundle.target}   # never /Workspace/Users/<person>
  sqa: { … }
  prd: { mode: production, … }

resources:
  apps:
    <type>_<app_name>_app:            # key naming contract required by some shared deploy templates (see §7)
      name: ${var.deploy_app_name}
      source_code_path: ./
      user_api_scopes: [sql]          # APP-LEVEL. Under `config:` it is ignored (config only has command + env)
      config:
        command: ["sh", "-c", "npm ci && npm run build && node server/dist/index.js"]
        env:
          - { name: DATABRICKS_HTTP_PATH, value: "/sql/1.0/warehouses/${var.warehouse_id}" }
          - { name: APP_ENV, value: ${var.env} }
          - { name: DEPLOY_ENV, value: ${var.env} }   # gates key off this — must follow the target
          - { name: DATABRICKS_CATALOG, value: ${var.catalog} }
          - { name: DATABRICKS_SCHEMA, value: ${var.schema} }
          - { name: APP_READ_GROUP, value: ${var.app_group_read} }
          - { name: APP_WRITE_GROUP, value: ${var.app_group_write} }
      permissions:                    # App ACL from the same variables; deployer auto-gets CAN_MANAGE — don't re-list it
        - { level: CAN_USE, group_name: ${var.app_group_write} }
        - { level: CAN_USE, group_name: ${var.app_group_read} }
      resources:
        - name: sql-warehouse
          sql_warehouse: { id: ${var.warehouse_id}, permission: CAN_USE }   # SP needs ONLY this
```

### 5.2 Spelling & precedence traps

| Trap | Rule |
|---|---|
| `valueFrom` vs `value_from` | `valueFrom` is the app.yaml spelling; the bundle schema is `value_from`. |
| `value_from: sql-warehouse` | In our deployment it did not inject at runtime ("Missing required environment variable: DATABRICKS_HTTP_PATH"). Templating the literal path from `warehouse_id` is deterministic. Keep the resource anyway — it grants the SP `CAN_USE`. |
| Bare warehouse id | Where it is injected, it may be a bare id → normalize in config (accept full path, bare id, or JDBC URL `…;httpPath=…;`). |
| `app.yaml` present | Overrides bundle `config.env` for every target → sqa/prd silently ran the dev catalog. Delete it or keep it free of env-specific values. Never keep both `app.yaml` and `app.yml` (runtime reads one; ambiguous). |
| Changing the warehouse resource "has no effect" | The effective deployed config (often a lingering `app.yaml` or stale resource) still injects the old one. Inspect the deployed config, redeploy. |
| Exact env names | Typos like `_qa` vs `_sqa`, `_prod` vs `_prd` in catalog names cause empty data, not errors. |
| `warehouse_id` must resolve per target | Shared deploy templates usually don't pass `--var`; put the value in the target. |

### 5.3 Config-layer guards (put these in `config.ts`)

- Resolve every catalog/schema/table/key from env with sensible defaults; never hardcode coordinates elsewhere.
- Validate identifiers at import (fail fast).
- Normalize the HTTP path.
- Refuse `USE_FAKE_DB=true` unless running under the test harness (`VITEST`, `NODE_ENV=test`, or the mock e2e flag `E2E=true` — see §11).
- Refuse local Databricks mode without a real PAT.
- Validate required primary-key env vars at startup (a stale/empty PK var produced empty ids).
- Log the effective catalog/schema/warehouse at boot (not the token) — the fastest way to catch precedence bugs.

### 5.4 Env var reference (generic)

| Var | Purpose |
|---|---|
| `DATABRICKS_HOST` | Workspace host (platform-provided when deployed). |
| `DATABRICKS_HTTP_PATH` | Warehouse path (normalize). |
| `DATABRICKS_APP_PORT` | Port to bind (platform-provided). |
| `APP_ENV` | `local` enables PAT fallback + local-only test hooks. |
| `DEPLOY_ENV` | dev/sqa/prd — drives env-specific behavior (groups, links). |
| `DATABRICKS_CATALOG` / `DATABRICKS_SCHEMA` / `<ENTITY>_TABLE` | Table coordinates. |
| `DATABRICKS_TOKEN`, `DEV_USER_EMAIL` | Local only. |
| `USE_FAKE_DB` | Tests only (guarded). |
| `DB_PROVIDER` | Optional alternate provider (e.g., Postgres for self-hosting) — disables OBO on that path. |
| `WARM_SESSION_CACHE`, `WARM_SESSION_TTL_MS` | Opt-in per-user session reuse (§8). |
| `SQL_TIMING` | Opt-in per-statement timing logs. |

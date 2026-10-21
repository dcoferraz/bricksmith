# Databricks Apps: field-tested knowledge base

**What this is:** a product-agnostic extraction of everything learned building, deploying, securing, testing, and operating a production Databricks App (React + Node/Express API on Unity Catalog, deployed with a Databricks Asset Bundle, promoted dev → sqa → prd by a CI/CD pipeline) with heavy AI-agent involvement.

**Intended use:** the knowledge payload behind bricksmith, so an agent can build and run a Databricks App correctly the first time. The files in `references/` are generated from this document.

**Conventions:** `<app>`, `<env>`, `<catalog>`, `<schema>`, `<warehouse-id>`, `<group>` are placeholders. Every rule below came from a real failure or decision in a production app — none are speculative unless marked *(unverified)*.

## Contents

1. [The ten laws (TL;DR for agents)](#1-the-ten-laws-tldr-for-agents)
2. [Mental model: what a Databricks App actually is](#2-mental-model-what-a-databricks-app-actually-is)
3. [Reference architecture](#3-reference-architecture)
4. [Identity & security (OBO)](#4-identity--security-obo)
5. [Configuration: `databricks.yml`, `app.yaml`, env vars](#5-configuration-databricksyml-appyaml-env-vars)
6. [Build & deploy mechanics](#6-build--deploy-mechanics)
7. [CI/CD pipelines](#7-cicd-pipelines)
8. [Runtime resilience & performance](#8-runtime-resilience--performance)
9. [Data-layer patterns](#9-data-layer-patterns)
10. [Frontend patterns](#10-frontend-patterns)
11. [Testing strategy](#11-testing-strategy)
12. [Local development & locked-down networks](#12-local-development--locked-down-networks)
13. [Master triage table: symptom → cause → fix](#13-master-triage-table-symptom--cause--fix)
14. [Diagnostic order for "users see no data"](#14-diagnostic-order-for-users-see-no-data)
15. [Making it agent-friendly: skills, guardrails, memory](#15-making-it-agent-friendly-skills-guardrails-memory)
16. [Blueprint: a "Databricks App" AI skill](#16-blueprint-a-databricks-app-ai-skill)

---

## 1. The ten laws (TL;DR for agents)

1. **Run every query as the user (OBO).** The app's service principal gets `CAN_USE` on the warehouse and nothing else. Unity Catalog is the security boundary.
2. **Declaring `user_api_scopes: [sql]` is necessary, not sufficient.** It must sit at the app level of the bundle (not under `config:`), the workspace must allow the scope, and user-token passthrough must be enabled. Verify with `effective_user_api_scopes`.
3. **Three independent gates must all be open:** App `CAN_USE` (who may open the app), warehouse `CAN_USE` (who may run compute), Unity Catalog grants (who may read/write the tables). Missing any one looks like "the app is broken".
4. **Deploy through the bundle, not native git source.** A git-snapshot deploy only sees tracked files; `dist/` and `node_modules/` are gitignored → "App process did not start within 10 minutes."
5. **An App deploy = `bundle deploy` + `bundle run`.** `deploy` only uploads; `run` actually starts a new version. Jobs don't need the second step; Apps do.
6. **One source of runtime config.** A committed `app.yaml` overrides the bundle's per-target `config.env` — every environment silently runs the dev catalog. Keep env values in bundle targets.
7. **Normalize the warehouse HTTP path.** Injected values may be a bare id; the SQL driver needs `/sql/1.0/warehouses/<id>` or every query 404s.
8. **Expect warehouse cold starts and handshake races.** Retry session-open and "SparkSession not attached" errors with backoff (safe — nothing executed), and tell the user the warehouse is waking.
9. **Mock databases are test-only.** Refuse to boot in fake/mock mode outside the test harness, or a demo will eventually ship to production talking to nothing.
10. **Codify every trap as a check.** Each deploy failure became a lint rule in a preflight script; agents run the check before the first pipeline run instead of rediscovering the failure.

## 2. Mental model: what a Databricks App actually is

| Concept | Reality |
|---|---|
| Hosting | One container per app, behind a Databricks identity-aware proxy (SSO). The app binds `0.0.0.0:$DATABRICKS_APP_PORT`. |
| Identity in | Proxy injects headers on every request: `X-Forwarded-Access-Token` (user OAuth token, scoped by `user_api_scopes`), `X-Forwarded-Email`, `X-Forwarded-User`, `X-Forwarded-Preferred-Username`. No full display name is forwarded — derive it from the email or call SCIM `/Me`. |
| Identity of the app | Each app gets its own service principal (SP). Use it for nothing data-related. |
| Resources | Declared bindings (e.g., `sql_warehouse` with `permission: CAN_USE`) grant the SP access and can inject env values. |
| Runtime build | Python apps: runtime installs `requirements.txt`. Node apps: you must install/build — either ship artifacts or run `npm ci && npm run build` in the start command. |
| Name | Apps are keyed by name, which is immutable. Renaming = new app resource; decommission the old one. |
| Logs | `databricks apps logs <app>` / UI Logs tab are served from the Apps domain — a workspace ingress network policy can block them (403) even when the core API works. |

Two artifacts drive everything:

- **`databricks.yml`** (Asset Bundle): the app resource, its scopes, resources, ACLs, per-target config.
- **`app.yaml`** (optional runtime file): command + env. **If present it wins over bundle config** — which is why we deleted it (see §5).

## 3. Reference architecture

```text
User (SSO) ─▶ Databricks Apps proxy ─▶ Node/Express (same container, serves React + /api)
               │ injects X-Forwarded-Access-Token          │
               │                                           ▼
               └──────────────────────────────▶ SQL Warehouse ── Unity Catalog
                                               (statement runs AS THE USER)
```

### Request lifecycle

```text
request → oboMiddleware (token + email → req.userSql)
        → requireGroupAccess (coarse "may use the app" gate)
        → route → service
        → withUserSql (per-request session authenticated with the USER's token)
            → requireCap (mutations only; same session as the write)
        → Unity Catalog authorizes → response (data + fresh permissions)
        → errorHandler (UC PERMISSION_DENIED → 403 PERMISSION_CHANGED; never leaks SQL/token)
```

### Repo split (recommended)

| Repo | Owns |
|---|---|
| App repo | Node API + React UI, bundle, CI/CD. Consumer of tables; assumes no grants. |
| Data-product repo | dbt models + contracts (DDL migrations) + data-quality jobs + UC grants. |

### Server layout that worked

```text
server/src/
  config.ts        env resolution, identifier validation, http-path normalization, mode guards
  types.ts         UserSqlContext, TablePermissions, ErrorCode (mirrored in client)
  middleware/      obo.ts · requireGroupAccess.ts · errorHandler.ts
  db/              userClient.ts (provider facade) · databricksClient.ts · fakeDb.ts
                   warmSessionCache.ts · bitemporal.ts
  services/        permissions.ts (incl. requireCap) · access.ts · warehouseStatus.ts · <entity>.ts
  routes/          permissions.ts · warehouse.ts · <entity>.ts (mounted /api/<kebab>)
  validation/      zod schemas
```

## 4. Identity & security (OBO)

### 4.1 Non-negotiables

- **No app-level data connection.** A `@databricks/sql` client is created per request with the user's token; connections are never pooled across users (pooling leaks identity).
- **Token hygiene:** request-scoped only — never log, return, persist, or send it to the browser.
- The browser talks only to same-origin `/api` and never holds a Databricks credential.
- **Parameterized SQL only:** bind values as `namedParameters`; identifiers come from config, are validated against `^[A-Za-z_][A-Za-z0-9_]*$`, and back-tick quoted.
- **Defense in depth:** UI hiding + server `requireCap` + UC enforcement. UC is the authority.
- **Never bake a deploy token into the app env.** A CI deploy that sets `*_TOKEN` in `config.env` makes the running app act as the deployer and silently bypasses OBO.

### 4.2 OBO middleware (shape)

```ts
const allowFallback = config.isLocal || config.useFakeDb; // never true when deployed
const token = req.header('X-Forwarded-Access-Token') ?? (allowFallback ? config.localToken : undefined);
const email = req.header('X-Forwarded-Email') ?? req.header('X-Forwarded-Preferred-Username')
  ?? (allowFallback ? config.devUserEmail : undefined);
if (!token || !email) return res.status(401).json({ error: 'MISSING_OBO_TOKEN' });
req.userSql = { token, email, name: displayNameFromEmail(email) };
```

Local dev: `APP_ENV=local` enables a personal-access-token fallback. The app refuses to start locally with a missing/placeholder PAT rather than boot into a guaranteed-failing state.

### 4.3 Capability discovery

- Discover per table, as the user: `SHOW GRANTS ON TABLE …` (or `information_schema`), normalized into `{ canRead, canCreate, canUpdate, canDelete, checkedAt }`. `MODIFY` implies all three writes; `ALL PRIVILEGES` implies everything.
- Every data response carries fresh `permissions`, so the UI re-hides affordances without polling.
- `requireCap('canUpdate')` re-checks before every mutation → fast `403 PERMISSION_CHANGED`. Run the check inside the mutation's own OBO session (see §8.5 "one OBO session per mutation"), not as a separate round-trip.
- Users also need `USE CATALOG` / `USE SCHEMA` on the parents — include them in the grant bundle.
- Grant to groups, never individuals.

### 4.4 Group-based entitlement gates (on top of UC)

Many enterprises require an AD-group check in addition to table grants. Pattern that worked:

| Gate | Where | Effect |
|---|---|---|
| Read group — "may use the app" | `requireGroupAccess` mounted on `/api` after OBO (and after the un-gated `/api/permissions` + warehouse-status routes) | Non-members get `403 NO_ACCESS`; client renders a full-page access-denied. |
| Write group — "may mutate" | Inside `discoverPermissions`: write caps survive only if in write group AND UC grants write | Read-only users automatically get the view-only experience; server enforcement and UI flow through one function. |

Lessons:

- Use `SELECT is_account_group_member(:group)` under the user's token, **not** workspace SCIM `/Me`. SCIM `/Me` omits account-level groups synced via identity federation → correct members were always reported as non-members.
- The read gate must also admit the write group — otherwise write-only members get locked out.
- Cache membership briefly (≈60 s) to avoid a SQL round-trip per request.
- Fail-open on lookup errors is a deliberate choice (UC still gates data); make it a flag.
- Gate off on non-OBO paths (local/fake/alternate DB) unless explicitly forced.
- One source of truth for group names: bundle variables (`app_group_read`, `app_group_write`) feed both the App ACL (`permissions: CAN_USE`) and the API env vars. Groups must already exist and be synced into each workspace before deploy.
- No "grant-all-write" bypass flags, even temporarily — one was shipped for testing and had to be reverted because it invalidated entitlement testing.

### 4.5 Scopes checklist

```yaml
user_api_scopes: [sql]   # bundle: app-level field, sibling of source_code_path
```

Then verify after deploy:

```bash
databricks apps get <app> -p <profile>   # effective_user_api_scopes must include "sql"
```

If it shows only `iam.access-control:read` / `iam.current-user:read`: user-token passthrough is not enabled or the scope is not allowed in the workspace (`allowedAppsUserApiScopes`) → platform/admin action, not a code bug. Users may also need to consent on first access.

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

## 6. Build & deploy mechanics

### 6.1 Deploy mechanisms compared

| Mechanism | How | Verdict |
|---|---|---|
| Native git source (`git_source`, mode SNAPSHOT) | Databricks clones a branch | ❌ Only tracked files; no `dist/`, no `node_modules/` → won't start in 10 min. CI build output is wasted. |
| `databricks sync . <ws-path>` + `databricks apps deploy <app> --source-code-path <ws-path>` | Manual / GitHub Actions | ✅ Works; good manual fallback. Watch for deploying a stale workspace snapshot. |
| Asset Bundle: `databricks bundle deploy -t <env>` then `databricks bundle run <resource-key> -t <env>` | CI | ✅ **Recommended.** Config-as-code, per-target env, ACLs, resources. |

### 6.2 Making a Node app start

The container needs build output and dependencies at runtime. Options we evaluated:

- **(A) Commit Linux-built artifacts to a deploy branch.** Works, but `node_modules` must be Linux-built (native addons such as the SQL driver's `lz4`) — never commit Windows `node_modules`.
- **(B) Ship CI-built artifacts via bundle sync includes.**
- **(C) Build at start (chosen):** `command: sh -c "npm ci && npm run build && node server/dist/index.js"`. Requires a committed `package-lock.json` and registry reachability from the Databricks cloud. The build needs devDependencies (TypeScript, Vite); if the runtime sets `NODE_ENV=production`, plain `npm ci` skips them — `npm ci --include=dev` is the defensive form *(unverified on the Apps runtime)*.

### 6.3 npm traps (all hit in production)

| Trap | Symptom | Fix |
|---|---|---|
| Corporate registry pinned in committed `.npmrc` | "Installing packages" phase hangs > 10 min — the internal mirror isn't routable from Databricks cloud | Don't pin the registry in `.npmrc`; set `npm_config_registry` per context (CI pipeline env, Dockerfile `ENV`, user-level config on the corp network). Keep only retry tuning in `.npmrc`. |
| `--omit=optional` / `NPM_CONFIG_OMIT=optional` / `omit=optional` in `.npmrc` | "Error installing packages" (esbuild/rollup Linux binaries dropped; postinstall then tries public registry) and local `vite` breaks (`@rollup/rollup-<os>-<arch>` missing) | Never omit optional deps. The SQL driver's native `lz4` soft-fails gracefully (falls back to uncompressed Arrow). |
| No lockfile | `npm ci` fails | Commit `package-lock.json`. |
| Stale snapshot deployed | "Error installing packages … check /logz" with code you already fixed | Verify the deployed source revision before debugging. |

### 6.4 Other build-time traps

- **DBR/runtime tag file** must be the image tag form `15.4-LTS`; `15.4.x-scala2.12` → `ImagePullBackOff`.
- **CLI floor `>= 0.239.0`** (older CLIs parse the bundle and silently drop `resources.apps`).
- **App name is immutable.** If an app was created manually, the first bundle deploy needs `databricks bundle deployment bind <resource-key> <app-name> --target <env> --auto-approve`.
- **Driver TypeScript typing:** `@databricks/sql` doesn't export a named session interface from its root in some versions — derive it: `type DBSQLSession = Awaited<ReturnType<DBSQLClient['openSession']>>`.
- **Express request augmentation:** use a global declaration merge (`declare global { namespace Express { interface Request { userSql: … } } }`) instead of a custom `interface extends Request`, which breaks handler overloads.
- **Version stamping:** bake `<version>+<git-sha>` into `dist/version.json`; the client polls it and shows "A new version is available — Refresh". Enforce a version bump per PR with a CI guard.

## 7. CI/CD pipelines

### 7.1 Pipeline shape (branch → environment)

| Branch | Env | Notes |
|---|---|---|
| `dev` | dev | auto on merge |
| `sqa` | sqa | auto on merge |
| `main` | prd | change-approval stage first |

Stages: **Prebuild** (mandatory security scan → `npm ci` → lint → test → build, via internal mirror; export runtime tag) → **Deploy** (shared bundle-deploy template: `bundle deploy` + `bundle run`).

### 7.2 Lessons from the pipeline

- **Shared deploy templates may only `bundle run` apps they recognize.** Ours keyed off a small answers file (`include_databricks_app: 'yes'`, `app_name`, `databricks_app_type`) and composed the resource key as `<type>_<app_name>_app`. Missing file or mismatched key ⇒ deploys, never starts. A hand-written "Deploy_App" stage was the stopgap; it was removed once the template handled it (otherwise: duplicate start + duplicate token).
- **Hardcode the branch per environment input set.** Event-derived expressions (e.g., the trigger's branch) resolve to `null` on a manual re-run → `git fetch refs/heads/null` (exit 128).
- **Pipelines/input sets live in the repo; triggers live in the CI UI** (Git-Experience model). Pushing pipeline YAML doesn't create a pipeline — import once, then it self-updates from Git.
- **Protected branches:** the first deploy is the PR-merge push itself (no empty-commit triggers).
- **One deploy token per workspace**, stored as a CI secret. Its principal needs `CAN_MANAGE` on the app + write on the bundle root — no table grants.
- **Secret bound to the wrong environment's secrets manager** ⇒ `Failed to decrypt secret … sts:AssumeRole 403` at deploy initialization — a platform rebind, not a repo bug.
- **Delegate selector typos/naming drift** ⇒ "no eligible delegates". Confirm exact selector names per environment with the platform.
- **CI pods often have no OS-package egress** ⇒ `playwright install --with-deps` fails. Use a prebuilt image, or keep live e2e on dev/local.
- **Pre-push hook and CI must run the same commands** (lint drift caused "green locally, red in CI").
- **Shared workspace across targets** (dev and prd on the same host) means the dev pipeline deploys into prod. Separate workspaces per env.
- **Proof of green:** deploy log shows the app run succeeded and `databricks apps get <app>` shows `SUCCEEDED` + `sql` in `effective_user_api_scopes`.

### 7.3 Multi-app repos: one linear pipeline, changed apps only

For a repo with several apps: one pipeline `dev → approval → sqa → change-approval → prd`, with a `Detect_Changes` stage emitting `CHANGED_APPS`. Rules: `apps/<name>/` → that app; shared paths → all apps; a `FORCE_APPS` runtime input for manual runs. Diff base = a `deployed/prd` git tag moved after a successful prod deploy — not `HEAD~1`, which silently drops an app rejected at a gate. Every bundle needs an `sqa` target. *(Design generated and script-tested; not yet run end-to-end.)*

### 7.4 GitHub Actions fallback

`workflow_dispatch`-only workflow: `databricks/setup-cli` → `databricks current-user me` (OAuth M2M via `DATABRICKS_HOST` / `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`) → `databricks sync` → `databricks apps deploy`. `concurrency` group with `cancel-in-progress`.

## 8. Runtime resilience & performance

### 8.1 Where time goes under OBO

- Per request: connect + openSession handshake (dominant), then statement exec/fetch.
- A single-row Delta INSERT commit measured ~1.5–1.8 s even after optimization; the remaining real win was avoiding warehouse cold starts (auto-stop between requests).
- Cold boot of a classic warehouse: 30 s – 5 min. **Serverless warehouses removed most first-hit transients — prefer them for apps.**

### 8.2 Retry the safe things

Two transient classes appear before any user SQL executes, so retrying is safe even for writes:

| Phase | Typical messages | Policy that worked |
|---|---|---|
| Session open | "Failed to open new session … Couldn't create directory …", "sparkSession is null" | 4 attempts, backoff 400/900/1800 ms; new client per attempt |
| First statement | "Session … is not fully initialized yet: no SparkSession is attached" | same backoff, retry the statement |

Also: log a warning for errors that mention session/warehouse but weren't classified transient — that's how new variants are found. Redact token-like strings in error logs. Tag failures with a short statement label (never bound values).

### 8.3 Warm per-user session cache (opt-in)

Reuse a live session across a user's page/sort/filter requests to skip the handshake:

- Key = `sha256(token)` — never shared across identities, token never stored in plaintext.
- Idle TTL (~60 s), LRU size bound, discard on any error.
- Same-user concurrency → ephemeral extra session (one session can't run two statements).

### 8.4 Tell the user the warehouse is waking

- `GET /api/warehouse/status` calls `GET /api/2.0/sql/warehouses/{id}` with the user's token (a user with `CAN_USE` can read state), 5 s timeout, never throws — degrades to `UNKNOWN`. Not behind the group gate.
- Client polls every 5 s while not `RUNNING`, 30 s while `RUNNING`, re-checks on tab visibility.
- A non-blocking banner ("responses may be delayed while the warehouse starts") + a status dot (green RUNNING / amber STARTING-STOPPING-UNKNOWN / red STOPPED-DELETED). Dismissible.
- Local-only hook to force a state for testing the banner.

### 8.5 Cheap wins

- Lazy-load the SQL driver (≈1.3 s import) so tests/alternate providers never pay for it.
- Disable per-client driver telemetry (`telemetryEnabled: false`) when creating a client per request.
- Driver logger at WARN so per-request lifecycle noise doesn't bury app logs.
- One OBO session per mutation, including master-detail saves (combined endpoint) — not one per child row.
- Server-side pagination, latest-updated-first, filters pushed into SQL; keep a kill-switch flag until verified against the deployed schema.
- Cache dropdown option lists client-side, but treat cache as untrusted: version it, refetch when empty or wrong-shaped, normalize shape before use.

## 9. Data-layer patterns

### 9.1 Ownership split

| Layer | Owns |
|---|---|
| Contracts / DDL migrations | Writable base tables + grants |
| dbt | Read-side views only (`stage_` → `prep_` → `vw_`). Never writes app-owned tables (would overwrite user edits). |
| App (OBO CRUD) | Row data in its UI-managed tables |

Every table/lookup the app queries live must exist in bootstrap DDL — not just in the fake DB seed (an empty search was caused by a table that existed only in the mock).

### 9.2 Bi-temporal writes for auditability

- An update appends a new version; reads filter the current-version flag; delete is logical (expire current, insert nothing).
- Standard audit columns: row uid, checksum, business start/end, system start/end, current indicator, last-update process id, source system code. Open-ended sentinel `9999-12-31`.
- `row_uid = md5(concat_ws('|', <entity key cols>))` (stable across versions); `checksum = sha1(concat_ws('|', <non-key data cols>))` — same string ⇒ same hash in Node and Spark, so app writes == SQL backfill == dbt. Equal checksum ⇒ update is a no-op.
- `concat_ws` **skips NULLs**, so `('a', NULL)` and `(NULL, 'a')` hash the same and a real edit looks like a no-op. Wrap every column: `coalesce(CAST(col AS STRING), '#NULL#')`. Cast to `STRING` the same way everywhere (Spark renders `DOUBLE 10` as `10.0`; JS renders `10`) — simplest is to compute both hashes in SQL from the typed values so app, backfill, and dbt share one expression.
- One shared helper owns the audit columns, hashing, atomic expire+insert `MERGE`, and Delta optimistic-concurrency retry. Services never hand-roll INSERT/UPDATE/DELETE.
- Keep `created_by`/`updated_by` (who) alongside process id (which job).

Bugs that taught this: a read missing the current-flag filter showed phantom duplicates; an update that inserted without expiring produced two "current" rows; identity-only PK tables need a stable entity key before going bi-temporal or each version forks a new id.

### 9.3 SQL dialect gotchas on Databricks SQL

- `LIKE … ESCAPE '\'` parsed differently across warehouses → use `ESCAPE '!'`.
- Push search into SQL with case-insensitive predicates; never filter in JS after a blind `LIMIT 500`.
- Keep warehouse column types aligned with API types (an `INT` treated as boolean ⇒ 500).
- Watch join fan-out; enforce response grain.
- Normalize spreadsheet date serials (Excel numbers) before ISO-date validation in bulk upload.
- DDL runner via Statement Execution REST API: one statement per call, UTF-8 byte body (string bodies with unicode comments returned 400).

## 10. Frontend patterns

- React + TypeScript + Vite + Tailwind (utility classes only), React Query for server state, react-hook-form + zod for forms, hand-rolled dialogs/toasts (no component libraries).
- **Hide, don't disable:** `PermissionGate` returns `null` when the capability is missing.
- Read-only users: Add/Delete hidden, Edit icon becomes View, same dialog in read-only mode.
- Central `403 PERMISSION_CHANGED` flow: API client catches it → refresh permissions → toast ("your access changed") → affordances re-hide. Components must not swallow it.
- Mirror `TablePermissions` and `ErrorCode` types between server and client.
- Dates `YYYY-MM-DD`, timestamps `YYYY-MM-DD HH:mm`; never locale formats.
- Modal busy UX: `<fieldset disabled={busy}>`, overlay spinner, block Escape/backdrop close while saving. Don't put interactive toggles (accordions) inside a disabled fieldset.
- **Flicker/infinite-remount trap:** a React Query `queryFn` must never trigger state that unmounts its own consumer (e.g., toggling a page-level loading gate). Use background refreshes.
- Gate modal rendering until option lists are loaded; show errors from the server's structured `ErrorCode` + message rather than generic failures.

## 11. Testing strategy

| Layer | Tool | Notes |
|---|---|---|
| Unit (server) | Vitest on the host | Production image has no devDeps. Dummy non-fake env in `vitest.config.ts`; each service test opts into fake mode per file via `vi.hoisted(() => { process.env.USE_FAKE_DB = 'true' })` — never globally (it flips OBO fallback and breaks the 401 test). |
| Fake DB | In-memory, table-aware | Interprets only the app's own statement shapes; mirrors bi-temporal statements; `FAKE_GRANTS` picks a permission scenario. Refused outside tests. |
| E2E (mock) | Playwright → `start:e2e` (`E2E=true`) | Deterministic UI journeys. Trace/video/screenshot on retain-on-failure (always-on races Windows file locks). |
| E2E (live) | Playwright against a dev warehouse | Only way to prove OBO, scopes, grants, warehouse binding. Make fixtures explicit and await refreshes before chaining actions. |
| Contract | Snapshot of feed views asserted by dbt and the app | Catches schema drift across repos. |
| Timing | Browser-driven harness + `SQL_TIMING` | Separates browser, API, handshake, and statement time. |
| Reporting | Generated self-contained HTML dashboard | Plain-English test descriptions + screenshots; regenerate when tests change. |

**Rule:** mock mode never validates authorization, scopes, warehouse binding, or UC grants.

## 12. Local development & locked-down networks

- **Corporate registries:** public npm/PyPI often blocked. A mid-install 403 from the public registry can corrupt an existing `node_modules` — configure the mirror before installing. Symptom of a missed re-point is a 403/404/timeout against the public host, not "package not found".
- **TLS-inspecting proxy in Docker:** remove the `# syntax=docker/dockerfile:1` directive (frontend pull fails `x509 unknown CA`); export host root CAs to a PEM and set `NODE_EXTRA_CA_CERTS` (Node) / `PIP_CERT`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` (Python). Keep verification ON.
- **Host install-script blockers** can leave esbuild unlinked or empty `@types/` folders. These are host artifacts, not code defects — validate in a clean container or via the language service + unit tests; never paper over with empty type placeholders.
- Align esbuild versions across client (Vite) and server (tsx) to avoid dual native-binary conflicts.
- **Run paths an agent can set up:** {local | docker} × {Databricks | alternate DB}. A zero-dependency setup wizard writes `server/.env` from non-secret answers; the user pastes the PAT themselves.
- **Verifying a deployed app in a browser:** attach to an already-signed-in browser over CDP; SSO and device-trust policies can block automation in fresh profiles — separate those failures from app bugs.
- Legacy seed scripts may be UTF-16 — detect encoding before parsing.

## 13. Master triage table: symptom → cause → fix

| Symptom | Root cause | Fix |
|---|---|---|
| "App process did not start within 10 minutes" | git-source deploy: no build output / deps | Bundle deploy + build in start command |
| Deploy succeeds, app never starts | `bundle run` not executed (template didn't recognize app; resource-key mismatch) | Answers file + key `<type>_<app_name>_app`, or explicit `bundle run` |
| "Installing packages" hangs | Registry pinned to an internal mirror unreachable from Databricks cloud | Unpin `.npmrc`; set registry per context |
| "Error installing packages" | `omit=optional` dropped native binaries / stale snapshot | Remove omit; verify deployed revision |
| `ImagePullBackOff` | Wrong runtime tag format | `15.4-LTS` style |
| App ignores bundle app resource | CLI < 0.239.0 | Raise CLI floor |
| "Missing required environment variable: DATABRICKS_HTTP_PATH" | `value_from` not injected | Literal `/sql/1.0/warehouses/${var.warehouse_id}` |
| Every query 404 → UI 500 | Bare warehouse id as HTTP path | Normalize in config |
| Blank user name, all tables empty, `/api/permissions` 500 | `sql` scope not effective | Passthrough + scope grant; scopes at app level |
| Thrift `403` on connect | User lacks warehouse `CAN_USE` / UC entitlement | Grant via owner/`MANAGE` principal |
| sqa/prd show dev data or nothing | Committed `app.yaml` overrides bundle env / catalog typo | Delete `app.yaml`; log effective config |
| Warehouse change has no effect | Old resource/app.yaml still effective | Inspect deployed config, redeploy |
| Correct group members denied | SCIM `/Me` omits account-level groups | `is_account_group_member()` via OBO |
| Write users locked out | Read gate doesn't admit write group | Admit both groups |
| Intermittent empty dropdowns | Transient session-open failures | Handshake retry + options cache + gated render |
| First request after idle fails | Cold warehouse / SparkSession not attached | Statement retry, serverless warehouse, status banner |
| `refs/heads/null` exit 128 on re-run | Trigger-branch expression null on manual run | Hardcode branch per input set |
| `sts:AssumeRole 403` decrypting token | Secret bound to wrong env | Platform rebind |
| "No eligible delegates" | Selector name mismatch | Confirm selector |
| `playwright install` fails in CI | No apt egress | Prebuilt image / dev-only e2e |
| App logs 403 from the corporate network | Ingress policy blocks Apps domain | Allowlist Apps log domain |
| Phantom duplicate rows after edit | Missing current-version filter | Filter current flag in real + fake DB |
| Two "current" rows | Insert without expire | Atomic expire+insert MERGE |
| Null PK on UI create | Identity column/contract tables missing in bootstrap | Add to DDL; test inserts against real schema |
| Search silently incomplete | JS filter after `LIMIT 500`, case-sensitive | Push filters into SQL, case-insensitive |
| `LIKE` search fails on some warehouses | Backslash escape | `ESCAPE '!'` |

## 14. Diagnostic order for "users see no data"

Check in this order; each layer fails independently:

1. **App access** — is the user in a group with App `CAN_USE`? Does the API read-gate admit them?
2. **OBO scope & identity** — `effective_user_api_scopes` contains `sql`? Forwarded email present?
3. **Warehouse** — configured id/path correct for this env? User has `CAN_USE`? State RUNNING?
4. **Unity Catalog** — `USE CATALOG`, `USE SCHEMA`, `SELECT` (and `MODIFY` for writes) on the table.
5. **Data** — table exists in this env's catalog, seeded reference data present, ingestion ran.
6. **Query/UI** — response shape matches client expectation; cache not stale; cold-start retries.

Never collect or log tokens, and never change grants autonomously — remediation for layers 1–4 is usually an admin action; say so.

## 15. Making it agent-friendly: skills, guardrails, memory

What actually made agents effective on this codebase:

### 15.1 Guardrail docs agents read first

- Root navigation map (`AGENTS.md`) + per-area agent rule files (nested `AGENTS.md`) with numbered non-negotiable rules (OBO everywhere, UC is the boundary, hide-don't-disable, token hygiene, parameterized SQL, config not hardcode, version bump per PR).
- Decision logs (architecture + frontend) and a build/deploy gotchas catalog — "why it's built this way" so agents don't re-derive or undo decisions.
- A data-model & modals snapshot that must change in the same PR as any field change (lock-step rule).

### 15.2 Durable memory loop (knowledge database)

Read-first → do the work → write back. Entries in four folders: **explorations** (what is true), **solutions** (what we did), **errors** (Symptom → Root cause → Fix → Prevention), **decisions** (why), each with `status` (verified / tentative / superseded) and grounded `sources`. Result: ~70 error entries and ~100 solution entries an agent can search before touching anything.

### 15.3 Skills that worked (generic names)

| Skill | What it does | Why it helps agents |
|---|---|---|
| scaffold-app | Interview → validated `app-spec.json` (entities, fields, keys, dropdown sources, delete mode, per-env catalogs/warehouses/groups) → zero-dependency generator emits OBO server, gated React screens, bundle, DDL, tests that pass out of the box | Encodes all §4–§11 patterns into generated code; spec is reviewable before generation |
| app-pipelines (+ `check` mode) | Infers app name/runtime/resource key/envs from the bundle → writes per-env pipelines + input sets + README of platform asks; `check` lints the ~25 deploy traps in §15.4 | Turns every past failure into a pre-run lint (see §15.4) |
| run-locally / setup | Prereq checks → install → interview (non-secret) → write `.env` → start → verify `/healthz` | Removes the most common "it doesn't run" loop |
| customize-entity | Wizard for add/remove field/column, required/lookup/validation; plans ~8 files across server + client, confirms, edits, validates | Field changes touch many layers; the wizard keeps them consistent |
| audit-server / audit-client | Severity-ranked findings vs the non-negotiables; read-only until user confirms fixes | Cheap, repeatable compliance check after agent edits |
| discover-legacy-app | Deterministic scanner with file:line evidence → journeys (screen → route → API → proc → table) → parity checklist → migration backlog | Front-loads understanding before migration work |
| best-of-N worktrees | N isolated git worktrees for competing attempts on the same hunk; test, rank, promote best, cleanup | Parallel agents without trampling each other (cap ~3; verify diffs/commits — truncated output happened) |
| browser testing (CDP) | Drive a real browser: console, network, screenshots, a11y snapshots | Agents can verify UI fixes themselves |

### 15.4 Preflight rules (codified traps)

`check` exits non-zero on any ERROR. Each rule = one real failure:

| Rule | Sev | Detects |
|---|---|---|
| answers-file missing/keys | ERROR | Shared template won't `bundle run` |
| resource-key mismatch | ERROR | Deploys, never starts |
| cli-floor | ERROR | `resources.apps` silently ignored |
| `valueFrom` in bundle | ERROR | Wrong schema spelling |
| `user_api_scopes` missing / under `config:` | ERROR | OBO SQL fails |
| no `sql_warehouse` resource | WARN | SP lacks `CAN_USE` |
| `git_source` in bundle | ERROR | 10-minute start failure |
| Node app without build-at-start | WARN | No artifacts at runtime |
| `mode: development` on shared dev | WARN | App renamed, per-user paths |
| token/secret env with plain value | ERROR | App acts as deployer, bypasses OBO |
| two targets share a workspace host | WARN | Dev pipeline deploys into prod |
| personal `root_path` | ERROR | Ownership dies with the person |
| omit-optional anywhere | ERROR | Native binaries dropped |
| `app.yaml`/`app.yml` with env coordinates; both present | ERROR / WARN | Overrides bundle per-target env |
| runtime tag format | ERROR | `ImagePullBackOff` |
| no lockfile | ERROR | `npm ci` fails |
| registry pinned in `.npmrc` | ERROR | Install hangs in Databricks cloud |
| trigger-branch expression | ERROR | `refs/heads/null` on re-run |
| leftover placeholders | WARN | Unfinished secrets/values |
| e2e browser install in non-dev CI | WARN | No egress |
| env gate ≠ env | ERROR | Wrong scan gate |
| duplicate hand-written start stage | WARN | Double start / double token |
| prod without change approval | WARN | Governance gap |

**Platform-side failures the check cannot see** (say so, don't guess): secret binding, scope passthrough, the three independent grants, delegate eligibility, log ingress, unmanaged existing app (bind), branch protection.

**Rule for maintainers:** whenever a new repo-side deploy failure is root-caused, add a check rule and a knowledge entry in the same change.

### 15.5 Agent-workflow lessons

- Verify automated edits (diff + typecheck + tests) — an agent truncated a service file mid-edit.
- Investigate data → schema → config → UI, in that order, for "empty control" bugs.
- Review diffs for accidental reverts before "fixing" tests to match failures.
- Keep one test command shared by pre-push hook and CI.
- **Docs drift:** when a decision supersedes an older one, mark the old text superseded — stale guidance in agent-facing docs gets followed.

## 16. Blueprint: a "Databricks App" AI skill

Implemented in this repository (assembled from the pieces above; generic). The references are generated from this knowledge base by `scripts/sync-references.mjs`, so the two cannot drift.

```text
bricksmith/
  SKILL.md                     triggers + modes + hard rules
  references/
    laws.md                    §1
    obo-security.md            §2–§4
    bundle-reference.md        §5 annotated bundle + traps
    deploy-cicd.md             §6–§7
    resilience.md              §8
    app-patterns.md            §9–§12 data layer, frontend, testing, local dev
    triage.md                  §13 + §14
    agent-workflow.md          §15–§16 guardrails, preflight rules, this blueprint
    app-spec.md                spec format for scaffold mode
  scripts/
    scaffold.mjs               spec → app (zero-dependency generator; validates the spec first)
    preflight.mjs              §15.4 rules (zero-dependency, exits 1 on ERROR)
    verify-deploy.mjs          apps get → deployment SUCCEEDED + app RUNNING + effective scopes contain sql + env echo
    diagnose-access.mjs        walks §14 layers using the caller's own identity; read-only
    sync-references.mjs        regenerates references/ from docs/knowledge-base.md
  assets/
    app-spec.example.json
    templates/app/             server/client/test/bundle templates (scaffold mode)
```

The generated app is metadata-driven: `shared/entities.json` feeds one generic bi-temporal CRUD service, one route set (`/api/entities/<name>`), and one generic React page + dialog, so adding an entity or field is a spec change plus DDL, not new code.

### Modes

| Mode | Trigger phrases | Does |
|---|---|---|
| `scaffold` | "create a Databricks app for …" | Interview → spec → user reviews spec → generate → `npm install` → tests green → preflight clean |
| `check` | "will this deploy?", before first pipeline run | Run preflight, explain each finding + fix, list platform-side asks |
| `deploy` | "deploy to dev" | preflight → `bundle validate` → `bundle deploy` → `bundle run` → `verify-deploy` |
| `diagnose` | "users see no data", "app won't start" | §13 lookup + §14 layered walk; outputs root cause + owner |
| `extend` | "add a field/entity" | Plan all layers (spec/entities.json, DDL, tests, docs), confirm, edit, test |

**Hard rules for the skill:** never log/echo tokens; never grant permissions autonomously; never enable mock mode outside tests; never commit an env-specific `app.yaml`; always state when a fix is platform-owned.

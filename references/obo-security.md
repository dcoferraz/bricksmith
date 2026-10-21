# Mental model, architecture, identity & OBO security

> Generated from the knowledge base (§2, §3, §4) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

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

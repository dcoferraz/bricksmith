# AGENTS.md — {{APP_TITLE}}

Databricks App: React + Node/Express in one container, every query runs **as the user** (OBO) on a SQL
warehouse, Unity Catalog is the security boundary. Deployed with a Databricks Asset Bundle
(`databricks.yml`), promoted dev → sqa → prd.

## Non-negotiables

1. **OBO everywhere.** One `@databricks/sql` session per request with the user's token (`withUserSql`). Never pool across users. The app service principal has `CAN_USE` on the warehouse and nothing else.
2. **Unity Catalog is the boundary.** UI hiding + server `requireCap` are manners and speed; UC decides.
3. **Hide, don't disable.** `PermissionGate` renders nothing when a capability is missing.
4. **Token hygiene.** Request-scoped only. Never log, return, persist, or send it to the browser. Never put a deploy token in `config.env`.
5. **Parameterized SQL only.** Values via named parameters; identifiers from config, validated and back-tick quoted (`server/src/identifiers.ts`).
6. **Config, not hardcode.** Coordinates come from env (bundle targets). No `app.yaml` — it overrides the bundle for every target.
7. **One write path.** Entity tables are bi-temporal; only `server/src/db/bitemporal.ts` writes them. Reads filter `is_current = true`.
8. **Mock mode is a test fixture.** `USE_FAKE_DB` is refused outside the test harness.
9. **Lock-step changes.** A field change touches `shared/entities.json`, the DDL in `ddl/`, and tests in the same PR. Server and client `types.ts` are mirrored.
10. **Version bump per PR** (`package.json` version) — the client offers a refresh when the stamped version changes.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Unit tests (fake DB, no warehouse) | `npm test` |
| Typecheck | `npm run typecheck` |
| Local run | `cp server/.env.example server/.env` (paste your own PAT), then `npm run dev:server` + `npm run dev:client` |
| Deploy lint | `npm run preflight` |
| Deploy | `databricks bundle validate -t dev && databricks bundle deploy -t dev && databricks bundle run {{RESOURCE_KEY}} -t dev` |

## Layout

```text
shared/entities.json   entity metadata — the single source for server + client
server/src/            config · identifiers · middleware/ · db/ · services/ · routes/ · validation/
client/src/            App · api · schema · components/
ddl/<env>/             tables (001) + grants (002) — hand to the data-product owner / admin
databricks.yml         app resource, scopes, ACL, per-target env
```

Grants and platform settings (scope passthrough, group sync, warehouse permissions) are admin actions —
never change them from code or from an agent.

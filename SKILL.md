---
name: bricksmith
description: Build, check, deploy, diagnose, and extend Databricks Apps (React + Node/Express on a SQL warehouse, Unity Catalog, on-behalf-of-user auth, Databricks Asset Bundle, dev/sqa/prd). Use when the user asks to create or scaffold a Databricks App, asks "will this deploy?", wants to deploy an app to an environment, reports "users see no data" / "app won't start" / "App process did not start within 10 minutes", or wants to add a field or entity to a generated app.
---

# bricksmith

Field-tested rules for Databricks Apps that run every query **as the user** (OBO), with Unity Catalog as the
security boundary, deployed by an Asset Bundle. Every rule came from a real production failure.

## Hard rules (all modes)

- Never log, echo, persist, or ask for tokens. The user pastes their own PAT into `server/.env`.
- Never grant permissions or change platform settings yourself. Generate grant SQL; an admin runs it.
- Never enable `USE_FAKE_DB` outside tests. Mock mode never proves auth, scopes, warehouse binding, or grants.
- Never commit an `app.yaml` with env values: it overrides the bundle for every target.
- Always say when a fix is platform-owned (scopes passthrough, groups, warehouse/app/UC grants, CI secrets) and who owns it.
- Verify automated edits: diff + `npm run typecheck` + `npm test` before saying "done".

Read `references/laws.md` first in every mode. It is short.

## Modes

### scaffold — "create a Databricks app for …"

1. Interview per `references/app-spec.md` (checklist at the end). Write `app-spec.json`.
2. `node <skill>/scripts/scaffold.mjs --spec app-spec.json --validate-only`. Fix every ERROR. Report WARNs.
3. Show the spec to the user. Generate only after explicit approval:
   `node <skill>/scripts/scaffold.mjs --spec app-spec.json --out <dir>`
4. In `<dir>`: `npm install` (creates `package-lock.json` — must be committed), `npm test`, `npm run typecheck`, `npm run build`.
   All must pass before you continue. If install fails on a corporate network, see `references/app-patterns.md` §12.
5. `npm run preflight` → 0 errors.
6. Hand over the **Platform asks** checklist from the generated `README.md` and `ddl/<env>/*.sql` for the data owner.

What gets generated (metadata-driven — `shared/entities.json` drives server and client):
OBO middleware, group gates, per-request SQL sessions with cold-start retries, bi-temporal writes (atomic
expire+insert MERGE), capability discovery, warehouse-status banner, version banner, hide-don't-disable UI,
`databricks.yml` with dev/sqa/prd targets, DDL + grants per env, unit tests on an in-memory fake DB, `AGENTS.md`.

### check — "will this deploy?", before any first pipeline run

1. `node <skill>/scripts/preflight.mjs <repo> [--answers <ci-answers-file>]` (exits 1 on ERROR).
2. For each finding, explain cause + fix using `references/deploy-cicd.md` / `references/bundle-reference.md`.
3. List the platform-side items it prints — confirm them with the owner, do not guess.

### deploy — "deploy to dev"

1. `check` mode must be clean.
2. `databricks bundle validate -t <env>` → `databricks bundle deploy -t <env>` → `databricks bundle run <resource-key> -t <env>`.
   An App deploy is two verbs: `deploy` uploads, `run` starts.
   App created by hand before? First: `databricks bundle deployment bind <resource-key> <app-name> --target <env> --auto-approve`.
3. `node <skill>/scripts/verify-deploy.mjs --target <env> --dir <repo> [-p <profile>]`.
   Green = deployment SUCCEEDED, app RUNNING, `sql` in `effective_user_api_scopes`, warehouse bound.
4. If not green: `diagnose` mode. Never "fix" a platform failure in code.

Production deploys normally go through CI with change approval (`references/deploy-cicd.md` §7). Confirm before
deploying to `sqa`/`prd` from a workstation.

### diagnose — "users see no data", "app won't start", any error message

1. Exact symptom or message → look it up in `references/triage.md` §13 first.
2. "No data": `node <skill>/scripts/diagnose-access.mjs --target <env> --dir <repo> [-p <profile>]`.
   It walks the six layers in order (app access → OBO scope → warehouse → UC → data → query/UI) with the
   caller's identity, read-only. To diagnose a specific user, that user runs it with their own profile.
3. Start-up failures: `databricks apps logs <app>` (403 from the corporate network = log-domain ingress policy,
   not an app bug). Confirm the deployed source revision before debugging code you already fixed.
4. Report: root cause, evidence, fix, and **owner** (app team / data owner / workspace admin / platform).

### extend — "add a field", "add an entity"

Generated apps are metadata-driven. A field change is lock-step, in one change:

1. `shared/entities.json` (and `app-spec.json`) — the field/entity.
2. `ddl/<env>/001_tables.sql` — `ALTER TABLE … ADD COLUMN` (new file `003_…sql`) or the new table; grants for new tables.
3. Tests still pass (`entities.fake.test.ts` iterates all entities); add cases for new validation rules.
4. Server and client `types.ts` stay mirrored if you touch types.
5. Bump `package.json` version. Then `npm run check` and `npm run preflight`.

Plan all layers, confirm with the user, then edit. Existing rows keep `NULL` in a new column — checksums include
NULL markers, so the next real edit creates a new version correctly.

## Reference map

| File | Knowledge-base § | Read when |
|---|---|---|
| `references/laws.md` | §1 | always |
| `references/obo-security.md` | §2–§4 | identity, scopes, gates, permissions |
| `references/bundle-reference.md` | §5 | editing `databricks.yml`, env vars, `app.yaml` questions |
| `references/deploy-cicd.md` | §6–§7 | deploy failures, npm traps, pipelines |
| `references/resilience.md` | §8 | cold starts, retries, latency |
| `references/app-patterns.md` | §9–§12 | bi-temporal data, SQL gotchas, frontend, tests, local/corporate networks |
| `references/triage.md` | §13–§14 | any error or "no data" |
| `references/agent-workflow.md` | §15–§16 | preflight rule list, guardrail docs, memory loop |
| `references/app-spec.md` | — | scaffold / extend |

`§N` in references points at sections of `docs/knowledge-base.md`. `scripts/sync-references.mjs` regenerates the
references from it, so edit the knowledge base, not the references.

## Scripts (zero dependencies, Node ≥ 20)

| Script | Purpose |
|---|---|
| `scripts/scaffold.mjs` | spec → app; `--validate-only` checks the spec |
| `scripts/preflight.mjs` | repo-side deploy lint (copied into every generated app as `npm run preflight`) |
| `scripts/verify-deploy.mjs` | post-deploy proof of green (Databricks CLI) |
| `scripts/diagnose-access.mjs` | six-layer "no data" walk (Databricks CLI, read-only) |
| `scripts/sync-references.mjs` | maintainers: regenerate `references/` from the knowledge base |

Maintainer rule: when a new repo-side deploy failure is root-caused, add a preflight rule and a knowledge-base
entry in the same change.

# Triage table and "users see no data" order

> Generated from the knowledge base (§13, §14) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

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

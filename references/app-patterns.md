# Data layer, frontend, testing, local dev

> Generated from the knowledge base (§9, §10, §11, §12) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

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

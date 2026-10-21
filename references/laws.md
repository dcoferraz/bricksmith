# The ten laws

> Generated from the knowledge base (§1) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

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

# Build, deploy, and CI/CD

> Generated from the knowledge base (§6, §7) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

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

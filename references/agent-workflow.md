# Agent guardrails, preflight rules, skill blueprint

> Generated from the knowledge base (§15, §16) by `scripts/sync-references.mjs`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.

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

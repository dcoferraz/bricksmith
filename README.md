<p align="center">
  <img src="docs/banner.svg" alt="bricksmith: Databricks Apps that run as the user and deploy right the first time" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node 20 or newer">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/Databricks-Apps-FF3621?logo=databricks&logoColor=white" alt="Databricks Apps">
  <img src="https://img.shields.io/badge/auth-on--behalf--of--user-6f42c1" alt="On-behalf-of-user auth">
  <img src="https://img.shields.io/badge/status-early-orange" alt="Status: early">
</p>

# bricksmith

An agent skill for building Databricks Apps that actually run.

You describe the app. It generates a React + Node/Express app where every query runs as the signed-in user, Unity Catalog decides who sees what, and a Databricks Asset Bundle ships it from dev to sqa to prd.

Then it checks the repo before you deploy, verifies the deploy after, and walks you through "users see no data" when that happens. And it will :)

## Why I built this

I built a production Databricks App with AI agents writing a big part of the code.

The code came fast. Getting it to run took way longer, and almost none of it was code: a scope in the wrong place in the bundle, an `app.yaml` silently overriding every environment, a deploy that uploaded but never started, three different permission systems that each fail on their own.

The agents hit every one of those traps. And they kept hitting them after we wrote the fixes down.

They only stopped when a check failed on the mistake.

So every trap became a rule, every rule became a check, and the checks became this skill.

I wrote the full story, every trap and how we fixed it, as Chapter 1 of my series "Becoming a Super Engineer":

- [What AI Agents Taught Me About Building Databricks Apps](https://medium.com/@dcoferraz/what-ai-agents-taught-me-about-building-databricks-apps-0efad9dc26de) on Medium
- [Same article on dev.to](https://dev.to/dcoferraz/what-ai-agents-taught-me-about-building-databricks-apps-7ni)

## What it does

bricksmith has five modes. Your agent picks one from what you ask for.

| Mode | You say something like | What happens |
|---|---|---|
| scaffold | "create a Databricks app for our product catalog" | Short interview → `app-spec.json` → you review it → full app generated, tests green |
| check | "will this deploy?" | Preflight lint of the repo, each finding explained, platform-side asks listed |
| deploy | "deploy to dev" | Preflight → `bundle validate` → `bundle deploy` → `bundle run` → verify |
| diagnose | "users see no data" / "the app won't start" | Triage table first, then a read-only walk through the six layers that can fail |
| extend | "add a field to products" | Plans every layer (spec, DDL, tests), confirms with you, edits, re-tests |

A few rules it never breaks: it never logs or asks for tokens, never grants permissions by itself, never turns on mock mode outside tests, and always tells you when a fix belongs to an admin and not to the code.

## Quickstart

Requirements: Node 20 or newer. The Databricks CLI (0.239.0 or newer) only for deploy, verify and diagnose.

Install it as a skill by copying this folder into your agent's skills directory (any coding agent that loads `SKILL.md` skills). Then just ask for a Databricks app.

Or use the scripts directly:

```bash
# 1. describe your app (start from the example)
cp assets/app-spec.example.json app-spec.json

# 2. check the spec
node scripts/scaffold.mjs --spec app-spec.json --validate-only

# 3. generate
node scripts/scaffold.mjs --spec app-spec.json --out ../my-app

# 4. install, test, lint the deploy
cd ../my-app
npm install          # commit the package-lock.json it creates
npm run check        # typecheck + unit tests (fake DB, no warehouse needed)
npm run preflight    # deploy traps, exits 1 on any ERROR
```

Then deploy:

```bash
databricks bundle validate -t dev
databricks bundle deploy -t dev
databricks bundle run <resource-key> -t dev     # deploy uploads, run starts
node ../bricksmith/scripts/verify-deploy.mjs --target dev --dir .
```

## What you get

The generated app is driven by one file, `shared/entities.json`. One generic service, one set of routes and one React page handle every entity, so adding a field is a spec change plus DDL, not new code.

- On-behalf-of-user SQL sessions, one per request, never pooled across users
- Read and write group gates using `is_account_group_member()` (account-level groups included)
- Capability discovery from Unity Catalog grants, with "hide, don't disable" in the UI
- Bi-temporal tables: every edit is a new version, deletes are logical, history stays for audit
- Retries for warehouse cold starts and a small "warehouse is starting" banner
- `databricks.yml` with dev, sqa and prd targets, scopes at the app level, ACLs from the same groups
- Table DDL and grant SQL per environment, ready to hand to your data owner
- A README with the platform asks per environment, and an `AGENTS.md` with the non-negotiables
- Unit tests on an in-memory fake DB, passing out of the box

## The scripts

All of them are plain Node, zero dependencies.

| Script | What it does |
|---|---|
| `scripts/scaffold.mjs` | Validates a spec and generates the app |
| `scripts/preflight.mjs` | Lints a repo for the deploy traps (also copied into every generated app) |
| `scripts/verify-deploy.mjs` | After a deploy: deployment SUCCEEDED, app RUNNING, `sql` in the effective scopes, warehouse bound |
| `scripts/diagnose-access.mjs` | Read-only walk: app access → OBO scope → warehouse → Unity Catalog → data → UI |
| `scripts/sync-references.mjs` | Regenerates `references/` from `docs/knowledge-base.md` |

Some of what preflight catches:

- `user_api_scopes` missing, or nested under `config:` where it's ignored
- `git_source` deploys (the classic "App process did not start within 10 minutes")
- an `app.yaml` with environment values overriding every target
- no lockfile, a pinned registry in `.npmrc`, or `omit=optional`
- a personal `/Workspace/Users/...` root path
- tokens or secrets passed as plain env values (the app would act as the deployer)
- two targets sharing one workspace host

It also prints what it can't see from the repo (secret bindings, scope passthrough, the three grants), so nobody guesses.

## How it's organized

```text
SKILL.md                  modes, hard rules, reference map
references/               what the agent reads (generated from docs/knowledge-base.md, plus app-spec.md)
scripts/                  scaffold, preflight, verify-deploy, diagnose-access, sync-references
assets/
  app-spec.example.json   a two-entity example to start from
  templates/app/          the app that gets generated
docs/
  knowledge-base.md       every rule, with the failure it came from
  banner.svg
```

Everything in `docs/knowledge-base.md` came from a real failure or decision in a production app. If you hit a new one, the rule for this repo is simple: add a preflight check and a knowledge-base entry in the same change.

## Status

Early, and honest about it :)

- Tested locally: spec validation, generation, typecheck, unit tests, production build, and preflight (against a clean app and a deliberately broken one).
- Not yet run end to end against a live workspace: `verify-deploy.mjs`, `diagnose-access.mjs`, and the generated SQL on a real warehouse.

If you try it on a real workspace, I'd love to hear how it went.

## Contributing

Issues and PRs are welcome, especially new traps.

If something broke your deploy and the preflight didn't catch it, open an issue with the symptom, the root cause and the fix. That's exactly how every rule in here started.

## License

[MIT](LICENSE) © 2026 Daniel Ferraz

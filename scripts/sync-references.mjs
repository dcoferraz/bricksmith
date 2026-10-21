#!/usr/bin/env node
// Maintainer tool: regenerate references/*.md from the knowledge base so the skill never drifts from it.
// Usage: node sync-references.mjs [--kb ../docs/knowledge-base.md]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const kbArg = process.argv.indexOf('--kb');
const kbPath = path.resolve(kbArg > -1 ? process.argv[kbArg + 1] : path.join(HERE, '../docs/knowledge-base.md'));

const MAP = {
  'laws.md': { title: 'The ten laws', sections: [1] },
  'obo-security.md': { title: 'Mental model, architecture, identity & OBO security', sections: [2, 3, 4] },
  'bundle-reference.md': { title: 'Bundle, app.yaml, and env var reference', sections: [5] },
  'deploy-cicd.md': { title: 'Build, deploy, and CI/CD', sections: [6, 7] },
  'resilience.md': { title: 'Runtime resilience & performance', sections: [8] },
  'app-patterns.md': { title: 'Data layer, frontend, testing, local dev', sections: [9, 10, 11, 12] },
  'triage.md': { title: 'Triage table and "users see no data" order', sections: [13, 14] },
  'agent-workflow.md': { title: 'Agent guardrails, preflight rules, skill blueprint', sections: [15, 16] },
};

const kb = readFileSync(kbPath, 'utf8');
const sections = new Map();
const parts = kb.split(/^(?=## \d+\. )/m);
for (const p of parts) {
  const m = /^## (\d+)\. /.exec(p);
  if (m) sections.set(Number(m[1]), p.trim().replace(/\n---\s*$/, ''));
}

for (const [file, { title, sections: nums }] of Object.entries(MAP)) {
  const missing = nums.filter((n) => !sections.has(n));
  if (missing.length) throw new Error(`Knowledge base is missing section(s) ${missing.join(', ')}`);
  const body = nums.map((n) => sections.get(n)).join('\n\n');
  const header = `# ${title}\n\n> Generated from the knowledge base (§${nums.join(', §')}) by \`scripts/sync-references.mjs\`. Edit the knowledge base, then re-run. "§N" cross-references point at knowledge-base sections; SKILL.md maps them to files.\n\n`;
  writeFileSync(path.join(HERE, '../references', file), `${header}${body}\n`);
  console.log(`wrote references/${file}`);
}

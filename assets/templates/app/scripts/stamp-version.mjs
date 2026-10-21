// Bakes <version>+<git-sha> into client/dist/version.json. The client polls it to offer a refresh.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
let sha = process.env.GIT_SHA ?? '';
if (!sha) {
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    sha = 'nogit';
  }
}
writeFileSync('client/dist/version.json', JSON.stringify({ version: `${version}+${sha}`, builtAt: new Date().toISOString() }));

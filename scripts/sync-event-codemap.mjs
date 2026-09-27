#!/usr/bin/env node
// Refresh the checked-in copy of the corpus event codemap that
// test/event-codemap.test.mjs pins src/eventTypes.ts against.
//
//   node scripts/sync-event-codemap.mjs [--tag v2.42.6] [--corpus ../openwop] [--check]
//
// Reads `spec/v2/event-codemap.json` AT A PUBLISHED TAG (`git show <tag>:…`),
// never from the corpus working tree: versioning.md §4 — a consumer that
// vendors a file from `spec/` MUST pin to a published tag, record it, and
// refuse a sync from any other ref. The tag is recorded in
// test/fixtures/event-codemap.tag. `--check` exits 1 when the copy differs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const tagFile = resolve(root, 'test/fixtures/event-codemap.tag');
const fixture = resolve(root, 'test/fixtures/event-codemap.json');
const tag = flag('--tag') ?? readFileSync(tagFile, 'utf8').trim();
const corpus = resolve(flag('--corpus') ?? process.env.OPENWOP_CORPUS ?? resolve(root, '../openwop'));

if (!/^v2\.\d+\.\d+(-rc\.\d+)?$/.test(tag)) {
  console.error(`sync-event-codemap: refusing ${tag} — only a published v2 corpus tag may be vendored.`);
  process.exit(2);
}
let upstream;
try {
  execFileSync('git', ['-C', corpus, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { stdio: 'pipe' });
  upstream = execFileSync('git', ['-C', corpus, 'show', `${tag}:spec/v2/event-codemap.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  console.error(`sync-event-codemap: cannot read spec/v2/event-codemap.json at ${tag} in ${corpus} (${err.message.split('\n')[0]}).`);
  process.exit(2);
}
const current = readFileSync(fixture, 'utf8');
if (args.includes('--check')) {
  if (current === upstream) { console.log(`event-codemap.json matches ${tag}.`); process.exit(0); }
  console.error(`event-codemap.json differs from ${tag} — run: node scripts/sync-event-codemap.mjs --tag ${tag}`);
  process.exit(1);
}
writeFileSync(fixture, upstream);
writeFileSync(tagFile, `${tag}\n`);
console.log(`Wrote test/fixtures/event-codemap.json from ${tag}. Now regenerate V1_TO_V2_EVENT_TYPES in src/eventTypes.ts from its renamed rows; the test names any drift.`);

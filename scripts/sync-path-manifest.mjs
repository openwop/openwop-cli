#!/usr/bin/env node
// Regenerate the v2 path-template list from an openwop spec corpus checkout.
//
//   node scripts/sync-path-manifest.mjs ../openwop
//
// Reads <corpus>/spec/v2/path-manifest.json and rewrites BOTH:
//   - the GENERATED block of V2_PATH_TEMPLATES in src/protocol.ts, and
//   - test/fixtures/v2-path-manifest-paths.json (the checked-in path set the
//     drift test compares against, so `npm test` runs without the corpus).
// Stdlib only (zero runtime dependencies is a golden rule of this repo).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OMITTED = ['/.well-known/openwop', '/openapi.json'];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = process.argv[2];
if (!corpus) {
  process.stderr.write('Usage: node scripts/sync-path-manifest.mjs <path-to-openwop-corpus>\n');
  process.exit(2);
}

const manifestPath = join(resolve(corpus), 'spec/v2/path-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const paths = [...new Set([
  ...manifest.operations.map((o) => o.path),
  ...manifest.channels.map((c) => c.address),
])].sort();

function git(args) {
  try {
    return execFileSync('git', ['-C', resolve(corpus), ...args], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
const corpusVersion = git(['describe', '--tags', '--always']);
const manifestCommit = git(['log', '-1', '--format=%h', '--', 'spec/v2/path-manifest.json']);

const embedded = paths.filter((p) => !OMITTED.includes(p));
const block = [
  `// BEGIN GENERATED V2_PATH_TEMPLATES (corpus ${corpusVersion}, path-manifest.json @ ${manifestCommit}; ${paths.length} paths, ${embedded.length} embedded)`,
  'export const V2_PATH_TEMPLATES: readonly string[] = [',
  ...embedded.map((p) => `  '${p}',`),
  '];',
  '// END GENERATED V2_PATH_TEMPLATES',
].join('\n');

const protocolPath = join(repo, 'src/protocol.ts');
const src = readFileSync(protocolPath, 'utf8');
const re = /\/\/ BEGIN GENERATED V2_PATH_TEMPLATES[^\n]*\n[\s\S]*?\/\/ END GENERATED V2_PATH_TEMPLATES/;
if (!re.test(src)) {
  process.stderr.write('src/protocol.ts: GENERATED V2_PATH_TEMPLATES markers not found\n');
  process.exit(1);
}
writeFileSync(protocolPath, src.replace(re, block));

const fixture = { corpus: corpusVersion, manifestCommit, paths };
writeFileSync(join(repo, 'test/fixtures/v2-path-manifest-paths.json'), `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`synced ${paths.length} manifest paths (${embedded.length} embedded) from ${corpusVersion}\n`);

// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// `openwop --version` MUST print package.json's version. 1.0.0 shipped printing
// `0.18.2` because src/constants.ts hand-kept the string and nothing compared
// the two; the published tarball was the first place the gap was visible.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runCli, VERSION } from '../dist/cli.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('--version', () => {
  it('prints the package.json version', async () => {
    let out = '';
    const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
    const code = await runCli(['--version'], { io, fetchImpl: async () => { throw new Error('no network'); }, cwd: process.cwd(), env: {} });
    assert.equal(code, 0);
    assert.equal(out.trim(), pkg.version);
    assert.equal(VERSION, pkg.version);
  });
});

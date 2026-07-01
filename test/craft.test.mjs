// Run via `npm test` (builds dist/ first). Batch-1 craft: completion, upgrade,
// config-read defaults + --profile.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function base(cap, extra = {}) {
  return { io: cap.io, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_CONFIG_HOME: '/nonexistent-owp-test' }, ...extra };
}

describe('completion command', () => {
  it('emits a bash script listing top-level commands', async () => {
    const cap = capture();
    const code = await runCli(['completion', 'bash'], base(cap, { fetchImpl: async () => jsonResponse({}) }));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /complete -F _openwop openwop/);
    assert.match(cap.stdout, /\bruns\b/); // a known command appears in the -W list
  });
  it('emits zsh + fish', async () => {
    for (const shell of ['zsh', 'fish']) {
      const cap = capture();
      const code = await runCli(['completion', shell], base(cap, { fetchImpl: async () => jsonResponse({}) }));
      assert.equal(code, 0, `${shell}: ${cap.stderr}`);
      assert.match(cap.stdout, /openwop/);
    }
  });
  it('rejects an unknown shell (exit 2)', async () => {
    const cap = capture();
    const code = await runCli(['completion', 'perl'], base(cap, { fetchImpl: async () => jsonResponse({}) }));
    assert.equal(code, 2);
    assert.match(cap.stderr, /Unsupported shell/);
  });
});

describe('upgrade command', () => {
  it('reports up-to-date when the registry version is older', async () => {
    const cap = capture();
    const code = await runCli(['upgrade', '--json'], base(cap, {
      fetchImpl: async (url) => { assert.match(String(url), /registry\.npmjs\.org.*@openwop\/cli/); return jsonResponse({ version: '0.0.1' }); },
    }));
    assert.equal(code, 0, cap.stderr);
    const out = JSON.parse(cap.stdout);
    assert.equal(out.latest, '0.0.1');
    assert.equal(out.upToDate, true);
  });
  it('flags a newer version', async () => {
    const cap = capture();
    const code = await runCli(['upgrade'], base(cap, { fetchImpl: async () => jsonResponse({ version: '999.0.0' }) }));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /newer @openwop\/cli is available/);
    assert.match(cap.stdout, /npm install -g @openwop\/cli@latest/);
  });
});

describe('config-read defaults + --profile', () => {
  function seedConfig(profile, baseUrl) {
    const home = mkdtempSync(join(tmpdir(), 'owp-cfg-'));
    const dir = profile ? `.openwop-${profile}` : '.openwop';
    mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, dir, 'config.json'), JSON.stringify({ host: { baseUrl } }));
    return home;
  }
  it('resolves baseUrl from the saved config when no flag/env', async () => {
    const home = seedConfig(undefined, 'https://from-config.example');
    const cap = capture();
    let origin = null;
    const code = await runCli(['runs', 'list'], {
      io: cap.io, cwd: process.cwd(), repoRoot: process.cwd(),
      env: { OPENWOP_CONFIG_HOME: home, OPENWOP_API_KEY: 'k' },
      fetchImpl: async (url) => { origin = new URL(url).origin; return jsonResponse({ runs: [] }); },
    });
    assert.equal(code, 0, cap.stderr);
    assert.equal(origin, 'https://from-config.example');
  });
  it('--profile selects a different config profile', async () => {
    const home = seedConfig('staging', 'https://staging.example');
    const cap = capture();
    let origin = null;
    const code = await runCli(['--profile', 'staging', 'runs', 'list'], {
      io: cap.io, cwd: process.cwd(), repoRoot: process.cwd(),
      env: { OPENWOP_CONFIG_HOME: home, OPENWOP_API_KEY: 'k' },
      fetchImpl: async (url) => { origin = new URL(url).origin; return jsonResponse({ runs: [] }); },
    });
    assert.equal(code, 0, cap.stderr);
    assert.equal(origin, 'https://staging.example');
  });
  it('an explicit --base-url still overrides the saved config', async () => {
    const home = seedConfig(undefined, 'https://from-config.example');
    const cap = capture();
    let origin = null;
    const code = await runCli(['--base-url', 'https://flag.example', 'runs', 'list'], {
      io: cap.io, cwd: process.cwd(), repoRoot: process.cwd(),
      env: { OPENWOP_CONFIG_HOME: home, OPENWOP_API_KEY: 'k' },
      fetchImpl: async (url) => { origin = new URL(url).origin; return jsonResponse({ runs: [] }); },
    });
    assert.equal(code, 0, cap.stderr);
    assert.equal(origin, 'https://flag.example');
  });
});

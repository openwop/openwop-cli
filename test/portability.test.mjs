// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

function opts(fetchImpl, cap, cwd = process.cwd()) {
  return { io: cap.io, fetchImpl, cwd, repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } };
}

function wellKnown(advertised = true) {
  // §11: advertised via top-level capabilities.portability, not a paths map.
  const capabilities = advertised ? { portability: { dryRun: true, import: true } } : {};
  return { protocolVersion: '1.0', capabilities };
}

function host(handler, { advertised = true } = {}) {
  return async (url, init) => {
    if (new URL(url).pathname === '/.well-known/openwop') return jsonResponse(wellKnown(advertised));
    return handler(url, init);
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'openwop-port-'));

describe('export', () => {
  it('renders a per-kind summary + secretsToRebind', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/export$/);
      return jsonResponse({ items: [{ kind: 'agent' }, { kind: 'agent' }, { kind: 'schedule' }], secretsToRebind: [{ provider: 'slack', ref: 'cred:slack' }] });
    });
    const code = await runCli(['export'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /agent\s+2/);
    assert.match(cap.stdout, /secretsToRebind: 1 reference/);
  });

  it('passes --kinds through as a comma query', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(decodeURIComponent(new URL(url).search), /kinds=agent,schedule/);
      return jsonResponse({ items: [] });
    });
    const code = await runCli(['export', '--kinds', 'agent', '--kinds', 'schedule'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /empty/);
  });

  it('redacts secret-named values in --json output (defense in depth)', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [{ kind: 'connection', clientSecret: 'SHOULD-NOT-APPEAR', ref: 'cred:x' }] }));
    const code = await runCli(['export', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.doesNotMatch(cap.stdout, /SHOULD-NOT-APPEAR/);
    assert.match(cap.stdout, /\[redacted\]/);
  });

  it('writes the bundle to --out', async () => {
    const cap = capture();
    const out = join(tmp, 'estate.json');
    const fetchImpl = host(async () => jsonResponse({ items: [{ kind: 'agent' }], secretsToRebind: [] }));
    const code = await runCli(['export', '--out', out], opts(fetchImpl, cap, tmp));
    assert.equal(code, 0, cap.stderr);
    assert.ok(existsSync(out));
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).items, [{ kind: 'agent' }]);
    assert.match(cap.stdout, /Wrote export bundle/);
  });

  it('fails closed (exit 1) when not advertised', async () => {
    const cap = capture();
    const code = await runCli(['export'], opts(host(async () => jsonResponse({ items: [] }), { advertised: false }), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise/);
  });
});

describe('import', () => {
  function bundleFile(obj = { version: 1, items: [{ kind: 'agent', id: 'a1' }] }) {
    const p = join(tmp, `bundle-${Math.abs(JSON.stringify(obj).length)}-${obj.items?.length ?? 0}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it('dry-run renders the plan and exits 0 when clean', async () => {
    const cap = capture();
    const file = bundleFile();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(new URL(url).search, '?dryRun=true');
      // The host reads the bundle under a top-level `bundle` key — assert the wrapper.
      const body = JSON.parse(init.body);
      assert.ok(body.bundle && Array.isArray(body.bundle.items), 'import body must wrap the bundle as {bundle}');
      return jsonResponse({ creates: [{ kind: 'agent', id: 'a1' }], updates: [], skips: [], conflicts: [] });
    });
    const code = await runCli(['import', file, '--dry-run'], opts(fetchImpl, cap, tmp));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /dry-run — no writes/);
    assert.match(cap.stdout, /create:\s+1/);
  });

  it('dry-run with conflicts exits 2 (nothing overwritten)', async () => {
    const cap = capture();
    const file = bundleFile();
    const fetchImpl = host(async () => jsonResponse({ creates: [], updates: [], skips: [], conflicts: [{ kind: 'agent', id: 'a1', reason: 'exists with different owner' }] }));
    const code = await runCli(['import', file, '--dry-run'], opts(fetchImpl, cap, tmp));
    assert.equal(code, 2);
    assert.match(cap.stdout, /conflict: 1/);
    assert.match(cap.stdout, /exists with different owner/);
  });

  it('apply renders the result and exits 0', async () => {
    const cap = capture();
    const file = bundleFile();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(new URL(url).search, '');
      return jsonResponse({ counts: { created: 1, updated: 0, skipped: 0 }, secretsToRebind: [{ provider: 'slack' }] });
    });
    const code = await runCli(['import', file], opts(fetchImpl, cap, tmp));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /re-owned to you/);
    assert.match(cap.stdout, /created: 1/);
  });

  it('surfaces a literal-credential 422 as a fail-closed exit 1', async () => {
    const cap = capture();
    const file = bundleFile();
    const fetchImpl = host(async () => jsonResponse({ message: 'bundle carries a literal credential value' }, 422));
    const code = await runCli(['import', file], opts(fetchImpl, cap, tmp));
    assert.equal(code, 1);
    assert.match(cap.stderr, /literal credential/);
  });

  it('surfaces a 403 (no import scope) as exit 1', async () => {
    const cap = capture();
    const file = bundleFile();
    const fetchImpl = host(async () => jsonResponse({ message: 'forbidden' }, 403));
    const code = await runCli(['import', file], opts(fetchImpl, cap, tmp));
    assert.equal(code, 1);
    assert.match(cap.stderr, /import scope/);
  });

  it('rejects a missing/invalid bundle file with exit 2', async () => {
    const cap = capture();
    const code = await runCli(['import', join(tmp, 'nope.json')], opts(host(async () => jsonResponse({})), cap, tmp));
    assert.equal(code, 2);
    assert.match(cap.stderr, /could not read bundle file/);
  });
});

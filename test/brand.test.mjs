// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

function opts(fetchImpl, cap) {
  return { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } };
}

describe('brand command', () => {
  it('brand public shows the applied identity (anonymous surface)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/openwop-app\/public-brand$/);
      return jsonResponse({ identity: { productName: 'Acme', theme: { accentSeed: 'oklch(58% 0.13 250)' } } });
    };
    const code = await runCli(['brand', 'public'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /productName:\s+Acme/);
    assert.match(cap.stdout, /accent:\s+oklch\(58% 0\.13 250\)/);
  });

  it('brand set is read-modify-write: applies flags AND preserves existing fields', async () => {
    const cap = capture();
    let putBody = null;
    const fetchImpl = async (url, init) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/openwop-app\/app-brand$/);
      if (!init || (init.method ?? 'GET') === 'GET') {
        // Current brand — carries a logo + a mode the CLI must NOT clobber.
        return jsonResponse({ brand: { name: 'App', identity: { logo: { markSrc: '/logo.svg' }, theme: { defaultMode: 'dark' } } } });
      }
      assert.equal(init.method, 'PUT');
      putBody = JSON.parse(init.body);
      return jsonResponse({ brand: putBody });
    };
    const code = await runCli(['brand', 'set', '--accent', 'oklch(60% 0.12 30)', '--product-name', 'Acme Ops'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(putBody.identity.productName, 'Acme Ops'); // new flag
    assert.equal(putBody.identity.theme.accentSeed, 'oklch(60% 0.12 30)'); // new flag → theme generator seed
    assert.equal(putBody.identity.theme.defaultMode, 'dark'); // preserved from current
    assert.equal(putBody.identity.logo.markSrc, '/logo.svg'); // preserved from current
  });

  it('brand set --identity-json REPLACES the identity facet', async () => {
    const cap = capture();
    let putBody = null;
    const fetchImpl = async (url, init) => {
      if (!init || (init.method ?? 'GET') === 'GET') return jsonResponse({ brand: { identity: { logo: { markSrc: '/old.svg' } } } });
      putBody = JSON.parse(init.body);
      return jsonResponse({ brand: putBody });
    };
    const code = await runCli(['brand', 'set', '--identity-json', '{"productName":"Fresh"}'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(putBody.identity.productName, 'Fresh');
    assert.equal(putBody.identity.logo, undefined); // replaced, not merged
  });

  it('brand get without super-admin fails gracefully (exit 4, actionable hint)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ error: 'superadmin required' }, 403);
    const code = await runCli(['brand', 'get'], opts(fetchImpl, cap));
    assert.equal(code, 4, cap.stdout);
    assert.match(cap.stderr + cap.stdout, /super-admin/i);
  });

  it('rejects an out-of-enum --contrast before any request (usage error)', async () => {
    const cap = capture();
    let called = false;
    const fetchImpl = async () => { called = true; return jsonResponse({ brand: { identity: {} } }); };
    const code = await runCli(['brand', 'set', '--contrast', 'ultra'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.equal(called, false); // validated client-side, no wasted request
    assert.match(cap.stderr + cap.stdout, /contrast must be one of/i);
  });
});

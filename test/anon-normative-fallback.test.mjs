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

function json(body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fake v1 host: `/.well-known/openwop` advertises protocol 1.x (so paths are
 * sent exactly as written); every other request is recorded and answered by
 * `handler(method, path, body, url)`.
 */
function fakeHost(handler, wellKnown) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/openwop') return json(wellKnown);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers ?? {} });
    return handler(method, u.pathname, body, u);
  };
  return { fetchImpl, calls };
}

async function run(argv, handler, env = {}, wellKnown = V1) {
  const cap = capture();
  const { fetchImpl, calls } = fakeHost(handler, wellKnown);
  const code = await runCli(['--base-url', 'https://h.example', ...argv], { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { ...env } });
  return { code, stdout: cap.stdout, stderr: cap.stderr, calls };
}


const V2 = { protocolVersions: ['2.0', '1.1'], extensions: { 'openwop-app.host': { root: '/host/openwop-app/', twin: '/v1/host/openwop-app/' } } };
const unauth = (challenge) => new Response(JSON.stringify({ error: 'unauthenticated', message: 'No credential presented.' }), {
  status: 401, headers: { 'content-type': 'application/json', ...(challenge ? { 'www-authenticate': challenge } : {}) },
});
const NO_CRED = 'Bearer resource_metadata="https://h.example/.well-known/oauth-protected-resource/api"';
const INVALID = 'Bearer resource_metadata="https://h.example/.well-known/oauth-protected-resource/api", error="invalid_token"';
const notFound = () => json({ error: 'not_found', message: 'Cannot GET' }, 404);

describe('normative-first reads — the RFC 0200 §B.1 no-credential fallback', () => {
  it('an anonymous caller refused with the no-credential challenge is served by the demo twin, announced on stderr', async () => {
    const r = await run(['roster', 'list'], (m, p) => (p === '/agents/roster' ? unauth(NO_CRED) : json({ roster: [{ rosterId: 'r1', name: 'Ops' }] })), {}, V2);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls.map((c) => c.path), ['/agents/roster', '/host/openwop-app/roster']);
    assert.match(r.stderr, /not signed in — showing this host's anonymous demo view/);
  });

  it('--json keeps the notice on stderr and stdout parseable', async () => {
    const r = await run(['--json', 'roster', 'list'], (m, p) => (p === '/agents/roster' ? unauth(NO_CRED) : json({ roster: [] })), {}, V2);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
    assert.match(r.stderr, /anonymous demo view/);
  });

  it('a PRESENTED credential refused with the same challenge shape is NOT retried anonymously (no silent identity switch)', async () => {
    const r = await run(['roster', 'list'], () => unauth(NO_CRED), { OPENWOP_API_KEY: 'k' }, V2);
    assert.equal(r.code, 4);
    assert.deepEqual(r.calls.map((c) => c.path), ['/agents/roster']);
  });

  it('invalid_token (a credential was presented and refused) is never a fallback', async () => {
    const r = await run(['roster', 'list'], () => unauth(INVALID), {}, V2);
    assert.equal(r.code, 4);
    assert.equal(r.calls.length, 1);
  });

  it('a bare 401 with no challenge is ambiguous and is not a fallback', async () => {
    const r = await run(['agents', 'list'], () => unauth(undefined), {}, V2);
    assert.equal(r.code, 4);
    assert.equal(r.calls.length, 1);
  });

  it('a 403 is never a fallback', async () => {
    const r = await run(['org-chart', 'get'], () => json({ error: 'forbidden', message: 'no' }, 403), {}, V2);
    assert.equal(r.code, 4);
    assert.equal(r.calls.length, 1);
  });

  it('a host with no demo twin re-surfaces the ORIGINAL 401, not a misleading 404', async () => {
    const r = await run(['roster', 'list'], (m, p) => (p === '/agents/roster' ? unauth(NO_CRED) : notFound()), {}, V2);
    assert.equal(r.code, 4, r.stderr);
    assert.equal(r.calls.length, 2);
    assert.match(r.stderr, /HTTP 401 unauthenticated/);
    assert.doesNotMatch(r.stderr, /404/);
  });
});

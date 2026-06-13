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

function wellKnown(withConnections = true) {
  const paths = { '/v1/runs': { get: {} } };
  if (withConnections) paths['/v1/host/sample/connections'] = { get: {} };
  return { protocolVersion: '1.0', paths };
}

function host(handler, { advertised = true } = {}) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/openwop') return jsonResponse(wellKnown(advertised));
    return handler(url, init);
  };
}

describe('connections list', () => {
  it('renders connections as a table', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/connections$/);
      return jsonResponse({ connections: [
        { connectionId: 'conn:1', provider: 'google', kind: 'oauth2', userId: 'u1', displayName: 'Google', status: 'active', expiresAt: '2026-07-01' },
        { connectionId: 'conn:2', provider: 'slack', kind: 'api_key', orgId: 'o1', displayName: 'Slack', status: 'revoked' },
      ] });
    });
    const code = await runCli(['connections', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /conn:1\s+google\s+oauth2\s+user\s+active/);
    assert.match(cap.stdout, /conn:2\s+slack\s+api_key\s+org\s+revoked/);
  });

  it('fails closed when the host does not advertise the surface', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ connections: [] }), { advertised: false });
    const code = await runCli(['connections', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise the connections surface/);
  });
});

describe('connections secret boundary', () => {
  it('redacts any secret-looking field in --json output (get)', async () => {
    const cap = capture();
    // A misbehaving host that leaks token material — the CLI must NOT print it.
    const fetchImpl = host(async () => jsonResponse({ connections: [
      { connectionId: 'conn:1', provider: 'google', kind: 'oauth2', status: 'active',
        accessToken: 'ya29.SUPERSECRET', refreshToken: 'r-SECRET', clientId: 'public-client-id' },
    ] }));
    const code = await runCli(['connections', 'get', 'conn:1', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.doesNotMatch(cap.stdout, /SUPERSECRET/);
    assert.doesNotMatch(cap.stdout, /r-SECRET/);
    assert.match(cap.stdout, /\[redacted\]/);
    // clientId is public metadata — it must survive (NOT a secret).
    assert.match(cap.stdout, /public-client-id/);
  });

  it('never prints a leaked clientSecret from oauth-clients', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/connections-oauth-clients$/);
      return jsonResponse({ clients: [
        { provider: 'google', clientId: 'gid', configured: true, updatedAt: '2026-06-01', clientSecret: 'LEAKED-SECRET' },
      ] });
    });
    const code = await runCli(['connections', 'oauth-clients', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.doesNotMatch(cap.stdout, /LEAKED-SECRET/);
    assert.match(cap.stdout, /google\s+gid\s+yes/);
  });
});

describe('connections test', () => {
  it('POSTs to /test and exits 0 when healthy', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      // connectionId is percent-encoded in the path (':' → '%3A').
      assert.match(new URL(url).pathname, /\/connections\/conn%3A1\/test$/);
      return jsonResponse({ ok: true, status: 'active', expiresAt: '2026-07-01' });
    });
    const code = await runCli(['connections', 'test', 'conn:1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /ok: yes/);
    assert.match(cap.stdout, /status: active/);
  });

  it('exits 1 when the connection is unhealthy', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ ok: false, status: 'needs-reconsent' }));
    const code = await runCli(['connections', 'test', 'conn:1'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stdout, /ok: no/);
  });
});

describe('connections authorize', () => {
  it('prints the consent URL only and sends scopes + write', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/connections\/google\/authorize$/);
      assert.deepEqual(JSON.parse(init.body), { scopes: ['calendar'], write: true });
      return jsonResponse({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    });
    const code = await runCli(['connections', 'authorize', 'google', '--scope', 'calendar', '--write'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(cap.stdout.trim(), 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });

  it('surfaces a 409 (OAuth not configured) legibly', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: "OAuth is not configured for 'google' on this host." }, 409));
    const code = await runCli(['connections', 'authorize', 'google'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /OAuth is not configured/);
  });
});

describe('connections oauth-clients get', () => {
  it('selects one client by provider', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ clients: [
      { provider: 'google', clientId: 'gid', configured: true, updatedAt: '2026-06-01' },
      { provider: 'slack', clientId: 'sid', configured: true, updatedAt: '2026-06-02' },
    ] }));
    const code = await runCli(['connections', 'oauth-clients', 'get', 'slack'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /provider: slack/);
    assert.match(cap.stdout, /clientId: sid/);
  });

  it('errors (exit 1) when the provider has no configured client', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ clients: [] }));
    const code = await runCli(['connections', 'oauth-clients', 'get', 'missing'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /no OAuth client configured for provider missing/);
  });
});

// Run via `npm test` (builds dist/ first) — these import the esbuild bundle at ../dist/cli.js.
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
function xmlResponse(xml, status = 200) {
  return new Response(xml, { status, headers: { 'content-type': 'application/xml' } });
}
function redirectResponse(location, status = 302) {
  return new Response('', { status, headers: { location } });
}
function opts(fetchImpl, cap) {
  return { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } };
}

describe('auth command', () => {
  it('status reports advertised auth profiles (human table)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      if (p === '/.well-known/openwop') return jsonResponse({ capabilities: { auth: { profiles: ['openwop-auth-saml', 'openwop-auth-scim'] } } });
      if (p.endsWith('/saml/sso/metadata')) return xmlResponse('<EntityDescriptor/>');
      return jsonResponse({});
    };
    const code = await runCli(['auth', 'status'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /SAML SSO.*yes.*yes/s);
    assert.match(cap.stdout, /SCIM provisioning\s+yes/);
  });

  it('status with no advertised profiles says so', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      if (p === '/.well-known/openwop') return jsonResponse({ capabilities: {} });
      return jsonResponse({ message: 'not found' }, 404);
    };
    const code = await runCli(['auth', 'status'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /advertises no enterprise-auth profiles/);
  });

  it('status --json surfaces structured advertisement', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      if (p === '/.well-known/openwop') return jsonResponse({ capabilities: { auth: { profiles: ['openwop-auth-saml'] } } });
      return jsonResponse({ message: 'nf' }, 404);
    };
    const code = await runCli(['auth', 'status', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    const out = JSON.parse(cap.stdout);
    assert.deepEqual(out.authProfilesAdvertised, ['openwop-auth-saml']);
    assert.equal(out.saml.advertised, true);
    assert.equal(out.scim.advertised, false);
  });

  it('saml metadata prints the SP metadata XML verbatim (public)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/auth\/saml\/sso\/metadata$/);
      return xmlResponse('<EntityDescriptor entityID="sp"><X509Certificate>PUBLICCERT</X509Certificate></EntityDescriptor>');
    };
    const code = await runCli(['auth', 'saml', 'metadata'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /<EntityDescriptor entityID="sp">/);
  });

  it('saml metadata fails closed when SSO is not configured (404)', async () => {
    const cap = capture();
    const code = await runCli(['auth', 'saml', 'metadata'], opts(async () => jsonResponse({ message: 'nope' }, 404), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /SAML SSO is not configured/);
  });

  it('saml login-url surfaces the IdP redirect Location without following it', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.redirect, 'manual');
      assert.match(new URL(url).pathname, /\/auth\/saml\/sso\/login$/);
      assert.equal(new URL(url).searchParams.get('returnTo'), '/dash');
      return redirectResponse('https://idp.example.com/sso?SAMLRequest=abc');
    };
    const code = await runCli(['auth', 'saml', 'login-url', '--return-to', '/dash'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /https:\/\/idp\.example\.com\/sso\?SAMLRequest=abc/);
  });

  it('saml validate returns 0 + principal on an authenticated assertion', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/auth\/saml\/validate$/);
      assert.deepEqual(JSON.parse(init.body), { idpUrl: 'http://localhost:9100/idp', variant: 'valid' });
      return jsonResponse({ authenticated: true, principal: 'saml:jo@acme.com' });
    };
    const code = await runCli(['auth', 'saml', 'validate', '--idp-url', 'http://localhost:9100/idp', '--variant', 'valid'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /authenticated: yes/);
    assert.match(cap.stdout, /principal: saml:jo@acme.com/);
  });

  it('saml validate returns 1 + reason on a rejected assertion (401)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ authenticated: false, reason: 'bad-signature' }, 401);
    const code = await runCli(['auth', 'saml', 'validate', '--idp-url', 'http://localhost:9100/idp', '--variant', 'bad-signature'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stdout, /authenticated: no \(bad-signature\)/);
  });

  it('REDACTS secret-looking fields a host returns by mistake (validate)', async () => {
    const cap = capture();
    // A misbehaving host leaks a cert/assertion/token in the principal object.
    const fetchImpl = async () => jsonResponse({
      authenticated: true,
      principal: { sub: 'jo', certificatePem: 'CERTBYTES', assertion: 'RAWXML', bearerToken: 'tok' },
    });
    const code = await runCli(['auth', 'saml', 'validate', '--idp-url', 'http://h/idp', '--variant', 'valid', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.doesNotMatch(cap.stdout, /CERTBYTES|RAWXML|tok"/);
    const out = JSON.parse(cap.stdout);
    assert.equal(out.principal.certificatePem, '[redacted]');
    assert.equal(out.principal.assertion, '[redacted]');
    assert.equal(out.principal.bearerToken, '[redacted]');
    assert.equal(out.principal.sub, 'jo'); // non-secret survives
  });

  it('scim provision create-user renders the principal + resolvable', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/auth\/scim\/provision$/);
      assert.deepEqual(JSON.parse(init.body), { op: 'create-user', user: { userName: 'jo@acme.com', email: 'jo@acme.com' } });
      return jsonResponse({ op: 'create-user', principal: { userName: 'jo@acme.com', status: 'active', groups: [] }, resolvable: true }, 201);
    };
    const code = await runCli(['auth', 'scim', 'provision', '--op', 'create-user', '--user-name', 'jo@acme.com', '--email', 'jo@acme.com'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /op: create-user/);
    assert.match(cap.stdout, /principal: jo@acme.com \(active\)/);
    assert.match(cap.stdout, /resolvable: yes/);
  });

  it('scim provision rejects an invalid --op (no request)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['auth', 'scim', 'provision', '--op', 'frobnicate'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
  });

  it('scim provision fails closed when the seam is not configured (404)', async () => {
    const cap = capture();
    const code = await runCli(['auth', 'scim', 'provision', '--op', 'create-user'], opts(async () => jsonResponse({ message: 'nope' }, 404), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /SCIM provisioning seam not configured/);
  });

  it('is reachable via the sso alias', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      if (new URL(url).pathname === '/.well-known/openwop') return jsonResponse({ capabilities: {} });
      return jsonResponse({ message: 'nf' }, 404);
    };
    const code = await runCli(['sso', 'status'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /SAML SSO/);
  });

  it('rejects an unknown subcommand', async () => {
    const cap = capture();
    const code = await runCli(['auth', 'bogus'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /Unknown auth command: bogus/);
  });
});

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
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so no discovery request is made.
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });
function recorder(body = {}, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined }); return status === 204 ? new Response(null, { status }) : jsonResponse(body, status); };
  return { calls, fetchImpl };
}
const B = '/v1/host/openwop-app/dealers/orgs/o';

describe('dealers', () => {
  it('list forwards filters as query + renders a table', async () => {
    const cap = capture();
    const r = recorder({ dealers: [{ dealerId: 'dealer:1', name: 'Acme', tier: 'gold', status: 'active', companyId: 'c1' }] });
    assert.equal(await runCli(['dealers', 'list', '--org', 'o', '--status', 'active'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${B}/dealers`);
    assert.equal(r.calls[0].url.searchParams.get('status'), 'active');
    assert.match(cap.stdout, /dealer:1\s+Acme\s+gold\s+active\s+c1/);
  });

  it('get URL-encodes the dealer id; --json passes the body through', async () => {
    const cap = capture();
    const r = recorder({ dealerId: 'dealer:1', name: 'Acme' });
    assert.equal(await runCli(['--json', 'dealers', 'get', 'dealer:1', '--org', 'o'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/dealers/dealer%3A1`);
    assert.deepEqual(JSON.parse(cap.stdout), { dealerId: 'dealer:1', name: 'Acme' });
  });

  it('create posts companyId/name/tier', async () => {
    const cap = capture();
    const r = recorder({ dealerId: 'dealer:2' }, 201);
    assert.equal(await runCli(['dealers', 'create', '--org', 'o', '--company-id', 'c1', '--name', 'Acme', '--tier', 'gold'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].init.method, 'POST');
    assert.deepEqual(r.calls[0].body, { companyId: 'c1', name: 'Acme', tier: 'gold' });
  });

  it('outlets create sends numeric lat/lng under the dealer', async () => {
    const cap = capture();
    const r = recorder({ outletId: 'outlet:1' }, 201);
    assert.equal(await runCli(['dealers', 'outlets', 'create', 'dealer:1', '--org', 'o', '--name', 'Downtown', '--lat', '40.5', '--lng=-74'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${B}/dealers/dealer%3A1/outlets`);
    assert.deepEqual(r.calls[0].body, { name: 'Downtown', lat: 40.5, lng: -74 });
  });

  it('outlets update PATCHes and outlets delete requires --yes', async () => {
    let cap = capture();
    let r = recorder({ outletId: 'outlet:1' });
    assert.equal(await runCli(['dealers', 'outlets', 'update', 'outlet:1', '--org', 'o', '--status', 'closed'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].init.method, 'PATCH');
    assert.deepEqual(r.calls[0].body, { status: 'closed' });
    cap = capture();
    assert.equal(await runCli(['dealers', 'outlets', 'delete', 'outlet:1', '--org', 'o'], opts(async () => { throw new Error('no'); }, cap)), 2);
    r = recorder({ success: true });
    assert.equal(await runCli(['dealers', 'outlets', 'delete', 'outlet:1', '--org', 'o', '--yes'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'DELETE');
  });

  it('portal-token warns on stderr that the token is shown once', async () => {
    const cap = capture();
    const r = recorder({ token: 'tok', url: 'https://x/partner/tok' }, 201);
    assert.equal(await runCli(['dealers', 'portal-token', 'dealer:1', '--org', 'o'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/dealers/dealer%3A1/portal-token`);
    assert.match(cap.stderr, /shown once/);
    assert.match(cap.stdout, /partner\/tok/);
  });

  it('registrations lists with filters', async () => {
    const cap = capture();
    const r = recorder({ registrations: [] });
    assert.equal(await runCli(['dealers', 'registrations', '--org', 'o', '--dealer-id', 'dealer:1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.searchParams.get('dealerId'), 'dealer:1');
    assert.match(cap.stdout, /No registrations/);
  });

  it('partner get/register hit the public portal WITHOUT an authorization header', async () => {
    const r = recorder({ dealer: { name: 'Acme' }, outlets: [], registrations: [] });
    assert.equal(await runCli(['dealers', 'partner', 'get', 'tok/1'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, '/v1/host/openwop-app/partner/tok%2F1');
    assert.equal(r.calls[0].init.headers.authorization, undefined);
    const r2 = recorder({ status: 'pending' }, 201);
    assert.equal(await runCli(['dealers', 'partner', 'register', 'tok', '--deal-title', 'Fleet', '--company-name', 'Globex'], opts(r2.fetchImpl, capture())), 0);
    assert.equal(r2.calls[0].url.pathname, '/v1/host/openwop-app/partner/tok/register');
    assert.deepEqual(r2.calls[0].body, { dealTitle: 'Fleet', companyName: 'Globex' });
    assert.equal(r2.calls[0].init.headers.authorization, undefined);
  });

  it('403 → legible message + exit 4', async () => {
    const cap = capture();
    assert.equal(await runCli(['dealers', 'list', '--org', 'o'], opts(async () => jsonResponse({ message: 'Feature disabled.' }, 403), cap)), 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: Feature disabled\./);
  });
});

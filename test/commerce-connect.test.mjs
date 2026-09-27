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
const empty = (status = 204) => new Response(null, { status });
// Pin protocol major 1 so no discovery request is made.
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });
const B = '/v1/host/openwop-app/commerce-connect';

async function call(argv, response) {
  const cap = capture();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined }); return response(); };
  const code = await runCli(argv, opts(fetchImpl, cap));
  return { code, cap, calls };
}

describe('commerce-connect', () => {
  it('seller onboard POSTs {country} and prints the Stripe-hosted link', async () => {
    const r = await call(['commerce-connect', 'seller', 'onboard', '--country', 'US'], () => jsonResponse({ seller: { tenantId: 't', onboardingState: 'pending' }, url: 'https://connect.stripe.com/setup/x', mode: 'demo' }, 201));
    assert.equal(r.code, 0, r.cap.stderr);
    assert.equal(r.calls[0].init.method, 'POST');
    assert.equal(r.calls[0].url.pathname, `${B}/seller/onboard`);
    assert.deepEqual(r.calls[0].body, { country: 'US' });
    assert.match(r.cap.stdout, /https:\/\/connect\.stripe\.com\/setup\/x/);
  });

  it('seller status/sync/stats hit their routes', async () => {
    for (const [argv, method, path] of [
      [['seller', 'status'], 'GET', '/seller'],
      [['seller', 'sync'], 'POST', '/seller/sync'],
      [['seller', 'stats'], 'GET', '/seller/stats'],
      [['orders', 'list'], 'GET', '/orders'],
      [['orders', 'get', 'ord/1'], 'GET', '/orders/ord%2F1'],
      [['admin', 'disputes'], 'GET', '/admin/disputes'],
      [['approvals', 'list'], 'GET', '/approvals'],
    ]) {
      const r = await call(['commerce-connect', ...argv], () => jsonResponse({}));
      assert.equal(r.code, 0, r.cap.stderr);
      assert.equal(r.calls[0].init.method, method);
      assert.equal(r.calls[0].url.pathname, `${B}${path}`);
    }
  });

  it('listings list renders a table; --json is verbatim', async () => {
    const body = { listings: [{ packName: 'my.pack', lane: 'native-paid', priceMajorUnits: 19, currency: 'usd', approvalState: 'approved', packMissing: false }] };
    let r = await call(['commerce-connect', 'listings', 'list'], () => jsonResponse(body));
    assert.equal(r.code, 0);
    assert.match(r.cap.stdout, /my\.pack\s+native-paid\s+19\s+usd\s+approved\s+false/);
    r = await call(['--json', 'commerce-connect', 'listings', 'list'], () => jsonResponse(body));
    assert.deepEqual(JSON.parse(r.cap.stdout), body);
  });

  it('listings set PUTs the listing fields exactly (major units passed through)', async () => {
    const r = await call(['commerce-connect', 'listings', 'set', 'my.pack', '--lane', 'native-paid', '--price-major-units', '19.5', '--currency', 'usd'], () => jsonResponse({ listing: {} }));
    assert.equal(r.code, 0, r.cap.stderr);
    assert.equal(r.calls[0].init.method, 'PUT');
    assert.equal(r.calls[0].url.pathname, `${B}/listings/my.pack`);
    assert.deepEqual(r.calls[0].body, { lane: 'native-paid', priceMajorUnits: 19.5, currency: 'usd' });
  });

  it('listings delete needs --yes; purchase checkout sends packName', async () => {
    let r = await call(['commerce-connect', 'listings', 'delete', 'my.pack'], () => empty());
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    r = await call(['commerce-connect', 'listings', 'delete', 'my.pack', '--yes'], () => empty());
    assert.equal(r.code, 0);
    assert.equal(r.calls[0].init.method, 'DELETE');
    r = await call(['commerce-connect', 'purchase', 'checkout', '--pack-name', 'my.pack'], () => jsonResponse({ url: 'https://checkout.stripe.com/x', order: {} }, 201));
    assert.equal(r.code, 0);
    assert.equal(r.calls[0].url.pathname, `${B}/purchase/checkout`);
    assert.deepEqual(r.calls[0].body, { packName: 'my.pack' });
  });

  it('approvals decide + admin delist/listing-state/refund bodies', async () => {
    let r = await call(['commerce-connect', 'approvals', 'decide', 'a1', '--decision', 'rejected', '--reason', 'no'], () => jsonResponse({ approvalId: 'a1', status: 'rejected' }));
    assert.equal(r.calls[0].url.pathname, `${B}/approvals/a1`);
    assert.deepEqual(r.calls[0].body, { decision: 'rejected', reason: 'no' });
    r = await call(['commerce-connect', 'admin', 'delist', 'p', '--reason', 'abuse', '--yes'], () => empty());
    assert.equal(r.code, 0, r.cap.stderr);
    assert.equal(r.calls[0].init.method, 'DELETE');
    assert.equal(r.calls[0].url.pathname, `${B}/admin/listings/p`);
    assert.deepEqual(r.calls[0].body, { reason: 'abuse' });
    r = await call(['commerce-connect', 'admin', 'listing-state', 'p', '--state', 'suspended', '--reason', 'x'], () => empty());
    assert.equal(r.calls[0].init.method, 'PUT');
    assert.equal(r.calls[0].url.pathname, `${B}/admin/listings/p/state`);
    assert.deepEqual(r.calls[0].body, { state: 'suspended', reason: 'x' });
    r = await call(['commerce-connect', 'admin', 'refund', 'o1', '--yes'], () => jsonResponse({ ok: true }));
    assert.equal(r.calls[0].init.method, 'POST');
    assert.equal(r.calls[0].url.pathname, `${B}/admin/orders/o1/refund`);
  });

  it('fee-config get/set + import', async () => {
    let r = await call(['commerce-connect', 'fee-config', 'get', '--tenant-id', 't1'], () => jsonResponse({ key: 't1', applicationFeePct: 10 }));
    assert.equal(r.calls[0].url.pathname, `${B}/fee-config`);
    assert.equal(r.calls[0].url.searchParams.get('tenantId'), 't1');
    r = await call(['commerce-connect', 'fee-config', 'set', '--application-fee-pct', '12.5'], () => jsonResponse({}));
    assert.equal(r.calls[0].init.method, 'PUT');
    assert.deepEqual(r.calls[0].body, { applicationFeePct: 12.5 });
    r = await call(['commerce-connect', 'import', '--sellers', '[{"tenantId":"t"}]'], () => jsonResponse({ imported: 1 }));
    assert.equal(r.calls[0].url.pathname, `${B}/import`);
    assert.deepEqual(r.calls[0].body, { sellers: [{ tenantId: 't' }] });
  });

  it('403 on a superadmin route → legible message + exit 4', async () => {
    const r = await call(['commerce-connect', 'admin', 'orders'], () => jsonResponse({ error: 'forbidden', message: 'Superadmin only.' }, 403));
    assert.equal(r.code, 4);
    assert.match(r.cap.stderr, /HTTP 403: Superadmin only\./);
  });
});

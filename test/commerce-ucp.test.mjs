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
const opts = (fetchImpl, cap, env = {}) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1', ...env } });
const H = '/v1/host/openwop-app/commerce';

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    return respond(calls.at(-1));
  };
  return { calls, fetchImpl };
}

describe('commerce ucp clients (merchant admin)', () => {
  it('list renders clients', async () => {
    const cap = capture();
    const r = recorder(() => jsonResponse({ clients: [{ clientId: 'c1', name: 'Agent', scopes: ['cart:write'], createdAt: 't' }] }));
    assert.equal(await runCli(['commerce', 'ucp', 'clients', 'list', '--org', 'org/1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${H}/orgs/org%2F1/ucp/clients`);
    assert.equal(r.calls[0].auth, 'Bearer k');
    assert.match(cap.stdout, /c1\s+Agent/);
  });

  it('create sends name + scopes list and warns about the one-time secret', async () => {
    const cap = capture();
    const r = recorder(() => jsonResponse({ clientId: 'c1', name: 'A', scopes: ['cart:write'], clientSecret: 's3cr3t' }, 201));
    assert.equal(await runCli(['--json', 'commerce', 'ucp', 'clients', 'create', '--org', 'o', '--name', 'A', '--scopes', 'cart:write,orders:read'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.deepEqual(r.calls[0].body, { name: 'A', scopes: ['cart:write', 'orders:read'] });
    assert.match(cap.stderr, /shown ONCE/);
    assert.equal(JSON.parse(cap.stdout).clientSecret, 's3cr3t');
  });

  it('delete needs --yes and handles a 204', async () => {
    let cap = capture();
    assert.equal(await runCli(['commerce', 'ucp', 'clients', 'delete', 'c1', '--org', 'o'], opts(async () => { throw new Error('no'); }, cap)), 2);
    cap = capture();
    const r = recorder(() => new Response(null, { status: 204 }));
    assert.equal(await runCli(['commerce', 'ucp', 'clients', 'delete', 'c1', '--org', 'o', '--yes'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].method, 'DELETE');
    assert.equal(r.calls[0].url.pathname, `${H}/orgs/o/ucp/clients/c1`);
    assert.match(cap.stdout, /Deleted/);
  });

  it('403 → exit 4', async () => {
    const cap = capture();
    assert.equal(await runCli(['commerce', 'ucp', 'clients', 'list', '--org', 'o'], opts(async () => jsonResponse({ message: 'Forbidden.' }, 403), cap)), 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: Forbidden\./);
  });
});

describe('commerce ucp (public agent surface)', () => {
  it('discovery / catalog are sent WITHOUT the operator bearer', async () => {
    const cap = capture();
    const r = recorder((c) => jsonResponse(c.url.pathname.endsWith('/catalog') ? { vertical: 'shopping', items: [{ id: 'p1', title: 'Mug', type: 'physical', availability: 'in_stock' }] } : { ucp: {} }));
    assert.equal(await runCli(['commerce', 'ucp', 'discovery', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['commerce', 'ucp', 'oauth-metadata', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['commerce', 'ucp', 'catalog', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['commerce', 'ucp', 'product', 'p1', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(r.calls.map((c) => c.url.pathname), [
      `${H}/ucp/orgs/o/.well-known/ucp`, `${H}/ucp/orgs/o/.well-known/oauth-authorization-server`, `${H}/ucp/orgs/o/catalog`, `${H}/ucp/orgs/o/catalog/p1`,
    ]);
    assert.ok(r.calls.every((c) => c.auth === undefined));
    assert.match(cap.stdout, /p1\s+Mug\s+physical\s+in_stock/);
  });

  it('cart / checkout / order routes carry the --api-key bearer and the UCP field names', async () => {
    const cap = capture();
    const r = recorder(() => jsonResponse({ id: 'x' }));
    const run = (args) => runCli(['--api-key', 'ucp_tok', '--json', 'commerce', 'ucp', ...args, '--org', 'o'], opts(r.fetchImpl, cap));
    assert.equal(await run(['cart', 'get']), 0, cap.stderr);
    assert.equal(await run(['cart', 'add', '--item-id', 'p1', '--quantity', '2']), 0, cap.stderr);
    assert.equal(await run(['cart', 'clear', '--yes']), 0, cap.stderr);
    assert.equal(await run(['checkout', '--coupon-code', 'SAVE10']), 0, cap.stderr);
    assert.equal(await run(['order', 'get', 'ord_1']), 0, cap.stderr);
    assert.equal(await run(['order', 'cancel', 'ord_1']), 0, cap.stderr);
    assert.equal(await run(['order', 'pay', 'ord_1', '--ap2-mandate', '{"id":"m1","amount":1299,"currency":"USD"}']), 0, cap.stderr);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url.pathname}`), [
      `GET ${H}/ucp/orgs/o/cart`,
      `POST ${H}/ucp/orgs/o/cart/items`,
      `DELETE ${H}/ucp/orgs/o/cart`,
      `POST ${H}/ucp/orgs/o/checkout`,
      `GET ${H}/ucp/orgs/o/orders/ord_1`,
      `POST ${H}/ucp/orgs/o/orders/ord_1/cancel`,
      `POST ${H}/ucp/orgs/o/orders/ord_1/pay`,
    ]);
    assert.ok(r.calls.every((c) => c.auth === 'Bearer ucp_tok'));
    assert.deepEqual(r.calls[1].body, { item_id: 'p1', quantity: 2 });
    assert.deepEqual(r.calls[3].body, { coupon_code: 'SAVE10' });
    assert.deepEqual(r.calls[6].body, { ap2_mandate: { id: 'm1', amount: 1299, currency: 'USD' } });
  });

  it('token reads the client secret from the env var and warns', async () => {
    const cap = capture();
    const r = recorder(() => jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'cart:write' }));
    const code = await runCli(['commerce', 'ucp', 'token', '--org', 'o', '--client-id', 'c1', '--client-secret-env', 'UCP_SECRET'], opts(r.fetchImpl, cap, { UCP_SECRET: 'shh' }));
    assert.equal(code, 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${H}/ucp/orgs/o/oauth/token`);
    assert.equal(r.calls[0].auth, undefined);
    assert.deepEqual(r.calls[0].body, { grant_type: 'client_credentials', client_id: 'c1', client_secret: 'shh' });
    assert.match(cap.stderr, /access token/);
    assert.match(cap.stdout, /access_token: tok/);
  });

  it('token refuses an unset secret env var without a request', async () => {
    const cap = capture();
    const code = await runCli(['commerce', 'ucp', 'token', '--org', 'o', '--client-id', 'c1', '--client-secret-env', 'NOPE'], opts(async () => { throw new Error('no'); }, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /NOPE is empty or unset/);
  });
});

describe('commerce ucp-buyer', () => {
  it('drives discover / search / purchases with exact bodies', async () => {
    const cap = capture();
    const r = recorder(() => jsonResponse({ ok: true }));
    const run = (args) => runCli(['--json', 'commerce', 'ucp-buyer', ...args, '--org', 'o'], opts(r.fetchImpl, cap));
    assert.equal(await run(['discover', '--merchant-url', 'https://m.example']), 0, cap.stderr);
    assert.equal(await run(['catalog-search', '--merchant-server-id', 'srv1', '--q', 'mug']), 0, cap.stderr);
    assert.equal(await run(['purchases', 'create', '--merchant-url', 'https://m.example', '--intent', 'buy mugs', '--max-amount-minor', '5000', '--currency', 'USD', '--lines', '[{"itemId":"p1","quantity":2}]']), 0, cap.stderr);
    assert.equal(await run(['purchases', 'get', 'pu1']), 0, cap.stderr);
    assert.equal(await run(['purchases', 'checkout', 'pu1']), 0, cap.stderr);
    assert.equal(await run(['purchases', 'track', 'pu1']), 0, cap.stderr);
    assert.equal(await run(['purchases', 'close', 'pu1', '--outcome', 'not_placed', '--reason', 'verified']), 0, cap.stderr);
    const B = `${H}/orgs/o/ucp-buyer`;
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url.pathname}`), [
      `POST ${B}/discover`, `POST ${B}/catalog-search`, `POST ${B}/purchases`, `GET ${B}/purchases/pu1`,
      `POST ${B}/purchases/pu1/checkout`, `POST ${B}/purchases/pu1/track`, `POST ${B}/purchases/pu1/close`,
    ]);
    assert.deepEqual(r.calls[0].body, { merchantUrl: 'https://m.example' });
    assert.deepEqual(r.calls[1].body, { merchantServerId: 'srv1', q: 'mug' });
    assert.deepEqual(r.calls[2].body, { merchantUrl: 'https://m.example', intent: 'buy mugs', maxAmountMinor: 5000, currency: 'USD', lines: [{ itemId: 'p1', quantity: 2 }] });
    assert.deepEqual(r.calls[6].body, { outcome: 'not_placed', reason: 'verified' });
  });

  it('purchases list renders a table; empty → message', async () => {
    let cap = capture();
    assert.equal(await runCli(['commerce', 'ucp-buyer', 'purchases', 'list', '--org', 'o'], opts(async () => jsonResponse({ purchases: [{ purchaseId: 'pu1', status: 'placed', merchantUrl: 'https://m', extOrderId: 'e1', createdAt: 't' }] }), cap)), 0);
    assert.match(cap.stdout, /pu1\s+placed\s+https:\/\/m\s+e1/);
    cap = capture();
    assert.equal(await runCli(['commerce', 'ucp-buyer', 'purchases', 'list', '--org', 'o'], opts(async () => jsonResponse({ purchases: [] }), cap)), 0);
    assert.match(cap.stdout, /No purchases/);
  });

  it('close without --outcome is a usage error', async () => {
    const cap = capture();
    assert.equal(await runCli(['commerce', 'ucp-buyer', 'purchases', 'close', 'pu1', '--org', 'o'], opts(async () => { throw new Error('no'); }, cap)), 2);
    assert.match(cap.stderr, /--outcome is required/);
  });
});

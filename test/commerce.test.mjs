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
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });
const O = '/v1/host/openwop-app/commerce/orgs/o1';

/** Run one command against a single-response mock; return {code, cap, seen}. */
async function run(argv, response = jsonResponse({}), json = false) {
  const cap = capture();
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined }); return typeof response === 'function' ? response() : response.clone(); };
  const code = await runCli([...(json ? ['--json'] : []), 'commerce', ...argv], opts(fetchImpl, cap));
  return { code, cap, seen };
}

describe('commerce products', () => {
  it('list forwards ?q and renders a table', async () => {
    const { code, cap, seen } = await run(['products', 'list', '--org', 'o1', '--q', 'mug'], jsonResponse({ products: [{ productId: 'p1', name: 'Mug', type: 'physical', price: 12.5, currency: 'USD', inventory: 3, active: true }] }));
    assert.equal(code, 0, cap.stderr);
    assert.equal(seen[0].url.pathname, `${O}/products`);
    assert.equal(seen[0].url.searchParams.get('q'), 'mug');
    assert.match(cap.stdout, /p1\s+Mug\s+physical\s+12\.5\s+USD\s+3\s+true/);
  });
  it('--json emits the host body verbatim', async () => {
    const body = { products: [] };
    const { code, cap } = await run(['products', 'list', '--org', 'o1'], jsonResponse(body), true);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });
  it('create sends typed fields; price passed through exactly', async () => {
    const { code, seen } = await run(['products', 'create', '--org', 'o1', '--name', 'Mug', '--price', '12.5', '--currency', 'USD', '--tags', '["a"]', '--inventory', '40'], jsonResponse({ productId: 'p2' }, 201));
    assert.equal(code, 0);
    assert.equal(seen[0].init.method, 'POST');
    assert.deepEqual(seen[0].body, { name: 'Mug', price: 12.5, currency: 'USD', tags: ['a'], inventory: 40 });
  });
  it('update PATCHes with an encoded id; movements reads the ledger', async () => {
    let r = await run(['products', 'update', 'p/1', '--org', 'o1', '--active', 'false']);
    assert.equal(r.seen[0].init.method, 'PATCH');
    assert.equal(r.seen[0].url.pathname, `${O}/products/p%2F1`);
    assert.deepEqual(r.seen[0].body, { active: false });
    r = await run(['products', 'movements', 'p1', '--org', 'o1'], jsonResponse({ movements: [] }));
    assert.equal(r.seen[0].url.pathname, `${O}/products/p1/movements`);
    assert.match(r.cap.stdout, /No stock movements/);
  });
  it('delete (204) requires --yes', async () => {
    let r = await run(['products', 'delete', 'p1', '--org', 'o1']);
    assert.equal(r.code, 2);
    assert.equal(r.seen.length, 0);
    r = await run(['products', 'delete', 'p1', '--org', 'o1', '--yes'], new Response(null, { status: 204 }));
    assert.equal(r.code, 0);
    assert.equal(r.seen[0].init.method, 'DELETE');
    assert.match(r.cap.stdout, /Deleted/);
  });
});

describe('commerce product-fields + price-lists + price', () => {
  it('product-fields create body', async () => {
    const { seen } = await run(['product-fields', 'create', '--org', 'o1', '--key', 'material', '--label', 'Material', '--type', 'select', '--options', '["wood","steel"]', '--required', 'true']);
    assert.equal(seen[0].url.pathname, `${O}/product-fields`);
    assert.deepEqual(seen[0].body, { key: 'material', label: 'Material', type: 'select', options: ['wood', 'steel'], required: true });
  });
  it('price-lists update PATCH + price get query', async () => {
    let r = await run(['price-lists', 'update', 'pl1', '--org', 'o1', '--priority', '5']);
    assert.equal(r.seen[0].init.method, 'PATCH');
    assert.equal(r.seen[0].url.pathname, `${O}/price-lists/pl1`);
    assert.deepEqual(r.seen[0].body, { priority: 5 });
    r = await run(['price', 'get', '--org', 'o1', '--product-id', 'p1', '--contact-id', 'c1'], jsonResponse({ price: 10, sellable: true }));
    assert.equal(r.seen[0].url.pathname, `${O}/price`);
    assert.equal(r.seen[0].url.searchParams.get('productId'), 'p1');
    assert.equal(r.seen[0].url.searchParams.get('contactId'), 'c1');
  });
});

describe('commerce orders', () => {
  it('create sends lines + idempotencyKey', async () => {
    const { seen } = await run(['orders', 'create', '--org', 'o1', '--lines', '[{"productId":"p1","quantity":2}]', '--idempotency-key', 'k1'], jsonResponse({ orderId: 'ord1' }, 201));
    assert.equal(seen[0].url.pathname, `${O}/orders`);
    assert.deepEqual(seen[0].body, { lines: [{ productId: 'p1', quantity: 2 }], idempotencyKey: 'k1' });
  });
  it('list --status and every action suffix hits its own route', async () => {
    let r = await run(['orders', 'list', '--org', 'o1', '--status', 'paid'], jsonResponse({ orders: [] }));
    assert.equal(r.seen[0].url.searchParams.get('status'), 'paid');
    r = await run(['orders', 'pay', 'ord1', '--org', 'o1', '--payment-intent-id', 'pi_1']);
    assert.equal(r.seen[0].url.pathname, `${O}/orders/ord1/pay`);
    assert.deepEqual(r.seen[0].body, { paymentIntentId: 'pi_1' });
    r = await run(['orders', 'fulfillment', 'ord1', '--org', 'o1', '--fulfillment-status', 'shipped']);
    assert.equal(r.seen[0].url.pathname, `${O}/orders/ord1/fulfillment`);
    assert.deepEqual(r.seen[0].body, { fulfillmentStatus: 'shipped' });
    for (const suffix of ['refund', 'cancel']) {
      r = await run(['orders', suffix, 'ord1', '--org', 'o1', '--yes']);
      assert.equal(r.seen[0].init.method, 'POST');
      assert.equal(r.seen[0].url.pathname, `${O}/orders/ord1/${suffix}`);
    }
    r = await run(['orders', 'partial-refund', 'ord1', '--org', 'o1', '--amount', '5', '--refund-key', 'adj-1', '--yes']);
    assert.deepEqual(r.seen[0].body, { amount: 5, refundKey: 'adj-1' });
    r = await run(['orders', 'refunds', 'ord1', '--org', 'o1'], jsonResponse({ refunds: [{ refundLedgerId: 'r1', amount: 5, currency: 'USD', refundKey: 'adj-1', provider: 'none', createdAt: 't' }] }));
    assert.match(r.cap.stdout, /r1\s+5\s+USD\s+adj-1\s+none/);
  });
  it('refund without --yes is refused before any request', async () => {
    const r = await run(['orders', 'refund', 'ord1', '--org', 'o1']);
    assert.equal(r.code, 2);
    assert.equal(r.seen.length, 0);
  });
});

describe('commerce cart', () => {
  it('set-item PUTs quantity; checkout POSTs; clear DELETEs', async () => {
    let r = await run(['cart', 'set-item', 'p1', '--org', 'o1', '--quantity', '3']);
    assert.equal(r.seen[0].init.method, 'PUT');
    assert.equal(r.seen[0].url.pathname, `${O}/cart/items/p1`);
    assert.deepEqual(r.seen[0].body, { quantity: 3 });
    r = await run(['cart', 'checkout', '--org', 'o1', '--coupon-code', 'SAVE']);
    assert.equal(r.seen[0].url.pathname, `${O}/cart/checkout`);
    assert.deepEqual(r.seen[0].body, { couponCode: 'SAVE' });
    r = await run(['cart', 'clear', '--org', 'o1', '--yes'], new Response(null, { status: 204 }));
    assert.equal(r.seen[0].init.method, 'DELETE');
    assert.equal(r.seen[0].url.pathname, `${O}/cart`);
  });
});

describe('commerce quotes', () => {
  it('create, revise, and send/decline/accept actions', async () => {
    let r = await run(['quotes', 'create', '--org', 'o1', '--lines', '[{"productId":"p1","quantity":1,"unitPrice":9}]', '--expires-in-days', '14']);
    assert.deepEqual(r.seen[0].body, { lines: [{ productId: 'p1', quantity: 1, unitPrice: 9 }], expiresInDays: 14 });
    r = await run(['quotes', 'revise', 'q1', '--org', 'o1', '--note', 'hi']);
    assert.equal(r.seen[0].init.method, 'PATCH');
    assert.equal(r.seen[0].url.pathname, `${O}/quotes/q1`);
    for (const suffix of ['send', 'decline', 'accept']) {
      r = await run(['quotes', suffix, 'q1', '--org', 'o1']);
      assert.equal(r.seen[0].init.method, 'POST');
      assert.equal(r.seen[0].url.pathname, `${O}/quotes/q1/${suffix}`);
    }
    r = await run(['quotes', 'revisions', 'q1', '--org', 'o1'], jsonResponse({ revisions: [] }));
    assert.equal(r.seen[0].url.pathname, `${O}/quotes/q1/revisions`);
  });
});

describe('commerce coupons + subscriptions + affiliates + reports', () => {
  it('coupons create', async () => {
    const { seen } = await run(['coupons', 'create', '--org', 'o1', '--code', 'SAVE10', '--type', 'percentage', '--value', '10']);
    assert.equal(seen[0].url.pathname, `${O}/coupons`);
    assert.deepEqual(seen[0].body, { code: 'SAVE10', type: 'percentage', value: 10 });
  });
  it('subscriptions create/cycle/cancel', async () => {
    let r = await run(['subscriptions', 'create', '--org', 'o1', '--product-id', 'p1', '--interval', 'monthly']);
    assert.deepEqual(r.seen[0].body, { productId: 'p1', interval: 'monthly' });
    r = await run(['subscriptions', 'cycle', 's1', '--org', 'o1']);
    assert.equal(r.seen[0].url.pathname, `${O}/subscriptions/s1/cycle`);
    r = await run(['subscriptions', 'cancel', 's1', '--org', 'o1', '--yes']);
    assert.equal(r.seen[0].init.method, 'DELETE');
    assert.equal(r.seen[0].url.pathname, `${O}/subscriptions/s1`);
  });
  it('affiliates create + payout; payouts list; reports summary', async () => {
    let r = await run(['affiliates', 'create', '--org', 'o1', '--code', 'BOB', '--commission-type', 'percentage', '--commission-rate', '10']);
    assert.deepEqual(r.seen[0].body, { code: 'BOB', commissionType: 'percentage', commissionRate: 10 });
    r = await run(['affiliates', 'payout', 'a1', '--org', 'o1']);
    assert.equal(r.seen[0].url.pathname, `${O}/affiliates/a1/payout`);
    r = await run(['payouts', 'list', '--org', 'o1'], jsonResponse({ payouts: [] }));
    assert.match(r.cap.stdout, /No payouts/);
    r = await run(['reports', 'summary', '--org', 'o1'], jsonResponse({ revenue: 100 }));
    assert.equal(r.seen[0].url.pathname, `${O}/reports/summary`);
    assert.deepEqual(JSON.parse(r.cap.stdout), { revenue: 100 });
  });
  it('payouts-csv writes the CSV text verbatim', async () => {
    const csv = 'code,name,currency,balance_owed,pending_payouts\n"BOB","Bob","USD",10,0';
    const { code, cap, seen } = await run(['affiliates', 'payouts-csv', '--org', 'o1'], new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }));
    assert.equal(code, 0);
    assert.equal(seen[0].url.pathname, `${O}/affiliates/payouts.csv`);
    assert.equal(cap.stdout, `${csv}\n`);
  });
});

describe('commerce public storefront', () => {
  it('public products sends NO authorization header', async () => {
    const { code, cap, seen } = await run(['public', 'products', '--org', 'o1', '--category', 'mugs'], jsonResponse({ products: [{ productId: 'p1', name: 'Mug', type: 'physical', price: 12, currency: 'USD' }], store: { name: 'S' } }));
    assert.equal(code, 0, cap.stderr);
    assert.equal(seen[0].url.pathname, '/v1/host/openwop-app/public-store/o1/products');
    assert.equal(seen[0].url.searchParams.get('category'), 'mugs');
    assert.equal(seen[0].init.headers.authorization, undefined);
    assert.match(cap.stdout, /p1\s+Mug/);
  });
  it('public checkout / one-click / accept-quote / product', async () => {
    let r = await run(['public', 'checkout', '--org', 'o1', '--email', 'a@b.co', '--lines', '[{"productId":"p1","quantity":1}]'], jsonResponse({ orderId: 'x', mode: 'demo' }, 201));
    assert.equal(r.seen[0].url.pathname, '/v1/host/openwop-app/public-store/o1/checkout');
    assert.deepEqual(r.seen[0].body, { email: 'a@b.co', lines: [{ productId: 'p1', quantity: 1 }] });
    assert.equal(r.seen[0].init.headers.authorization, undefined);
    r = await run(['public', 'one-click', 'ord1', '--org', 'o1', '--product-id', 'p2']);
    assert.equal(r.seen[0].url.pathname, '/v1/host/openwop-app/public-store/o1/orders/ord1/one-click');
    assert.deepEqual(r.seen[0].body, { productId: 'p2' });
    r = await run(['public', 'accept-quote', 'q1', '--org', 'o1', '--token', 'tok']);
    assert.equal(r.seen[0].url.pathname, '/v1/host/openwop-app/public-store/o1/quotes/q1/accept');
    assert.deepEqual(r.seen[0].body, { token: 'tok' });
    r = await run(['public', 'product', 'p1', '--org', 'o1'], jsonResponse({ product: { productId: 'p1' } }));
    assert.equal(r.seen[0].url.pathname, '/v1/host/openwop-app/public-store/o1/products/p1');
  });
});

describe('commerce errors', () => {
  it('403 → legible message + exit 4', async () => {
    const { code, cap } = await run(['orders', 'get', 'ord1', '--org', 'o1'], jsonResponse({ error: 'forbidden', message: 'Not permitted.' }, 403));
    assert.equal(code, 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: Not permitted\./);
  });
  it('unknown command is a usage error', async () => {
    const { code, cap } = await run(['widgets', 'list', '--org', 'o1']);
    assert.equal(code, 2);
    assert.match(cap.stderr, /Unknown commerce command/);
  });
});

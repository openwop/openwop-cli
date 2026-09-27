import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts, forbidden } from './helpers/mockHost.mjs';

const B = '/v1/host/openwop-app/billing';

describe('billing', () => {
  it('reads subscription / balance / entitlements / bundles', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ body: {
      [`${B}/subscription`]: { planTier: 'pro', status: 'active', quantity: 3 },
      [`${B}/balance`]: { totalAvailable: 500, purchasedTokensTotal: 1000 },
      [`${B}/entitlements`]: { plan: 'pro', allowedFeatures: '*', limits: { seats: 10 } },
      [`${B}/bundles`]: { bundles: [{ bundleId: 'crm', forSale: true, owned: false, priceDisplay: '$9' }] },
    }[c.path] }));
    for (const s of ['subscription', 'balance', 'entitlements', 'bundles']) {
      assert.equal(await runCli(['billing', s], opts(fetchImpl, cap)), 0, cap.stderr);
    }
    assert.deepEqual(calls.map((c) => c.path), [`${B}/subscription`, `${B}/balance`, `${B}/entitlements`, `${B}/bundles`]);
    assert.match(cap.stdout, /plan:\s+pro \(active\)/);
    assert.match(cap.stdout, /tokens available: 500/);
    assert.match(cap.stdout, /allowed features: all/);
    assert.match(cap.stdout, /crm\s+yes\s+no\s+\$9/);
  });

  it('checkout / bundle-checkout / portal return URLs only', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { url: 'https://checkout.stripe.com/x', mode: 'live' } }));
    assert.equal(await runCli(['billing', 'checkout', '--price', 'price_1'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual([calls[0].method, calls[0].path, calls[0].body], ['POST', `${B}/checkout`, { priceId: 'price_1' }]);
    await runCli(['billing', 'bundle-checkout', 'crm/pro'], opts(fetchImpl, cap));
    assert.equal(calls[1].path, `${B}/bundles/crm%2Fpro/checkout`);
    await runCli(['billing', 'portal'], opts(fetchImpl, cap));
    assert.equal(calls[2].path, `${B}/portal`);
    assert.match(cap.stdout, /https:\/\/checkout\.stripe\.com\/x/);
  });

  it('invoices list/get and --json', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ body: c.path.endsWith('/invoices') ? { invoices: [{ invoiceId: 'inv:1', planTier: 'pro', amount: 10, currency: 'USD' }] } : { invoiceId: 'inv:1', markdown: '# Invoice inv:1' } }));
    await runCli(['billing', 'invoices'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /inv:1\s+pro\s+10 USD/);
    await runCli(['billing', 'invoices', 'get', 'inv:1'], opts(fetchImpl, cap));
    assert.equal(calls[1].path, `${B}/invoices/inv%3A1`);
    assert.match(cap.stdout, /# Invoice inv:1/);
    const cap2 = capture();
    await runCli(['--json', 'billing', 'invoices'], opts(fetchImpl, cap2));
    assert.equal(JSON.parse(cap2.stdout).invoices.length, 1);
  });

  it('super-admin ops send exact bodies and fail closed (exit 4)', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: {} }));
    await runCli(['billing', 'coupons', 'create', '--code', 'LAUNCH', '--type', 'fixed', '--value', '5'], opts(fetchImpl, cap));
    assert.deepEqual(calls[0].body, { code: 'LAUNCH', type: 'fixed', value: 5 });
    await runCli(['billing', 'invoices', 'create', '--amount', '12', '--currency', 'EUR'], opts(fetchImpl, cap));
    assert.deepEqual([calls[1].path, calls[1].body], [`${B}/invoices`, { amount: 12, currency: 'EUR' }]);
    const dir = mkdtempSync(join(tmpdir(), 'owp-bill-'));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ subscriptions: [], balances: [] }));
    await runCli(['billing', 'import', '--body-file', join(dir, 'b.json')], opts(fetchImpl, cap));
    assert.deepEqual([calls[2].path, calls[2].body], [`${B}/import`, { subscriptions: [], balances: [] }]);
    await runCli(['billing', 'sync-seats'], opts(fetchImpl, cap));
    assert.equal(calls[3].path, `${B}/sync-seats`);

    const cap2 = capture();
    const denied = mockHost(() => forbidden);
    assert.equal(await runCli(['billing', 'sync-seats'], opts(denied.fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /super-admin/);
  });

  it('refuses the Stripe webhook locally', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: {} }));
    assert.equal(await runCli(['billing', 'webhook'], opts(fetchImpl, cap)), 2);
    assert.equal(calls.length, 0);
  });
});

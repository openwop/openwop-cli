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
const B = '/v1/host/openwop-app/recommendations/orgs/o';

describe('recommendations', () => {
  it('placements list renders rows', async () => {
    const cap = capture();
    const r = recorder({ placements: [{ placementId: 'pl1', slot: 'pdp', source: 'upsell', holdoutPct: 10, active: true }] });
    assert.equal(await runCli(['recommendations', 'placements', 'list', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${B}/placements`);
    assert.match(cap.stdout, /pl1\s+pdp\s+upsell\s+10\s+true/);
  });

  it('placements create posts typed fields; update PATCHes; delete needs --yes', async () => {
    let r = recorder({ placement: { placementId: 'pl1' } }, 201);
    assert.equal(await runCli(['recommendations', 'placements', 'create', '--org', 'o', '--slot', 'pdp', '--source', 'bought_together', '--holdout-pct', '10', '--active', 'true'], opts(r.fetchImpl, capture())), 0);
    assert.deepEqual(r.calls[0].body, { slot: 'pdp', source: 'bought_together', holdoutPct: 10, active: true });
    r = recorder({ placement: {} });
    assert.equal(await runCli(['recommendations', 'placements', 'update', 'pl1', '--org', 'o', '--active', 'false'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'PATCH');
    assert.equal(r.calls[0].url.pathname, `${B}/placements/pl1`);
    assert.deepEqual(r.calls[0].body, { active: false });
    assert.equal(await runCli(['recommendations', 'placements', 'delete', 'pl1', '--org', 'o'], opts(async () => { throw new Error('no'); }, capture())), 2);
  });

  it('affinity-rebuild POSTs; resolve forwards query params', async () => {
    let r = recorder({ ok: true, rows: 3, removed: 0 });
    assert.equal(await runCli(['recommendations', 'affinity-rebuild', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'POST');
    assert.equal(r.calls[0].url.pathname, `${B}/affinity/rebuild`);
    const cap = capture();
    r = recorder({ products: [{ productId: 'p1', name: 'Mug', price: 1200, currency: 'USD' }] });
    assert.equal(await runCli(['recommendations', 'resolve', '--org', 'o', '--slot', 'pdp', '--product-id', 'p9', '--limit', '4'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/resolve`);
    assert.equal(r.calls[0].url.search, '?slot=pdp&productId=p9&limit=4');
    assert.match(cap.stdout, /p1\s+Mug\s+1200\s+USD/);
  });

  it('resolve without --slot is a usage error', async () => {
    const cap = capture();
    assert.equal(await runCli(['recommendations', 'resolve', '--org', 'o'], opts(async () => { throw new Error('no'); }, cap)), 2);
    assert.match(cap.stderr, /--slot is required/);
  });

  it('public resolve is unauthenticated; --json passes through', async () => {
    const cap = capture();
    const body = { products: [] };
    const r = recorder(body);
    assert.equal(await runCli(['--json', 'recommendations', 'public', 'resolve', '--org', 'org:1', '--slot', 'home'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.pathname, '/v1/host/openwop-app/public-recommendations/org%3A1/resolve');
    assert.equal(r.calls[0].init.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('403 → exit 4', async () => {
    const cap = capture();
    assert.equal(await runCli(['recommendations', 'placements', 'list', '--org', 'o'], opts(async () => jsonResponse({ message: 'nope' }, 403), cap)), 4);
    assert.match(cap.stderr, /HTTP 403( [a-z_]+)?: nope/);
  });
});

describe('sales-maps', () => {
  it('geocode POSTs address + numeric lat/lng', async () => {
    const cap = capture();
    const r = recorder({ address: '1 Main', lat: 1, lng: 2, source: 'manual' });
    assert.equal(await runCli(['sales-maps', 'geocode', '--org', 'o', '--address', '1 Main', '--lat', '1', '--lng', '2'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, '/v1/host/openwop-app/sales-maps/orgs/o/geocode');
    assert.deepEqual(r.calls[0].body, { address: '1 Main', lat: 1, lng: 2 });
    assert.match(cap.stdout, /"source": "manual"/);
  });

  it('403 → exit 4', async () => {
    assert.equal(await runCli(['sales-maps', 'geocode', '--org', 'o', '--address', 'x'], opts(async () => jsonResponse({}, 403), capture())), 4);
  });
});

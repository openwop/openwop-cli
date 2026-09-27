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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so the mock sees the literal /v1/host/openwop-app paths (no discovery fetch).
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });

/** A fetch mock that records every call and answers from `reply(url, init)`. */
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    let body;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body, headers: init.headers ?? {}, redirect: init.redirect });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}
const lines = (r) => r.calls.map((c) => `${c.method} ${c.path}${c.search}`);

const D = '/v1/host/openwop-app/discovery/orgs/org_1';

describe('discovery command', () => {
  it('collections renders a table; --json prints the raw body', async () => {
    const cap = capture();
    const r = recorder(() => json({ collections: [{ collectionId: 'c_1', name: 'Summer', type: 'manual', active: true, productIds: ['p1', 'p2'] }] }));
    assert.equal(await runCli(['discovery', 'collections', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.match(cap.stdout, /c_1\s+Summer\s+manual\s+true\s+2/);
    const cap2 = capture();
    assert.equal(await runCli(['discovery', 'collections', '--org', 'org_1', '--json'], opts(r.fetchImpl, cap2)), 0);
    assert.equal(JSON.parse(cap2.stdout).collections[0].collectionId, 'c_1');
    assert.deepEqual(lines(r), [`GET ${D}/collections`, `GET ${D}/collections`]);
  });

  it('collection-create / update / resolve / delete hit their paths with the right bodies', async () => {
    const cap = capture();
    const r = recorder(() => json({ collection: { collectionId: 'c/1' }, products: [], ok: true }));
    assert.equal(await runCli(['discovery', 'collection-create', '--org', 'org_1', '--name', 'S', '--type', 'rule', '--product-id', 'p1', '--product-id', 'p2', '--rule-json', '{"tag":"x"}', '--parent', 'c_0'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['discovery', 'collection-update', 'c/1', '--org', 'org_1', '--active', 'false'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['discovery', 'collection-resolve', 'c/1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['discovery', 'collection-delete', 'c/1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['discovery', 'collection-delete', 'c/1', '--org', 'org_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(lines(r), [`POST ${D}/collections`, `PATCH ${D}/collections/c%2F1`, `GET ${D}/collections/c%2F1/resolve`, `DELETE ${D}/collections/c%2F1`]);
    assert.deepEqual(r.calls[0].body, { name: 'S', type: 'rule', productIds: ['p1', 'p2'], rule: { tag: 'x' }, parentId: 'c_0' });
    assert.deepEqual(r.calls[1].body, { active: false });
  });

  it('rules list/create/delete + embeddings rebuild', async () => {
    const cap = capture();
    const r = recorder(() => json({ rules: [], rule: { ruleId: 'r_1' }, ok: true, products: 4 }));
    assert.equal(await runCli(['discovery', 'rules', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['discovery', 'rule-create', '--org', 'org_1', '--name', 'Boost', '--actions-json', '[{"kind":"boost"}]', '--holdout-pct', '10'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['discovery', 'rule-delete', 'r_1', '--org', 'org_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['discovery', 'embeddings-rebuild', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(lines(r), [`GET ${D}/rules`, `POST ${D}/rules`, `DELETE ${D}/rules/r_1`, `POST ${D}/embeddings/rebuild`]);
    assert.deepEqual(r.calls[1].body, { name: 'Boost', actions: [{ kind: 'boost' }], holdoutPct: 10 });
    assert.match(cap.stdout, /No merchandising rules\./);
    assert.match(cap.stdout, /4 products/);
  });

  it('search sends q/collectionId/filters[k]/sessionKey; public search is anonymous', async () => {
    const cap = capture();
    const r = recorder(() => json({ products: [{ productId: 'p1', name: 'Shoe', type: 'physical', price: 10, currency: 'USD' }], facets: [] }));
    assert.equal(await runCli(['discovery', 'search', '--org', 'org_1', '--q', 'shoe', '--collection', 'c_1', '--filter', 'color=red', '--session-key', 's1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['discovery', 'public', 'search', 'org_1', '--q', 'shoe'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    const q = new URLSearchParams(r.calls[0].search);
    assert.equal(r.calls[0].path, `${D}/search`);
    assert.equal(q.get('q'), 'shoe');
    assert.equal(q.get('collectionId'), 'c_1');
    assert.equal(q.get('filters[color]'), 'red');
    assert.equal(q.get('sessionKey'), 's1');
    assert.equal(`${r.calls[1].path}${r.calls[1].search}`, '/v1/host/openwop-app/public-discovery/org_1/search?q=shoe');
    assert.ok(r.calls[0].headers.authorization);
    assert.ok(!r.calls[1].headers.authorization);
    assert.match(cap.stdout, /p1\s+Shoe\s+physical\s+10\s+USD/);
  });

  it('a 403 is a legible message with exit 4; missing --name is a usage error', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' }, 403));
    assert.equal(await runCli(['discovery', 'rule-create', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['discovery', 'embeddings-rebuild', '--org', 'org_1'], opts(r.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /HTTP 403(?: \S+)?: Missing required scope/);
  });
});

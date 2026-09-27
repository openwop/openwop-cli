// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}

const B = '/v1/host/openwop-app/cdp';

describe('cdp command', () => {
  it('resolve GETs identity/resolve with type + value', async () => {
    const cap = capture();
    const r = recorder(() => json({ customerId: 'cu_1', masked: false }));
    assert.equal(await runCli(['cdp', 'resolve', '--type', 'email', '--value', 'a@b.co'], opts(r.fetchImpl, cap)), 0);
    assert.equal(`${r.calls[0].path}${r.calls[0].search}`, `${B}/identity/resolve?type=email&value=a%40b.co`);
    assert.match(cap.stdout, /cu_1/);
  });

  it('schemas list/register and validate (valid → 0, 422 invalid → 1 with errors)', async () => {
    const cap = capture();
    const r = recorder((u) => {
      if (u.pathname.endsWith('/validate')) return json({ valid: false, errors: [{ path: '/amount', message: 'must be number' }] }, 422);
      return json({ schemas: [{ eventType: 'order.placed', version: 1 }], eventType: 'order.placed', version: 2 }, 201);
    });
    assert.equal(await runCli(['cdp', 'schemas', 'list'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'schemas', 'register', '--event-type', 'order.placed', '--schema-json', '{"type":"object"}'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'schemas', 'validate', 'order.placed', '--payload-json', '{"amount":"x"}'], opts(r.fetchImpl, cap)), 1);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`GET ${B}/event-schemas`, `POST ${B}/event-schemas`, `POST ${B}/event-schemas/order.placed/validate`]);
    assert.deepEqual(r.calls[1].body, { eventType: 'order.placed', schema: { type: 'object' } });
    assert.deepEqual(r.calls[2].body, { payload: { amount: 'x' } });
    assert.match(cap.stdout, /order\.placed\s+1/);
    assert.match(cap.stdout, /invalid\n\s+- \/amount must be number/);
  });

  it('collect / collect-batch / import POST the mirrored bodies', async () => {
    const cap = capture();
    const r = recorder(() => json({ eventId: 'ev_1', accepted: 1 }, 201));
    assert.equal(await runCli(['cdp', 'collect', '--event-type', 'page.viewed', '--payload-json', '{"path":"/"}', '--dedupe-key', 'k1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'collect-batch', '--events-json', '[{"eventType":"a","payload":{}}]'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'import', '--csv-file', 'package.json', '--event-type', 'x', '--dedup-key-field', 'id'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`POST ${B}/collect`, `POST ${B}/collect/batch`, `POST ${B}/collect/import`]);
    assert.deepEqual(r.calls[0].body, { eventType: 'page.viewed', payload: { path: '/' }, dedupeKey: 'k1' });
    assert.deepEqual(r.calls[1].body, { events: [{ eventType: 'a', payload: {} }] });
    assert.equal(r.calls[2].body.eventType, 'x');
    assert.equal(r.calls[2].body.dedupKeyField, 'id');
    assert.match(r.calls[2].body.csv, /"name"/);
    assert.match(cap.stdout, /Collected page\.viewed event ev_1/);
  });

  it('events / merge-events / governance pass --limit; audit-verify reports the chain', async () => {
    const cap = capture();
    const r = recorder((u) => (u.pathname.endsWith('/verify') ? json({ ok: false, brokenAt: 3, length: 9 }) : json({ events: [], decisions: [] })));
    assert.equal(await runCli(['cdp', 'events', '--limit', '5'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'merge-events'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'governance', '--limit', '50'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['cdp', 'audit-verify'], opts(r.fetchImpl, cap)), 1);
    assert.deepEqual(r.calls.map((c) => `${c.path}${c.search}`), [
      `${B}/collected-events?limit=5`, `${B}/merge-events`, `${B}/governance-decisions?limit=50`, `${B}/audit-chain/verify`,
    ]);
    assert.match(cap.stdout, /audit chain: BROKEN \(length 9\)\nbrokenAt: 3/);
  });

  it('--json prints the raw body; a 403 on audit-verify exits 4', async () => {
    const cap = capture();
    const r = recorder(() => json({ schemas: [] }));
    assert.equal(await runCli(['cdp', 'schemas', 'list', '--json'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { schemas: [] });
    const cap2 = capture();
    const r2 = recorder(() => json({ error: 'forbidden', message: 'Audit-chain verification requires an admin role.' }, 403));
    assert.equal(await runCli(['cdp', 'audit-verify'], opts(r2.fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /HTTP 403(?: \S+)?: Audit-chain verification requires an admin role/);
  });
});

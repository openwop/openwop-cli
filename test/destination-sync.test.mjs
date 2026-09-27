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

const B = '/v1/host/openwop-app/destination-sync/syncs';

describe('destination-sync command', () => {
  it('list renders a table; get prints the sync', async () => {
    const cap = capture();
    const r = recorder(() => json({ syncs: [{ id: 'ds_1', name: 'Hook', destinationKind: 'webhook', sourceObject: 'contact', syncMode: 'incremental' }] }));
    assert.equal(await runCli(['destination-sync', 'list'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['destination-sync', 'get', 'ds/1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`GET ${B}`, `GET ${B}/ds%2F1`]);
    assert.match(cap.stdout, /ds_1\s+Hook\s+webhook\s+contact\s+incremental/);
  });

  it('create POSTs flags + --body extras; update PATCHes only passed fields', async () => {
    const cap = capture();
    const r = recorder(() => json({ id: 'ds_9' }, 201));
    assert.equal(await runCli(['destination-sync', 'create', '--name', 'N', '--destination-kind', 'bigquery', '--field-map-json', '[{"from":"a","to":"b"}]', '--sync-mode', 'full', '--connection', 'cn_1', '--body', '{"project":"p","dataset":"d","table":"t"}'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['destination-sync', 'update', 'ds_9', '--cursor-field', 'updatedAt'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`POST ${B}`, `PATCH ${B}/ds_9`]);
    assert.deepEqual(r.calls[0].body, { project: 'p', dataset: 'd', table: 't', name: 'N', destinationKind: 'bigquery', fieldMap: [{ from: 'a', to: 'b' }], syncMode: 'full', connectionId: 'cn_1' });
    assert.deepEqual(r.calls[1].body, { cursorField: 'updatedAt' });
    assert.match(cap.stdout, /Created destination sync ds_9/);
  });

  it('delete refuses without --yes, then DELETEs (204)', async () => {
    const cap = capture();
    const r = recorder(() => new Response(null, { status: 204 }));
    assert.equal(await runCli(['destination-sync', 'delete', 'ds_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['destination-sync', 'delete', 'ds_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`DELETE ${B}/ds_1`]);
  });

  it('dry-run / prepare / advance POST sample, records, cursor', async () => {
    const cap = capture();
    const r = recorder(() => json({ mapped: { b: 1 }, cursor: 'c2' }));
    assert.equal(await runCli(['destination-sync', 'dry-run', 'ds_1', '--sample-json', '{"a":1}'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['destination-sync', 'prepare', 'ds_1', '--records-json', '[{"a":1}]'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['destination-sync', 'advance', 'ds_1', '--cursor', 'c2'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`POST ${B}/ds_1/dry-run`, `POST ${B}/ds_1/prepare`, `POST ${B}/ds_1/advance`]);
    assert.deepEqual(r.calls.map((c) => c.body), [{ sample: { a: 1 } }, { records: [{ a: 1 }] }, { cursor: 'c2' }]);
    assert.match(cap.stdout, /"b": 1/);
    assert.match(cap.stdout, /Advanced the cursor of ds_1 to c2/);
  });

  it('--json raw body; 403 exits 4; advance without --cursor is a usage error', async () => {
    const cap = capture();
    const r = recorder(() => json({ syncs: [] }));
    assert.equal(await runCli(['destination-sync', 'list', '--json'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { syncs: [] });
    assert.equal(await runCli(['destination-sync', 'advance', 'ds_1'], opts(r.fetchImpl, cap)), 2);
    const cap2 = capture();
    const r2 = recorder(() => json({ error: 'forbidden', message: 'Destination Sync is not enabled for this plan.' }, 403));
    assert.equal(await runCli(['destination-sync', 'list'], opts(r2.fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /HTTP 403(?: \S+)?: Destination Sync is not enabled/);
  });
});

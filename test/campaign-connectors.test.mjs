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

const B = '/v1/host/openwop-app/campaign-connectors';

describe('campaign-connectors command', () => {
  it('platforms / records / kpi / sync-status hit their GET paths with the right query', async () => {
    const cap = capture();
    const r = recorder(() => json({ platforms: ['meta', 'google'], records: [{ date: '2026-09-01', platform: 'meta', spend: 10 }] }));
    assert.equal(await runCli(['campaign-connectors', 'platforms'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'records', '--org', 'org_1', '--campaign', 'c 1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'kpi', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'sync-status', '--org', 'org/1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
      `GET ${B}/platforms`, `GET ${B}/records?orgId=org_1&campaignId=c+1`, `GET ${B}/kpi?orgId=org_1`, `GET ${B}/orgs/org%2F1/sync-status`,
    ]);
    assert.match(cap.stdout, /meta\ngoogle/);
    assert.match(cap.stdout, /2026-09-01\s+meta/);
  });

  it('sync and audience-sync POST the mirrored bodies', async () => {
    const cap = capture();
    const r = recorder(() => json({ outcome: 'synced', imported: 4 }));
    assert.equal(await runCli(['campaign-connectors', 'sync', '--org', 'org_1', '--platform', 'meta'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'audience-sync', '--org', 'org_1', '--segment', 'seg_1', '--ad-account', 'act_1', '--platform', 'google', '--audience-name', 'VIP'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`POST ${B}/sync`, `POST ${B}/audience-sync`]);
    assert.deepEqual(r.calls[0].body, { orgId: 'org_1', platform: 'meta' });
    assert.deepEqual(r.calls[1].body, { orgId: 'org_1', segmentId: 'seg_1', adAccountId: 'act_1', platform: 'google', audienceName: 'VIP' });
    assert.match(cap.stdout, /Sync synced \(4 imported\)/);
  });

  it('import reads --csv-file and posts csv + mapping', async () => {
    const cap = capture();
    const dir = mkdtempSync(join(tmpdir(), 'owcc-'));
    const file = join(dir, 'perf.csv');
    writeFileSync(file, 'date,spend\n2026-09-01,10\n');
    const r = recorder(() => json({ imported: 1, deduped: 0, invalid: 0 }, 201));
    const code = await runCli(['campaign-connectors', 'import', '--org', 'org_1', '--csv-file', file, '--mapping-json', '{"spend":"Cost"}', '--default-platform', 'meta', '--campaign', 'c1', '--preset', 'meta-ads'], opts(r.fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(r.calls[0].body, { orgId: 'org_1', csv: 'date,spend\n2026-09-01,10\n', mapping: { spend: 'Cost' }, defaultPlatform: 'meta', campaignId: 'c1', preset: 'meta-ads' });
    assert.match(cap.stdout, /Imported 1 rows/);
  });

  it('pixels list/set/delete and conversions list/dispatch', async () => {
    const cap = capture();
    const r = recorder(() => json({ pixels: [], pixel: { platform: 'meta', pixelId: '123' }, conversions: [], sent: 2, ok: true }));
    assert.equal(await runCli(['campaign-connectors', 'pixels', 'list', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'pixels', 'set', '--org', 'org_1', '--platform', 'meta', '--pixel-id', '123', '--active', 'false'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'pixels', 'delete', 'meta', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['campaign-connectors', 'pixels', 'delete', 'meta', '--org', 'org_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'conversions', 'list', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'conversions', 'dispatch', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    const O = `${B}/orgs/org_1`;
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [
      `GET ${O}/pixels`, `PUT ${O}/pixels`, `DELETE ${O}/pixels/meta`, `GET ${O}/conversions`, `POST ${O}/conversions/dispatch`,
    ]);
    assert.deepEqual(r.calls[1].body, { platform: 'meta', pixelId: '123', active: false });
    assert.match(cap.stdout, /Dispatched 2 queued conversions/);
  });

  it('public pixels / conversion hit the anonymous legs without a bearer', async () => {
    const cap = capture();
    const r = recorder((u) => (u.pathname.endsWith('/pixels') ? json({ pixels: [{ platform: 'meta', pixelId: '9' }] }) : json({ recorded: true, eventId: 'e1', deduped: false }, 202)));
    assert.equal(await runCli(['campaign-connectors', 'public', 'pixels', 'org_1', '--vk', 'v1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['campaign-connectors', 'public', 'conversion', 'org_1', '--vk', 'v1', '--event-id', 'e1', '--event-name', 'Purchase', '--value', '9.5', '--currency', 'USD'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
      'GET /v1/host/openwop-app/public/org_1/pixels?vk=v1', 'POST /v1/host/openwop-app/public/org_1/conversions',
    ]);
    assert.deepEqual(r.calls[1].body, { vk: 'v1', eventId: 'e1', eventName: 'Purchase', value: 9.5, currency: 'USD' });
    assert.ok(r.calls.every((c) => !c.headers.authorization));
    assert.match(cap.stdout, /meta\s+9/);
    assert.match(cap.stdout, /Recorded conversion e1/);
  });

  it('--json prints the raw body', async () => {
    const cap = capture();
    const r = recorder(() => json({ totals: { spend: 1 } }));
    assert.equal(await runCli(['campaign-connectors', 'kpi', '--org', 'org_1', '--json'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { totals: { spend: 1 } });
  });

  it('a 403 is legible with exit 4; missing --org is a usage error', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' }, 403));
    assert.equal(await runCli(['campaign-connectors', 'sync', '--org', 'org_1', '--platform', 'meta'], opts(r.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /HTTP 403(?: \S+)?: Missing required scope/);
    assert.equal(await runCli(['campaign-connectors', 'kpi'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 1);
  });
});

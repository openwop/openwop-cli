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
const B = '/v1/host/openwop-app/territories/orgs/o';
const M = `${B}/models/m%3A1`;

describe('territories', () => {
  it('types list/create', async () => {
    const cap = capture();
    let r = recorder({ types: [{ territoryTypeId: 't1', name: 'Region', priority: 1 }] });
    assert.equal(await runCli(['territories', 'types', 'list', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.match(cap.stdout, /t1\s+Region\s+1/);
    r = recorder({ territoryTypeId: 't2' }, 201);
    assert.equal(await runCli(['territories', 'types', 'create', '--org', 'o', '--name', 'Metro', '--priority', '2'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/types`);
    assert.deepEqual(r.calls[0].body, { name: 'Metro', priority: 2 });
  });

  it('active + models list/get/create', async () => {
    let r = recorder({ activeModelId: 'm:1' });
    const cap = capture();
    assert.equal(await runCli(['--json', 'territories', 'active', '--org', 'o'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/active`);
    assert.deepEqual(JSON.parse(cap.stdout), { activeModelId: 'm:1' });
    r = recorder({ models: [], activeModelId: null });
    const cap2 = capture();
    assert.equal(await runCli(['territories', 'models', 'list', '--org', 'o'], opts(r.fetchImpl, cap2)), 0);
    assert.match(cap2.stdout, /No territory models/);
    r = recorder({ modelId: 'm:1' });
    assert.equal(await runCli(['territories', 'models', 'get', 'm:1', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, M);
    r = recorder({ modelId: 'm:2' }, 201);
    assert.equal(await runCli(['territories', 'models', 'create', '--org', 'o', '--name', 'FY27'], opts(r.fetchImpl, capture())), 0);
    assert.deepEqual(r.calls[0].body, { name: 'FY27' });
  });

  it('activate/archive POST to the literal transition routes; delete needs --yes', async () => {
    for (const t of ['activate', 'archive']) {
      const r = recorder({ review: { approvalId: 'a', status: 'pending' } }, 202);
      assert.equal(await runCli(['territories', 'models', t, 'm:1', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
      assert.equal(r.calls[0].init.method, 'POST');
      assert.equal(r.calls[0].url.pathname, `${M}/${t}`);
    }
    assert.equal(await runCli(['territories', 'models', 'delete', 'm:1', '--org', 'o'], opts(async () => { throw new Error('no'); }, capture())), 2);
    const r = recorder({ success: true, removed: 4 });
    assert.equal(await runCli(['territories', 'models', 'delete', 'm:1', '--org', 'o', '--yes'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'DELETE');
  });

  it('preview/quotas/attainment reads forward --period', async () => {
    for (const [cmd, suffix] of [['preview', 'preview'], ['quotas', 'quotas'], ['attainment', 'attainment']]) {
      const r = recorder({ quotas: [] });
      const args = ['territories', 'models', cmd, 'm:1', '--org', 'o'];
      if (cmd !== 'preview') args.push('--period', '2026-Q4');
      assert.equal(await runCli(args, opts(r.fetchImpl, capture())), 0);
      assert.equal(r.calls[0].url.pathname, `${M}/${suffix}`);
      if (cmd !== 'preview') assert.equal(r.calls[0].url.searchParams.get('period'), '2026-Q4');
    }
  });

  it('territories create/update/list', async () => {
    let r = recorder({ territoryId: 'terr:1' }, 201);
    assert.equal(await runCli(['territories', 'territories', 'create', 'm:1', '--org', 'o', '--name', 'West', '--member-subject-ids', 'u1,u2', '--region-id', 'us-west'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${M}/territories`);
    assert.deepEqual(r.calls[0].body, { name: 'West', memberSubjectIds: ['u1', 'u2'], regionId: 'us-west' });
    r = recorder({ territoryId: 'terr:1' });
    assert.equal(await runCli(['territories', 'territories', 'update', 'm:1', 'terr:1', '--org', 'o', '--manager-subject-id', 'u9'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'PATCH');
    assert.equal(r.calls[0].url.pathname, `${M}/territories/terr%3A1`);
    assert.deepEqual(r.calls[0].body, { managerSubjectId: 'u9' });
    const cap = capture();
    r = recorder({ territories: [{ territoryId: 'terr:1', name: 'West' }] });
    assert.equal(await runCli(['territories', 'territories', 'list', 'm:1', '--org', 'o'], opts(r.fetchImpl, cap)), 0);
    assert.match(cap.stdout, /terr:1\s+West/);
  });

  it('rules list/create/delete (204)', async () => {
    let r = recorder({ ruleId: 'r1' }, 201);
    assert.equal(await runCli(['territories', 'rules', 'create', 'm:1', '--org', 'o', '--territory-id', 'terr:1', '--target', 'company', '--filter', '{"field":"state","op":"eq","value":"CA"}', '--priority', '5'], opts(r.fetchImpl, capture())), 0);
    assert.deepEqual(r.calls[0].body, { territoryId: 'terr:1', target: 'company', filter: { field: 'state', op: 'eq', value: 'CA' }, priority: 5 });
    r = recorder({ rules: [] });
    assert.equal(await runCli(['territories', 'rules', 'list', 'm:1', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${M}/rules`);
    const cap = capture();
    r = recorder(null, 204);
    assert.equal(await runCli(['territories', 'rules', 'delete', 'm:1', 'r1', '--org', 'o', '--yes'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${M}/rules/r1`);
    assert.match(cap.stdout, /Deleted/);
  });

  it('quota set PUTs the whole quota; clear sends ?period and needs --yes', async () => {
    let r = recorder({ quotaId: 'q1' });
    assert.equal(await runCli(['territories', 'quota', 'set', 'm:1', 'terr:1', '--org', 'o', '--period', '2026-Q4', '--amount', '500000', '--currency', 'USD'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'PUT');
    assert.equal(r.calls[0].url.pathname, `${M}/territories/terr%3A1/quota`);
    assert.deepEqual(r.calls[0].body, { period: '2026-Q4', amount: 500000, currency: 'USD' });
    assert.equal(await runCli(['territories', 'quota', 'clear', 'm:1', 'terr:1', '--org', 'o', '--period', '2026-Q4'], opts(async () => { throw new Error('no'); }, capture())), 2);
    r = recorder(null, 204);
    assert.equal(await runCli(['territories', 'quota', 'clear', 'm:1', 'terr:1', '--org', 'o', '--period', '2026-Q4', '--yes'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'DELETE');
    assert.equal(r.calls[0].url.searchParams.get('period'), '2026-Q4');
  });

  it('reassign POSTs; 403 → exit 4', async () => {
    const r = recorder({ assigned: 3 });
    assert.equal(await runCli(['territories', 'reassign', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/reassign`);
    assert.equal(r.calls[0].init.method, 'POST');
    const cap = capture();
    assert.equal(await runCli(['territories', 'reassign', '--org', 'o'], opts(async () => jsonResponse({ message: 'Requires host:territories:manage.' }, 403), cap)), 4);
    assert.match(cap.stderr, /HTTP 403/);
  });
});

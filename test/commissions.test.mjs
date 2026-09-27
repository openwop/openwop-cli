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
const B = '/v1/host/openwop-app/commissions/orgs/o';

describe('commissions', () => {
  it('plans list renders rows', async () => {
    const cap = capture();
    const r = recorder({ plans: [{ planId: 'plan:1', name: 'AE', currency: 'USD', effectiveFrom: '2026-01-01' }] });
    assert.equal(await runCli(['commissions', 'plans', 'list', '--org', 'o'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].url.pathname, `${B}/plans`);
    assert.match(cap.stdout, /plan:1\s+AE\s+USD\s+2026-01-01/);
  });

  it('plans create posts json assignment/rules verbatim', async () => {
    const r = recorder({ planId: 'plan:2' }, 201);
    const rules = [{ basis: 'deal-won', type: 'percentage', rate: 8 }];
    assert.equal(await runCli(['commissions', 'plans', 'create', '--org', 'o', '--name', 'AE', '--currency', 'USD', '--effective-from', '2026-01-01', '--assignment', '{"kind":"role","ref":"ae"}', '--rules', JSON.stringify(rules)], opts(r.fetchImpl, capture())), 0);
    assert.deepEqual(r.calls[0].body, { name: 'AE', currency: 'USD', assignment: { kind: 'role', ref: 'ae' }, rules, effectiveFrom: '2026-01-01' });
  });

  it('plans update PATCHes; delete needs --yes', async () => {
    const r = recorder({ planId: 'plan:1' });
    assert.equal(await runCli(['commissions', 'plans', 'update', 'plan:1', '--org', 'o', '--effective-to', '2026-12-31'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].init.method, 'PATCH');
    assert.equal(r.calls[0].url.pathname, `${B}/plans/plan%3A1`);
    assert.deepEqual(r.calls[0].body, { effectiveTo: '2026-12-31' });
    assert.equal(await runCli(['commissions', 'plans', 'delete', 'plan:1', '--org', 'o'], opts(async () => { throw new Error('no'); }, capture())), 2);
  });

  it('plans compute POSTs subjectId + period', async () => {
    const r = recorder({ statementId: 's1', total: 1234 }, 201);
    assert.equal(await runCli(['commissions', 'plans', 'compute', 'plan:1', '--org', 'o', '--subject-id', 'u7', '--period', '2026-09'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/plans/plan%3A1/statements/compute`);
    assert.deepEqual(r.calls[0].body, { subjectId: 'u7', period: '2026-09' });
  });

  it('statements list filters + table shows the host total verbatim', async () => {
    const cap = capture();
    const r = recorder({ statements: [{ statementId: 's1', planId: 'plan:1', subjectId: 'u7', period: '2026-09', status: 'draft', total: 1234.5, currency: 'USD' }] });
    assert.equal(await runCli(['commissions', 'statements', 'list', '--org', 'o', '--period', '2026-09'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].url.searchParams.get('period'), '2026-09');
    assert.match(cap.stdout, /s1\s+plan:1\s+u7\s+2026-09\s+draft\s+1234\.5\s+USD/);
  });

  it('statements approve/pay POST; get --json passes through', async () => {
    let r = recorder({ review: { approvalId: 'a1', status: 'pending' } }, 202);
    assert.equal(await runCli(['commissions', 'statements', 'approve', 's1', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/statements/s1/approve`);
    assert.equal(r.calls[0].init.method, 'POST');
    r = recorder({ statementId: 's1', status: 'paid' });
    assert.equal(await runCli(['commissions', 'statements', 'pay', 's1', '--org', 'o'], opts(r.fetchImpl, capture())), 0);
    assert.equal(r.calls[0].url.pathname, `${B}/statements/s1/pay`);
    const cap = capture();
    r = recorder({ statementId: 's1' });
    assert.equal(await runCli(['--json', 'commissions', 'statements', 'get', 's1', '--org', 'o'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { statementId: 's1' });
  });

  it('403 → exit 4', async () => {
    const cap = capture();
    assert.equal(await runCli(['commissions', 'plans', 'create', '--org', 'o', '--name', 'x', '--currency', 'USD', '--effective-from', '2026-01-01'], opts(async () => jsonResponse({ message: 'Requires host:commissions:manage.' }, 403), cap)), 4);
    assert.match(cap.stderr, /HTTP 403: Requires host:commissions:manage\./);
  });
});

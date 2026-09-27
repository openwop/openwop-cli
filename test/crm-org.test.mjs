// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
// Covers the org-scoped CRM extension + booking/e-sign (+ public visitor routes).
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
const O = '/v1/host/openwop-app/crm/orgs/o1';

/** Run one command against a recording fetch; returns { code, cap, call }. */
async function run(argv, response = {}, status = 200) {
  const cap = capture();
  let call;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    call = { url: u, path: u.pathname, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    return typeof response === 'string'
      ? new Response(response, { status, headers: { 'content-type': 'text/csv' } })
      : jsonResponse(response, status);
  };
  const code = await runCli(argv, opts(fetchImpl, cap));
  return { code, cap, call };
}

describe('crm org-scoped: companies / deals / pipelines', () => {
  it('companies list renders a table and forwards ?q', async () => {
    const { code, cap, call } = await run(['crm', 'companies', 'list', '--org', 'o1', '--q', 'acme'], { companies: [{ companyId: 'c1', name: 'Acme', domain: 'acme.io', industry: 'saas' }] });
    assert.equal(code, 0, cap.stderr);
    assert.equal(call.method, 'GET');
    assert.equal(call.path, `${O}/companies`);
    assert.equal(call.url.searchParams.get('q'), 'acme');
    assert.match(cap.stdout, /c1\s+Acme\s+acme\.io\s+saas/);
  });

  it('companies create sends typed fields; merge posts sourceCompanyId', async () => {
    let r = await run(['crm', 'companies', 'create', '--org', 'o1', '--name', 'Acme', '--size', '50', '--tags', '["a"]'], { companyId: 'c1' }, 201);
    assert.equal(r.code, 0, r.cap.stderr);
    assert.equal(r.call.method, 'POST');
    assert.deepEqual(r.call.body, { name: 'Acme', size: 50, tags: ['a'] });
    r = await run(['crm', 'companies', 'merge', 'c1', '--org', 'o1', '--source-company-id', 'c2'], { companyId: 'c1' });
    assert.equal(r.call.path, `${O}/companies/c1/merge`);
    assert.deepEqual(r.call.body, { sourceCompanyId: 'c2' });
  });

  it('deals update PATCHes the deal (amount passed through exactly)', async () => {
    const { code, call } = await run(['crm', 'deals', 'update', 'd:1', '--org', 'o1', '--stage-id', 's2', '--amount', '12345'], { dealId: 'd:1' });
    assert.equal(code, 0);
    assert.equal(call.method, 'PATCH');
    assert.equal(call.path, `${O}/deals/d%3A1`);
    assert.deepEqual(call.body, { stageId: 's2', amount: 12345 });
  });

  it('deals list --json emits the host body verbatim', async () => {
    const body = { deals: [{ dealId: 'd1', title: 'Big' }] };
    const { code, cap, call } = await run(['--json', 'crm', 'deals', 'list', '--org', 'o1', '--pipeline-id', 'p1'], body);
    assert.equal(code, 0);
    assert.equal(call.url.searchParams.get('pipelineId'), 'p1');
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('pipelines delete refuses without --yes, DELETEs with it', async () => {
    let r = await run(['crm', 'pipelines', 'delete', 'p1', '--org', 'o1']);
    assert.equal(r.code, 2);
    assert.equal(r.call, undefined);
    r = await run(['crm', 'pipelines', 'delete', 'p1', '--org', 'o1', '--yes'], null, 200);
    assert.equal(r.code, 0);
    assert.equal(r.call.method, 'DELETE');
    assert.equal(r.call.path, `${O}/pipelines/p1`);
  });

  it('org-export writes the CSV verbatim', async () => {
    const { code, cap, call } = await run(['crm', 'org-export', '--org', 'o1', '--entity-type', 'deals'], 'dealId,title\nd1,Big\n');
    assert.equal(code, 0);
    assert.equal(call.url.searchParams.get('entityType'), 'deals');
    assert.equal(cap.stdout, 'dealId,title\nd1,Big\n');
  });

  it('org-import posts JSON rows', async () => {
    const { code, call } = await run(['crm', 'org-import', '--org', 'o1', '--entity-type', 'companies', '--rows', '[{"name":"A"}]', '--dedupe-by', 'domain'], { created: 1 });
    assert.equal(code, 0);
    assert.equal(call.path, `${O}/import`);
    assert.deepEqual(call.body, { entityType: 'companies', rows: [{ name: 'A' }], dedupeBy: 'domain' });
  });

  it('tasks create + activities create bodies', async () => {
    let r = await run(['crm', 'tasks', 'create', '--org', 'o1', '--title', 'Call', '--status', 'open', '--deal-id', 'd1'], { taskId: 't1' }, 201);
    assert.deepEqual(r.call.body, { title: 'Call', status: 'open', dealId: 'd1' });
    r = await run(['crm', 'activities', 'create', '--org', 'o1', '--kind', 'note', '--text', 'hi'], { activityId: 'a1' }, 201);
    assert.equal(r.call.path, `${O}/activities`);
    assert.deepEqual(r.call.body, { kind: 'note', body: 'hi' });
  });

  it('403 → legible message + exit 4', async () => {
    const { code, cap } = await run(['crm', 'deals', 'get', 'd1', '--org', 'o1'], { message: 'Not a member.' }, 403);
    assert.equal(code, 4);
    assert.match(cap.stderr, /HTTP 403: Not a member\./);
  });
});

describe('crm booking links + public-book', () => {
  it('booking-links create sends required title/timezone + numbers/json', async () => {
    const { code, call } = await run(['crm', 'booking-links', 'create', '--org', 'o1', '--title', 'Demo', '--timezone', 'UTC', '--durations', '[30]', '--min-notice-min', '60'], { bookingLinkId: 'b1' }, 201);
    assert.equal(code, 0);
    assert.equal(call.path, `${O}/booking-links`);
    assert.deepEqual(call.body, { title: 'Demo', timezone: 'UTC', durations: [30], minNoticeMin: 60 });
    assert.equal(call.headers.authorization, 'Bearer k');
  });

  it('public-book slots sends no authorization and forwards from/to/durationMin', async () => {
    const { code, call } = await run(['crm', 'public-book', 'slots', 'my-demo', '--duration-min', '30', '--from', '1000', '--to', '2000'], { slots: [1000], timezone: 'UTC' });
    assert.equal(code, 0);
    assert.equal(call.path, '/v1/host/openwop-app/public-book/my-demo/slots');
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.url.searchParams.get('durationMin'), '30');
    assert.equal(call.url.searchParams.get('from'), '1000');
  });

  it('public-book claim posts the invitee body without auth', async () => {
    const { code, call } = await run(['crm', 'public-book', 'claim', 'my-demo', '--slot-start-utc-ms', '1000', '--duration-min', '30', '--invitee-name', 'Ada', '--invitee-email', 'a@x.io'], { ok: true, bookingId: 'bk1' }, 201);
    assert.equal(code, 0);
    assert.equal(call.headers.authorization, undefined);
    assert.deepEqual(call.body, { slotStartUtcMs: 1000, durationMin: 30, inviteeName: 'Ada', inviteeEmail: 'a@x.io' });
  });

  it('public-book reschedule / cancel hit the manage-token routes', async () => {
    let r = await run(['crm', 'public-book', 'reschedule', 'tok/1', '--slot-start-utc-ms', '5000'], { status: 'confirmed' });
    assert.equal(r.call.path, '/v1/host/openwop-app/public-book/manage/tok%2F1/reschedule');
    assert.deepEqual(r.call.body, { slotStartUtcMs: 5000 });
    r = await run(['crm', 'public-book', 'cancel', 'tok', '--reason', 'conflict'], { status: 'cancelled' });
    assert.equal(r.call.path, '/v1/host/openwop-app/public-book/manage/tok/cancel');
    assert.deepEqual(r.call.body, { reason: 'conflict' });
  });
});

describe('crm sign-requests + public-sign', () => {
  it('sign-requests create sends target + signers JSON', async () => {
    const { code, call } = await run(['crm', 'sign-requests', 'create', '--org', 'o1', '--target', '{"kind":"quote","id":"q1"}', '--signers', '[{"email":"a@x.io"}]'], { signRequestId: 's1' }, 201);
    assert.equal(code, 0);
    assert.equal(call.path, `${O}/sign-requests`);
    assert.deepEqual(call.body, { target: { kind: 'quote', id: 'q1' }, signers: [{ email: 'a@x.io' }] });
  });

  it('sign-requests list renders the host rows', async () => {
    const { code, cap } = await run(['crm', 'sign-requests', 'list', '--org', 'o1'], { signRequests: [{ signRequestId: 's1', title: 'Quote Q1', status: 'pending', target: { kind: 'quote', id: 'q1' } }] });
    assert.equal(code, 0);
    assert.match(cap.stdout, /s1\s+Quote Q1\s+pending/);
  });

  it('public-sign sign posts acknowledged + typedName without auth', async () => {
    const { code, call } = await run(['crm', 'public-sign', 'sign', 'tok', '--acknowledged', 'true', '--typed-name', 'Ada Lovelace'], { status: 'signed' });
    assert.equal(code, 0);
    assert.equal(call.path, '/v1/host/openwop-app/public-sign/tok/sign');
    assert.equal(call.headers.authorization, undefined);
    assert.deepEqual(call.body, { acknowledged: true, typedName: 'Ada Lovelace' });
  });

  it('public-sign sign without --typed-name is a usage error', async () => {
    const { code, cap, call } = await run(['crm', 'public-sign', 'sign', 'tok', '--acknowledged', 'true']);
    assert.equal(code, 2);
    assert.equal(call, undefined);
    assert.match(cap.stderr, /--typed-name is required/);
  });
});

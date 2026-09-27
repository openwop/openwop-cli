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
const C = '/v1/host/openwop-app/crm';

/** Run one command against a recording fetch; returns { code, cap, calls }. */
async function run(argv, response = { ok: true }, status = 200) {
  const cap = capture();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    return typeof response === 'string'
      ? new Response(response, { status, headers: { 'content-type': 'text/csv' } })
      : jsonResponse(response, status);
  };
  const code = await runCli(argv, opts(fetchImpl, cap));
  return { code, cap, calls };
}

describe('crm (existing contact commands)', () => {
  it('crm list still renders contacts', async () => {
    const { code, cap, calls } = await run(['crm', 'list'], { contacts: [{ id: 'c1', name: 'Ada', stage: 'lead' }] });
    assert.equal(code, 0, cap.stderr);
    assert.equal(calls[0].url.pathname, `${C}/contacts`);
    assert.match(cap.stdout, /c1\s+Ada\s+lead/);
  });

  it('crm create forwards the extended contact fields', async () => {
    const { code, calls } = await run(['crm', 'create', '--name', 'Ada', '--phone', '+15551234', '--lead-source', 'web', '--custom-fields', '{"tier":"gold"}'], { contactId: 'c1' }, 201);
    assert.equal(code, 0);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { name: 'Ada', phone: '+15551234', leadSource: 'web', customFields: { tier: 'gold' } });
  });

  it('crm triage forwards --workflow-id', async () => {
    const { code, calls } = await run(['crm', 'triage', 'c1', '--workflow-id', 'wf.x'], { runId: 'r1' }, 202);
    assert.equal(code, 0);
    assert.equal(calls[0].url.pathname, `${C}/contacts/c1/triage`);
    assert.deepEqual(calls[0].body, { workflowId: 'wf.x' });
  });
});

describe('crm contact extensions', () => {
  it('contact score passes --org-id as a query param', async () => {
    const { code, calls } = await run(['crm', 'contact', 'score', 'c/1', '--org-id', 'o1'], { score: 42 });
    assert.equal(code, 0);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url.pathname, `${C}/contacts/c%2F1/score`);
    assert.equal(calls[0].url.searchParams.get('orgId'), 'o1');
  });

  it('contact convert sends orgId + optional names', async () => {
    const { code, calls } = await run(['crm', 'contact', 'convert', 'c1', '--org-id', 'o1', '--deal-title', 'Big deal']);
    assert.equal(code, 0);
    assert.equal(calls[0].url.pathname, `${C}/contacts/c1/convert`);
    assert.deepEqual(calls[0].body, { orgId: 'o1', dealTitle: 'Big deal' });
  });

  it('contact merge / merge-proposal require --source-contact-id', async () => {
    let r = await run(['crm', 'contact', 'merge', 'c1', '--source-contact-id', 'c2']);
    assert.equal(r.calls[0].url.pathname, `${C}/contacts/c1/merge`);
    assert.deepEqual(r.calls[0].body, { sourceContactId: 'c2' });
    r = await run(['crm', 'contact', 'merge-proposal', 'c1', '--source-contact-id', 'c2'], { approvalId: 'a1' }, 201);
    assert.equal(r.calls[0].url.pathname, `${C}/contacts/c1/merge-proposal`);
    r = await run(['crm', 'contact', 'merge', 'c1']);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it('identifiers add (body) and remove (query + --yes)', async () => {
    let r = await run(['crm', 'contact', 'identifiers', 'add', 'c1', '--type', 'phone', '--value', '+1'], {}, 201);
    assert.equal(r.calls[0].method, 'POST');
    assert.deepEqual(r.calls[0].body, { type: 'phone', value: '+1' });
    r = await run(['crm', 'contact', 'identifiers', 'remove', 'c1', '--type', 'phone', '--value', '+1', '--yes']);
    assert.equal(r.calls[0].method, 'DELETE');
    assert.equal(r.calls[0].url.pathname, `${C}/contacts/c1/identifiers`);
    assert.equal(r.calls[0].url.searchParams.get('type'), 'phone');
    assert.equal(r.calls[0].url.searchParams.get('value'), '+1');
  });

  it('duplicates / export send the entityType the host requires; export writes CSV verbatim', async () => {
    let r = await run(['crm', 'duplicates'], { groups: [] });
    assert.equal(r.calls[0].url.searchParams.get('entityType'), 'contact');
    r = await run(['crm', 'export'], 'contactId,name\nc1,Ada\n');
    assert.equal(r.calls[0].url.pathname, `${C}/export`);
    assert.equal(r.calls[0].url.searchParams.get('entityType'), 'contacts');
    assert.equal(r.cap.stdout, 'contactId,name\nc1,Ada\n');
  });

  it('merge-events list renders a table; unmerge POSTs', async () => {
    let r = await run(['crm', 'merge-events', 'list'], { events: [{ mergeEventId: 'm1', survivorId: 'c1', sourceId: 'c2', actor: 'u', mergedAt: 't' }] });
    assert.match(r.cap.stdout, /m1\s+c1\s+c2/);
    r = await run(['crm', 'merge-events', 'unmerge', 'm1']);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].url.pathname, `${C}/merge-events/m1/unmerge`);
  });

  it('match-candidates and runs get are GETs', async () => {
    let r = await run(['crm', 'match-candidates'], { candidates: [] });
    assert.equal(r.calls[0].url.pathname, `${C}/match-candidates`);
    r = await run(['crm', 'runs', 'get', 'run-1'], { runId: 'run-1' });
    assert.equal(r.calls[0].url.pathname, `${C}/runs/run-1`);
  });
});

describe('crm fields / segments / suppressions / gmail-sync', () => {
  it('fields create sends key/label/type/required/options', async () => {
    const { code, calls } = await run(['crm', 'fields', 'create', '--key', 'tier', '--label', 'Tier', '--type', 'select', '--required', 'true', '--options', '["a","b"]'], {}, 201);
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { key: 'tier', label: 'Tier', type: 'select', required: true, options: ['a', 'b'] });
  });

  it('fields delete requires --yes', async () => {
    const r = await run(['crm', 'fields', 'delete', 'd1']);
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it('segments create / update / overlap / members', async () => {
    let r = await run(['crm', 'segments', 'create', '--name', 'VIP', '--filters', '[{"field":"stage","op":"eq","value":"customer"}]', '--watch-entries', 'true'], {}, 201);
    assert.deepEqual(r.calls[0].body, { name: 'VIP', filters: [{ field: 'stage', op: 'eq', value: 'customer' }], watchEntries: true });
    r = await run(['crm', 'segments', 'update', 's1', '--name', 'VIP2']);
    assert.equal(r.calls[0].method, 'PATCH');
    assert.equal(r.calls[0].url.pathname, `${C}/segments/s1`);
    r = await run(['crm', 'segments', 'overlap', '--a', 's1', '--b', 's2'], { overlap: 1 });
    assert.equal(r.calls[0].url.pathname, `${C}/segments-overlap`);
    assert.equal(r.calls[0].url.searchParams.get('a'), 's1');
    r = await run(['crm', 'segments', 'members', 's1'], { members: [] });
    assert.match(r.cap.stdout, /No members/);
    for (const sub of ['estimate', 'insights']) {
      r = await run(['crm', 'segments', sub, 's1'], {});
      assert.equal(r.calls[0].url.pathname, `${C}/segments/s1/${sub}`);
    }
  });

  it('suppressions add / remove (email URL-encoded, --force) / summary', async () => {
    let r = await run(['crm', 'suppressions', 'add', '--email', 'a@b.co', '--reason', 'manual'], {}, 201);
    assert.deepEqual(r.calls[0].body, { email: 'a@b.co', reason: 'manual' });
    r = await run(['crm', 'suppressions', 'remove', 'a+x@b.co', '--force', 'true', '--yes'], { removed: true });
    assert.equal(r.calls[0].method, 'DELETE');
    assert.equal(r.calls[0].url.pathname, `${C}/suppressions/a%2Bx%40b.co`);
    assert.equal(r.calls[0].url.searchParams.get('force'), 'true');
    r = await run(['crm', 'suppressions', 'summary'], { summary: {} });
    assert.equal(r.calls[0].url.pathname, `${C}/suppressions/summary`);
  });

  it('gmail-sync update / sync-now / delete', async () => {
    let r = await run(['crm', 'gmail-sync', 'update', 'g1', '--status', 'paused']);
    assert.equal(r.calls[0].method, 'PATCH');
    assert.deepEqual(r.calls[0].body, { status: 'paused' });
    r = await run(['crm', 'gmail-sync', 'sync-now', 'g1'], { runId: 'r' }, 202);
    assert.equal(r.calls[0].url.pathname, `${C}/gmail-sync/g1/sync-now`);
    r = await run(['crm', 'gmail-sync', 'delete', 'g1', '--yes'], null, 200);
    assert.equal(r.calls[0].method, 'DELETE');
  });

  it('--json emits the host body verbatim', async () => {
    const body = { segments: [{ segmentId: 's1', name: 'VIP' }] };
    const { code, cap } = await run(['--json', 'crm', 'segments', 'list'], body);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('403 → legible message + exit 4', async () => {
    const { code, cap } = await run(['crm', 'suppressions', 'list'], { error: 'forbidden', message: 'Not permitted.' }, 403);
    assert.equal(code, 4);
    assert.match(cap.stderr, /HTTP 403: Not permitted\./);
  });

  it('an unknown crm command is a usage error', async () => {
    const { code, cap } = await run(['crm', 'bogus']);
    assert.equal(code, 2);
    assert.match(cap.stderr, /Unknown crm command/);
  });
});

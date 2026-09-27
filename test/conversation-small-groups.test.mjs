// computer-use, whatsapp, agent-author, workflow-author, workflow-proposals.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run, sseResponse } from './fixtures/conversation-harness.mjs';

describe('computer-use', () => {
  it('sessions + session (org-scoped), --org required, 403 → 4', async () => {
    const base = `${H}/computer-use/orgs/o1/sessions`;
    const host = mockHost({
      [`GET ${base}`]: { sessions: [{ sessionId: 'cu1', status: 'done', steps: 3, startUrl: 'https://a', task: 'find' }] },
      [`GET ${base}/cu1`]: { session: { sessionId: 'cu1', status: 'done', steps: [{ tier: 'observe', decidedBy: 'auto', action: { kind: 'navigate', url: 'https://a', description: 'open' } }] } },
    });
    assert.match((await run(['computer-use', 'sessions', '--org', 'o1'], host)).stdout, /cu1\s+done\s+3/);
    assert.match((await run(['computer-use', 'session', 'cu1', '--org', 'o1'], host)).stdout, /1\. \[observe\/auto\] navigate https:\/\/a — open/);
    assert.equal(JSON.parse((await run(['--json', 'computer-use', 'sessions', '--org', 'o1'], host)).stdout).sessions[0].sessionId, 'cu1');
    assert.equal((await run(['computer-use', 'sessions'], host)).code, 2);
    const denied = mockHost({ [`GET ${base}`]: () => jsonResponse({ error: 'forbidden', message: 'workspace:read required' }, 403) });
    assert.equal((await run(['computer-use', 'sessions', '--org', 'o1'], denied)).code, 4);
  });
});

describe('whatsapp', () => {
  it('health + attestation get/set/revoke', async () => {
    const base = `${H}/whatsapp/orgs/o1`;
    const host = mockHost({
      [`GET ${base}/health`]: { status: 'connected' },
      [`GET ${base}/attestation`]: { attested: true, attestedBy: 'u1', attestedAt: 't' },
      [`PUT ${base}/attestation`]: () => jsonResponse({ attested: true, attestedBy: 'u1', attestedAt: 't' }, 201),
      [`DELETE ${base}/attestation`]: () => jsonResponse(null, 204),
    });
    const h = await run(['whatsapp', 'health', '--org', 'o1', '--connection', 'wa1'], host);
    assert.deepEqual(host.calls.at(-1).query, { connectionId: 'wa1' });
    assert.match(h.stdout, /connected/);
    assert.match((await run(['whatsapp', 'attestation', 'get', '--org', 'o1'], host)).stdout, /attested: yes/);
    assert.equal((await run(['whatsapp', 'attestation', 'set', '--org', 'o1'], host)).code, 2);
    await run(['whatsapp', 'attestation', 'set', '--org', 'o1', '--confirm-no-training'], host);
    assert.deepEqual(host.calls.at(-1).body, { confirmNoTraining: true });
    assert.equal((await run(['whatsapp', 'attestation', 'revoke', '--org', 'o1', '--yes'], host)).code, 0);
    const denied = mockHost({ [`PUT ${base}/attestation`]: () => jsonResponse({ error: 'forbidden', message: 'host:whatsapp:manage required' }, 403) });
    const r = await run(['whatsapp', 'attestation', 'set', '--org', 'o1', '--confirm-no-training'], denied);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /host:whatsapp:manage required/);
  });
});

describe('agent-author', () => {
  it('draft read (present + absent) and clear', async () => {
    const d = `${H}/agent-author/draft`;
    const host = mockHost({ [`GET ${d}`]: { draft: { persona: 'Triage' }, stashedAt: 't' }, [`DELETE ${d}`]: () => jsonResponse(null, 204) });
    assert.match((await run(['agent-author', 'draft'], host)).stdout, /"persona": "Triage"/);
    assert.equal((await run(['agent-author', 'clear'], host)).code, 0);
    assert.match((await run(['agent-author'], mockHost({ [`GET ${d}`]: { draft: null } }))).stdout, /No stashed agent draft/);
    assert.equal((await run(['agent-author', 'draft'], mockHost({ [`GET ${d}`]: () => jsonResponse({ error: 'forbidden', message: 'no' }, 403) }))).code, 4);
  });
});

describe('workflow-author', () => {
  it('catalog renders; draft posts the intent with an idempotency key; --follow streams the run', async () => {
    const base = `${H}/workflow-author`;
    const host = mockHost({
      [`GET ${base}/catalog`]: { nodes: [{ typeId: 'core.http', version: '1.0.0', category: 'io', label: 'HTTP' }], excluded: [{ typeId: 'x', reason: 'r' }] },
      [`POST ${base}/draft`]: () => jsonResponse({ runId: 'r1', workflowId: 'meta', status: 'pending' }, 201),
      'GET /v1/runs/r1/events': () => sseResponse([{ event: 'run.completed', data: { type: 'run.completed', sequence: 1, payload: {} } }]),
    });
    const c = await run(['workflow-author', 'catalog'], host);
    assert.match(c.stdout, /core\.http\s+1\.0\.0\s+io/);
    assert.match(c.stdout, /1 node type\(s\) excluded/);
    const d = await run(['workflow-author', 'draft', '--intent', 'email me', '--max-attempts', '2'], host);
    assert.equal(d.code, 0, d.stderr);
    assert.deepEqual(host.calls.at(-1).body, { intent: 'email me', maxAttempts: 2 });
    assert.match(host.calls.at(-1).headers['idempotency-key'], /^[A-Za-z0-9._~-]{22,128}$/);
    assert.match(d.stdout, /Authoring run r1 started/);
    const f = await run(['--json', 'workflow-author', 'draft', '--intent', 'x', '--follow', '--timeout-ms', '2000'], host);
    assert.equal(f.code, 0, f.stderr);
    assert.match(f.stdout, /run\.completed/);
    assert.equal((await run(['workflow-author', 'draft'], host)).code, 2);
  });
});

describe('workflow-proposals', () => {
  it('policies list / enable / disable (operator), 403 → 4', async () => {
    const base = `${H}/workflow-proposals/admin/policies`;
    const host = mockHost({
      [`GET ${base}`]: { items: [{ agentProfileId: 'ap1', createdBy: 'root', createdAt: 't' }] },
      [`PUT ${base}/t1/ap1`]: { policy: { agentProfileId: 'ap1' } },
      [`DELETE ${base}/t1/ap1`]: { removed: true },
    });
    const l = await run(['workflow-proposals', 'policies', '--tenant', 't1'], host);
    assert.deepEqual(host.calls.at(-1).query, { tenantId: 't1' });
    assert.match(l.stdout, /ap1\s+root/);
    assert.equal((await run(['workflow-proposals', 'enable', '--tenant', 't1', '--agent-profile', 'ap1'], host)).code, 0);
    assert.equal(host.calls.at(-1).method, 'PUT');
    assert.match((await run(['workflow-proposals', 'disable', '--tenant', 't1', '--agent-profile', 'ap1'], host)).stdout, /disabled/);
    assert.equal((await run(['workflow-proposals', 'policies'], host)).code, 2);
    const denied = mockHost({ [`GET ${base}`]: () => jsonResponse({ error: 'forbidden', message: 'Superadmin required.' }, 403) });
    assert.equal((await run(['workflow-proposals', 'policies', '--tenant', 't1'], denied)).code, 4);
  });
});

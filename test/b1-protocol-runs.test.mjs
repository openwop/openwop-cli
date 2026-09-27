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

function json(body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fake v1 host: `/.well-known/openwop` advertises protocol 1.x (so paths are
 * sent exactly as written); every other request is recorded and answered by
 * `handler(method, path, body, url)`.
 */
function fakeHost(handler, wellKnown) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/openwop') return json(wellKnown);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers ?? {} });
    return handler(method, u.pathname, body, u);
  };
  return { fetchImpl, calls };
}

async function run(argv, handler, env = {}, wellKnown = V1) {
  const cap = capture();
  const { fetchImpl, calls } = fakeHost(handler, wellKnown);
  const code = await runCli(argv, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', ...env } });
  return { code, stdout: cap.stdout, stderr: cap.stderr, calls };
}

const forbidden = () => json({ error: 'forbidden', message: 'Missing required scope' }, 403);

// The approvals group gates on the advertised path, so the v1 discovery doc names it.
const V1 = { protocolVersions: ['1.1'], paths: { '/v1/host/openwop-app/approvals': { get: {} } } };
const V2 = { protocolVersions: ['2.0', '1.1'], extensions: { 'openwop-app': { root: '/host/openwop-app/', twin: '/v1/host/openwop-app/' } } };
const notFound = () => json({ error: 'not_found', message: 'Cannot GET' }, 404);

describe('agents / roster / org-chart — normative first, host fallback', () => {
  it('agents list reads GET /v1/agents', async () => {
    const r = await run(['agents', 'list'], () => json({ agents: [{ agentId: 'a1', persona: 'P', modelClass: 'fast', packName: 'pk' }], total: 1 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls.map((c) => c.path), ['/v1/agents']);
    assert.match(r.stdout, /a1\s+P\s+fast\s+pk/);
  });

  it('agents list falls back to the host path when the normative read 404s, and --verbose says so', async () => {
    const r = await run(['--verbose', 'agents', 'list'], (m, p) => p === '/v1/agents' ? notFound() : json({ agents: [], total: 0 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls.map((c) => c.path), ['/v1/agents', '/v1/host/openwop-app/agents']);
    assert.match(r.stderr, /host-extension path \/v1\/host\/openwop-app\/agents/);
  });

  it('agents info --host skips the normative read', async () => {
    const r = await run(['--json', 'agents', 'info', 'a1', '--host'], () => json({ agentId: 'a1' }));
    assert.deepEqual(r.calls.map((c) => c.path), ['/v1/host/openwop-app/agents/a1']);
    assert.equal(JSON.parse(r.stdout).agentId, 'a1');
  });

  it('a 403 on the normative read is NOT a fallback — it exits 4', async () => {
    const r = await run(['agents', 'list'], forbidden);
    assert.equal(r.code, 4);
    assert.equal(r.calls.length, 1);
  });

  it('under v2 the normative read rides /agents/roster with OpenWOP-Version', async () => {
    const r = await run(['roster', 'list'], () => json({ roster: [], total: 0 }), {}, V2);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, '/agents/roster');
    assert.equal(r.calls[0].headers['openwop-version'], '2.0');
  });

  it('roster list --host reads the host-extension roster', async () => {
    const r = await run(['roster', 'list', '--host'], () => json({ roster: [] }));
    assert.deepEqual(r.calls.map((c) => c.path), ['/v1/host/openwop-app/roster']);
  });

  it('org-chart dept reads the normative department view with ?recursive', async () => {
    const r = await run(['org-chart', 'dept', 'eng', '--no-recursive'], () => json({ departmentId: 'eng' }));
    assert.equal(r.calls[0].path, '/v1/agents/org-chart/eng');
    assert.equal(r.calls[0].search, '?recursive=false');
  });

  it('org-chart get falls back to the host chart on 404', async () => {
    const r = await run(['org-chart', 'get'], (m, p) => p === '/v1/agents/org-chart' ? notFound() : json({ departments: [], members: [] }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls.map((c) => c.path), ['/v1/agents/org-chart', '/v1/host/openwop-app/org-chart']);
  });
});

describe('agents eval-run / verify-run', () => {
  it('eval-run POSTs tasks/results and exits 0 only when all pass', async () => {
    const body = JSON.stringify({ tasks: [{ taskId: 't1', criterion: { kind: 'golden', expected: 'x' } }], results: ['x'] });
    let r = await run(['agents', 'eval-run', '--body', body], () => json({ total: 1, passed: 1, passRate: 1, meanScore: 1, tasks: [{ taskId: 't1', score: 1, passed: true }] }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/agents/eval-run');
    assert.deepEqual(r.calls[0].body.results, ['x']);
    assert.match(r.stdout, /t1\s+1\s+true/);
    r = await run(['--json', 'agents', 'eval-run', '--body', body], () => json({ total: 1, passed: 0, tasks: [] }));
    assert.equal(r.code, 1);
  });

  it('eval-run fails closed on a 404 (suite disabled)', async () => {
    const r = await run(['agents', 'eval-run', '--body', '{"tasks":[],"results":[]}'], () => json({ error: 'not_found', message: 'agent eval suite disabled' }, 404));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /eval suite disabled/);
  });

  it('verify-run sends simulateVerdict and exits 1 when withheld', async () => {
    const r = await run(['agents', 'verify-run', '--verdict', 'fail'], () => json({ status: 'escalated', committed: false, outcome: 'withheld', verdict: 'fail', events: [] }));
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls[0].body, { simulateVerdict: 'fail' });
    assert.match(r.stdout, /outcome: withheld/);
  });
});

describe('agent-profile capability-on/off', () => {
  it('PUT / DELETE …/capabilities/{id}', async () => {
    let r = await run(['agent-profile', 'capability-on', 'a1', 'deep-investigation'], () => json({ capabilities: ['deep-investigation'] }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['PUT', '/v1/host/openwop-app/agents/a1/capabilities/deep-investigation']);
    assert.match(r.stdout, /Active capabilities: deep-investigation/);
    r = await run(['agent-profile', 'capability-off', 'a1', 'deep-investigation'], () => json({ capabilities: [] }));
    assert.equal(r.calls[0].method, 'DELETE');
  });
});

describe('interrupts inspect / respond', () => {
  it('inspect GETs /v1/interrupts/{token}', async () => {
    const r = await run(['interrupts', 'inspect', 'tok1'], () => json({ kind: 'approval', key: 'i1', resolved: false, data: { prompt: 'Ship it?' } }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['GET', '/v1/interrupts/tok1']);
    assert.match(r.stdout, /prompt: Ship it\?/);
  });

  it('respond POSTs { resumeValue } to /v1/runs/{runId}/interrupts/{nodeId} with an Idempotency-Key', async () => {
    const r = await run(['interrupts', 'respond', 'r1', 'gate', '--data-json', '{"action":"approve"}'], () => json({ runId: 'r1', nodeId: 'gate', status: 'running' }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['POST', '/v1/runs/r1/interrupts/gate', { resumeValue: { action: 'approve' } }]);
    assert.ok(r.calls[0].headers['idempotency-key']);
  });

  it('respond renders an expired interrupt (410) as exit 1', async () => {
    const r = await run(['interrupts', 'respond', 'r1', 'gate'], () => json({ error: 'interrupt_expired', message: 'expired' }, 410));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /expired/);
  });

  it('respond under v2 projects a tenant-bound runId', async () => {
    const r = await run(['interrupts', 'respond', 'acme/r1', 'gate'], () => json({}), {}, V2);
    assert.equal(r.calls[0].path, '/runs/acme~2Fr1/interrupts/gate');
  });
});

describe('runs effects / revision / pin / redrive', () => {
  it('effects tabulates the ledger', async () => {
    const r = await run(['runs', 'effects', 'r1'], () => json({ runId: 'r1', effects: [{ effectId: 'e1', nodeId: 'n1', attempt: 1, state: 'completed', at: 't' }] }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, '/v1/runs/r1/effects');
    assert.match(r.stdout, /e1\s+n1\s+1\s+completed\s+t/);
  });

  it('revision reads the host-extension provenance (v2: projected run segment on the host root)', async () => {
    let r = await run(['runs', 'revision', 'r1'], () => json({ runId: 'r1', workflowId: 'w1', definitionRevision: 'h1', headMoved: true }));
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/runs/r1/revision');
    assert.match(r.stdout, /headMoved: yes/);
    r = await run(['runs', 'revision', 'acme/r1'], () => json({}), {}, V2);
    assert.equal(r.calls[0].path, '/host/openwop-app/runs/acme~2Fr1/revision');
  });

  it('pin / unpin POST { pinned }', async () => {
    let r = await run(['runs', 'unpin', 'r1'], () => json({ runId: 'r1', pinned: false }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['POST', '/v1/host/openwop-app/runs/r1/pin', { pinned: false }]);
    assert.match(r.stdout, /Unpinned run r1/);
    r = await run(['runs', 'pin', 'r1'], () => json({ runId: 'r1', pinned: true }));
    assert.deepEqual(r.calls[0].body, { pinned: true });
  });

  it('redrive POSTs { runIds } and exits 1 when any id failed', async () => {
    const r = await run(['runs', 'redrive', 'r1', 'r2'], () => json({ results: [{ runId: 'r1', redriveRunId: 'r9' }, { runId: 'r2', error: 'run_not_found' }] }));
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls[0].body, { runIds: ['r1', 'r2'] });
    assert.match(r.stdout, /r2\s+run_not_found/);
  });
});

describe('approvals sla-policy / email-pref / delegations / decision fields', () => {
  it('sla-policy set merges the current policy before PUT', async () => {
    const r = await run(['approvals', 'sla-policy', 'set', '--enabled', '--remind-after-ms', '60000'], (m) =>
      m === 'GET' ? json({ enabled: false, escalateAfterMs: 120000 }) : json({ enabled: true }));
    assert.equal(r.code, 0, r.stderr);
    const put = r.calls.find((c) => c.method === 'PUT');
    assert.equal(put.path, '/v1/host/openwop-app/approvals/sla-policy');
    assert.deepEqual(put.body, { enabled: true, remindAfterMs: 60000, escalateAfterMs: 120000 });
  });

  it('sla-policy set without an admin role exits 4', async () => {
    const r = await run(['approvals', 'sla-policy', 'set', '--disabled'], (m) => m === 'GET' ? json({ enabled: true }) : forbidden());
    assert.equal(r.code, 4);
  });

  it('email-pref reads and sets', async () => {
    let r = await run(['approvals', 'email-pref'], () => json({ enabled: true, email: 'me@example.com' }));
    assert.match(r.stdout, /email: me@example\.com/);
    r = await run(['approvals', 'email-pref', 'set', '--email', 'me@example.com', '--disabled'], () => json({ email: 'me@example.com', enabled: false }));
    assert.deepEqual([r.calls[0].method, r.calls[0].body], ['PUT', { email: 'me@example.com', enabled: false }]);
  });

  it('delegations list / create / revoke', async () => {
    let r = await run(['approvals', 'delegations', 'list', '--all'], () => json({ delegations: [{ delegationId: 'dlg:1', fromSubject: 'u1', toSubject: 'u2', startsAt: 's', endsAt: 'e' }] }));
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/approval-delegations');
    assert.equal(r.calls[0].search, '?all=1');
    assert.match(r.stdout, /dlg:1\s+u1\s+u2/);
    r = await run(['approvals', 'delegations', 'create', '--to', 'u2', '--starts-at', '2026-10-01T00:00:00Z', '--ends-at', '2026-10-08T00:00:00Z', '--reason', 'PTO'],
      () => json({ delegation: { delegationId: 'dlg:2', toSubject: 'u2' } }, 201));
    assert.deepEqual(r.calls[0].body, { toSubject: 'u2', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-08T00:00:00Z', reason: 'PTO' });
    r = await run(['approvals', 'delegations', 'revoke', 'dlg:2'], () => json({ delegation: {} }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['POST', '/v1/host/openwop-app/approval-delegations/dlg%3A2/revoke']);
  });

  it('claim carries --acted-for and --expected-hash', async () => {
    const r = await run(['approvals', 'claim', 'ap1', '--acted-for', 'u1', '--expected-hash', 'h1'], () => json({ approvalId: 'ap1', status: 'approved' }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0].body, { actedFor: 'u1', expectedDefinitionHash: 'h1' });
  });
});

describe('reviews', () => {
  it('list reads { items } and passes conversation/board filters', async () => {
    const r = await run(['reviews', 'list', '--conversation', 'c1'], () => json({ items: [{ reviewId: 'rv1', status: 'pending', source: 'approval', title: 'Ship', actions: [{ action: 'approve' }, { action: 'reject' }] }] }));
    assert.equal(r.calls[0].search, '?conversationId=c1');
    assert.match(r.stdout, /rv1\s+pending\s+approval\s+Ship\s+approve,reject/);
  });

  it('action sends { value } from --value-json and exits by status', async () => {
    const r = await run(['reviews', 'action', 'rv1', 'resolve', '--value-json', '{"ok":true}'], () => json({ reviewId: 'rv1', status: 'resolved' }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0].body, { value: { ok: true } });
  });
});

describe('prompts library + render', () => {
  const PL = '/v1/host/openwop-app/prompts/orgs/o1/entries';
  it('list / get / update / delete / render', async () => {
    let r = await run(['prompts', 'library', 'list', '--org', 'o1'], () => json({ entries: [{ entryId: 'pe1', name: 'Weekly', promptRef: 'summary', visibility: 'org', tags: ['x'] }] }));
    assert.equal(r.calls[0].path, PL);
    assert.match(r.stdout, /pe1\s+Weekly\s+summary\s+org\s+x/);
    r = await run(['--json', 'prompts', 'library', 'get', 'pe1', '--org', 'o1'], () => json({ entry: { entryId: 'pe1' } }));
    assert.equal(r.calls[0].path, `${PL}/pe1`);
    assert.deepEqual(JSON.parse(r.stdout), { entry: { entryId: 'pe1' } });
    r = await run(['prompts', 'library', 'update', 'pe1', '--org', 'o1', '--name', 'W2', '--tag', 'a', '--tag', 'b'], () => json({ entry: {} }));
    assert.deepEqual([r.calls[0].method, r.calls[0].body], ['PATCH', { name: 'W2', tags: ['a', 'b'] }]);
    r = await run(['prompts', 'library', 'delete', 'pe1', '--org', 'o1', '--yes'], () => new Response(null, { status: 204 }));
    assert.equal(r.calls[0].method, 'DELETE');
    r = await run(['prompts', 'library', 'render', 'pe1', '--org', 'o1', '--variables-json', '{"team":"growth"}'], () => json({ composed: 'Hello growth', templateId: 'summary' }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['POST', `${PL}/pe1/render`, { variables: { team: 'growth' } }]);
    assert.match(r.stdout, /Hello growth/);
  });

  it('library needs --org', async () => {
    const r = await run(['prompts', 'library', 'list'], () => json({}));
    assert.equal(r.code, 2);
  });

  it('render carries --content-trust to /v1/prompts:render', async () => {
    const r = await run(['prompts', 'render', 'summary@1', '--content-trust', 'untrusted'], () => json({ text: 'x' }));
    assert.equal(r.calls[0].path, '/v1/prompts:render');
    assert.deepEqual(r.calls[0].body, { ref: 'summary@1', variables: {}, contentTrust: 'untrusted' });
  });
});

describe('webhooks rotate-secret / dead-letters', () => {
  it('rotate-secret reads the secret from an env var and never prints it', async () => {
    const secret = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
    const r = await run(['webhooks', 'rotate-secret', 'sub1', '--secret-env', 'NEW_SECRET', '--tenant-id', 't1'],
      () => json({ rotatedAt: '2026-09-27T00:00:00Z', previousSecretExpiresAt: '2026-09-28T00:00:00Z' }), { NEW_SECRET: secret });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].search, r.calls[0].body], ['POST', '/v1/webhooks/sub1/rotate-secret', '?tenantId=t1', { secret }]);
    assert.doesNotMatch(r.stdout + r.stderr, /whsec_/);
  });

  it('rotate-secret --generate reveals the new secret once on stderr, not stdout', async () => {
    const r = await run(['webhooks', 'rotate-secret', 'sub1', '--generate'], () => json({ rotatedAt: 'a', previousSecretExpiresAt: 'b' }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.calls[0].body.secret, /^whsec_/);
    assert.doesNotMatch(r.stdout, /whsec_/);
    assert.match(r.stderr, /shown ONCE/);
  });

  it('rotate-secret refuses a secret on no source', async () => {
    const r = await run(['webhooks', 'rotate-secret', 'sub1'], () => json({}));
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it('dead-letters pages and fails closed when the host has no dead-letter read', async () => {
    let r = await run(['webhooks', 'dead-letters', 'sub1', '--limit', '5'], () => json({ deliveries: [{ deliveryId: 'd1', runId: 'r1', eventType: 'run.completed', attempts: 8, reason: 'retries_exhausted', deadLetteredAt: 't', expiresAt: 'u' }], nextCursor: 'c2' }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, '/v1/webhooks/sub1/dead-letters');
    assert.equal(r.calls[0].search, '?limit=5');
    assert.match(r.stdout, /d1\s+r1\s+run\.completed\s+8\s+retries_exhausted/);
    assert.match(r.stdout, /--cursor c2/);
    r = await run(['webhooks', 'dead-letters', 'sub1'], notFound);
    assert.equal(r.code, 1);
  });
});

describe('catalog packs search / get / export (host)', () => {
  it('search / get / export hit the host pack routes', async () => {
    let r = await run(['catalog', 'packs', 'search', 'ai'], () => json({ results: [{ typeId: 'core.ai.call', version: 'in-process' }], total: 1, q: 'ai' }));
    assert.deepEqual([r.calls[0].path, r.calls[0].search], ['/v1/packs/-/search', '?q=ai']);
    assert.match(r.stdout, /core\.ai\.call\s+in-process/);
    r = await run(['catalog', 'packs', 'get', 'core.openwop.ai'], () => json({ name: 'core.openwop.ai', nodes: ['core.openwop.ai.call'] }));
    assert.equal(r.calls[0].path, '/v1/packs/core.openwop.ai');
    assert.match(r.stdout, /core\.openwop\.ai\.call/);
    r = await run(['--json', 'catalog', 'packs', 'export'], () => json({ manifests: [], total: 0 }));
    assert.equal(r.calls[0].path, '/v1/packs/export');
    assert.deepEqual(JSON.parse(r.stdout), { manifests: [], total: 0 });
  });
});

describe('workflows lifecycle / revisions / pins / evals', () => {
  const W = '/v1/host/openwop-app/workflows/w1';
  it('lifecycle verbs, rollback, revisions', async () => {
    let r = await run(['workflows', 'promote', 'w1'], () => json({ workflowId: 'w1', publishedRevision: 'h2' }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['POST', `${W}/promote`]);
    assert.match(r.stdout, /published revision h2/);
    r = await run(['workflows', 'rollback', 'w1', '--revision', 'h1'], () => json({ workflowId: 'w1', restoredRevision: 'h1' }));
    assert.deepEqual([r.calls[0].path, r.calls[0].body], [`${W}/rollback`, { revisionHash: 'h1' }]);
    r = await run(['workflows', 'revisions', 'w1'], () => json({ items: [{ revisionHash: 'h1', createdAt: 't', nodeCount: 3, isHead: true, published: true }] }));
    assert.match(r.stdout, /h1\s+t\s+3\s+yes\s+yes/);
    r = await run(['workflows', 'rollback', 'w1'], () => json({}));
    assert.equal(r.code, 2);
  });

  it('stats / estimate read JSON', async () => {
    let r = await run(['workflows', 'stats'], () => json({ windowDays: 30 }));
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/workflows/stats');
    r = await run(['workflows', 'estimate', 'w1'], () => json({ historical: {} }));
    assert.equal(r.calls[0].path, `${W}/estimate`);
  });

  it('pins + debug-run', async () => {
    let r = await run(['workflows', 'pin-set', 'w1', 'n1', '--output-json', '{"x":1}'], () => json({ nodeId: 'n1' }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['PUT', `${W}/pins/n1`, { output: { x: 1 } }]);
    r = await run(['workflows', 'pins-from-run', 'w1', 'r1'], () => json({ pinned: ['n1'], unmatched: ['old'] }));
    assert.deepEqual(r.calls[0].body, { runId: 'r1' });
    assert.match(r.stdout, /Not in the current head: old/);
    r = await run(['workflows', 'pins-clear', 'w1'], () => json({}));
    assert.equal(r.code, 2);
    r = await run(['workflows', 'debug-run', 'w1', '--from-node', 'n2', '--mode', 'only', '--input', 'q=5'], () => json({ runId: 'r2', executing: ['n2'], pinnedNodes: ['n1'], skipped: [] }, 201));
    assert.deepEqual(r.calls[0].body, { fromNodeId: 'n2', mode: 'only', inputs: { q: 5 } });
    assert.match(r.stdout, /Started debug run r2/);
  });

  it('eval-set put / run / results', async () => {
    const set = { name: 'Smoke', cases: [{ caseId: 'c1', assertions: [{ kind: 'status', equals: 'completed' }] }] };
    let r = await run(['workflows', 'eval-set', 'put', 'w1', 'smoke', '--body', JSON.stringify(set)], () => json({ evalSetId: 'smoke', cases: 1, requiredForPromote: false }, 201));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['PUT', `${W}/eval-sets/smoke`, set]);
    assert.match(r.stdout, /Created eval set smoke/);
    r = await run(['workflows', 'eval-set', 'run', 'w1', 'smoke'], () => json({ resultId: 'res1', cases: 1 }, 202));
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['POST', `${W}/eval-sets/smoke/run`]);
    r = await run(['workflows', 'eval-results', 'w1', '--eval-set', 'smoke'], () => json({ items: [{ resultId: 'res1', evalSetId: 'smoke', status: 'complete', cases: [{ status: 'passed' }], revisionHash: 'abcdef0123456789', startedAt: 't' }] }));
    assert.equal(r.calls[0].search, '?evalSetId=smoke');
    assert.match(r.stdout, /res1\s+smoke\s+complete\s+1\/1\s+abcdef012345/);
  });

  it('a 403 on a workflow op exits 4', async () => {
    const r = await run(['workflows', 'archive', 'w1'], forbidden);
    assert.equal(r.code, 4);
  });
});

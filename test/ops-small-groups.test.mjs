// Run via `npm test` (builds dist/ first). dashboard, bi, insights-suite,
// intent-ledger, work-graph, work-selection, tasks, model-router, dev.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const H = '/v1/host/openwop-app';

describe('dashboard', () => {
  it('layout renders tiles; a null layout reads as the default', async () => {
    let host = mockHost(() => json({ layout: { tiles: [{ id: 'runs', order: 0, size: 'full', enabled: true }] } }));
    let cap = capture();
    assert.equal(await runCli(['dashboard', 'layout'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${H}/dashboard/layout`);
    assert.match(cap.stdout, /runs\s+0\s+full\s+true/);
    host = mockHost(() => json({ layout: null }));
    cap = capture();
    await runCli(['dashboard', 'layout'], opts(host, cap));
    assert.match(cap.stdout, /No saved layout/);
  });

  it('layout set / note set / briefing set PUT their bodies', async () => {
    const host = mockHost(() => json({}));
    await runCli(['dashboard', 'layout', 'set', '--tiles', '[{"id":"a","order":1,"size":"half","enabled":false}]'], opts(host, capture()));
    assert.deepEqual(host.last(), { ...host.last(), method: 'PUT', body: { tiles: [{ id: 'a', order: 1, size: 'half', enabled: false }] } });
    await runCli(['dashboard', 'note', 'set', '--text', 'hello'], opts(host, capture()));
    assert.deepEqual(host.last().body, { text: 'hello' });
    await runCli(['dashboard', 'briefing', 'set', '--conversation-id', 'c1'], opts(host, capture()));
    assert.deepEqual(host.last().body, { conversationId: 'c1' });
  });

  it('401 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'unauthenticated' }, 401));
    const cap = capture();
    assert.equal(await runCli(['dashboard', 'note'], opts(host, cap)), 4);
    assert.match(cap.stderr, /Not signed in/);
  });
});

describe('bi', () => {
  it('metrics update is read-modify-write and strips metadata', async () => {
    const metric = { metricId: 'm1', tenantId: 't', title: 'Deals', entityType: 'crm.deal', aggregate: 'count', createdBy: 'u', createdAt: 'x', updatedAt: 'y' };
    const host = mockHost((c) => json(c.method === 'GET' ? { metric } : { metric: {} }));
    const cap = capture();
    assert.equal(await runCli(['bi', 'metrics', 'update', 'o1', 'm1', '--group-by', 'stageId'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.calls[0].path, `${H}/bi/orgs/o1/metrics/m1`);
    assert.equal(host.last().method, 'PATCH');
    assert.deepEqual(host.last().body, { title: 'Deals', entityType: 'crm.deal', aggregate: 'count', groupBy: 'stageId' });
  });

  it('metrics create requires the definition fields; run posts the window', async () => {
    const host = mockHost(() => json({ result: { points: [] } }));
    let cap = capture();
    assert.equal(await runCli(['bi', 'metrics', 'create', 'o1', '--metric-id', 'm'], opts(host, cap)), 2);
    cap = capture();
    await runCli(['bi', 'metrics', 'run', 'o1', 'm1', '--bucket', 'week', '--since', '2026-07-01'], opts(host, cap));
    assert.equal(host.last().path, `${H}/bi/orgs/o1/metrics/m1/run`);
    assert.deepEqual(host.last().body, { since: '2026-07-01', bucket: 'week' });
  });

  it('delete of a system metric → 403 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden', message: 'System metrics are read-only.' }, 403));
    const cap = capture();
    assert.equal(await runCli(['bi', 'metrics', 'delete', 'o1', 'sys.revenue', '--yes'], opts(host, cap)), 4);
    assert.match(cap.stderr, /read-only/);
  });
});

describe('insights-suite', () => {
  it('config set keeps saved fields and nests planSource', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { config: { tenantId: 't', principalUserId: 'u1', businessUnits: ['s'], updatedAt: 'x' } } : { config: {} }));
    await runCli(['insights-suite', 'config', 'set', '--schedule-cron', '0 7 * * 1', '--plan-project-id', 'p1', '--anniversary-trigger'], opts(host, capture()));
    assert.deepEqual(host.last().body, { principalUserId: 'u1', businessUnits: ['s'], scheduleCron: '0 7 * * 1', planSource: { projectId: 'p1' }, anniversaryTriggerEnabled: true });
  });
});

describe('intent-ledger', () => {
  it('draft sends arrays; approve/reject/reckoning hit their verbs', async () => {
    const host = mockHost(() => json({ ledger: {} }));
    await runCli(['intent-ledger', 'draft', 'c:1', '--goal', 'Book', '--allowed', 'a,b', '--success-criterion', 'x', '--success-criterion', 'y'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/intent-ledger/conversations/c%3A1/draft`);
    assert.deepEqual(host.last().body, { goal: 'Book', allowed: ['a', 'b'], successCriteria: ['x', 'y'] });
    for (const verb of ['approve', 'reject']) {
      await runCli(['intent-ledger', verb, 'c1'], opts(host, capture()));
      assert.equal(host.last().path, `${H}/intent-ledger/conversations/c1/${verb}`);
      assert.equal(host.last().method, 'POST');
    }
    await runCli(['intent-ledger', 'reckoning', 'c1'], opts(host, capture()));
    assert.equal(host.last().method, 'GET');
  });
});

describe('work-graph / work-selection / tasks / model-router / dev', () => {
  it('work-graph refresh renders suggestions; accept/dismiss POST', async () => {
    const host = mockHost(() => json({ suggestions: [{ suggestionId: 's1', count: 4, status: 'open', toolSequence: ['a', 'b'], lastSeenAt: 't' }] }));
    const cap = capture();
    await runCli(['work-graph', 'refresh', 'o1'], opts(host, cap));
    assert.match(cap.stdout, /s1\s+4\s+open\s+\["a","b"\]/);
    await runCli(['work-graph', 'dismiss', 'o1', 's1'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/work-graph/orgs/o1/suggestions/s1/dismiss`);
  });

  it('work-selection ranking table', async () => {
    const host = mockHost(() => json({ ranked: [{ rank: 1, cardId: 'c1', title: 'T', score: 9 }] }));
    const cap = capture();
    await runCli(['work-selection', 'ranking', 'b1'], opts(host, cap));
    assert.equal(host.last().path, `${H}/work-selection/boards/b1/ranking`);
    assert.match(cap.stdout, /1\s+c1\s+T\s+9/);
  });

  it('tasks deck flattens buckets; --json is the raw deck', async () => {
    const body = { deck: { buckets: { running: [{ runId: 'r1', status: 'running', title: 'Job', children: [{}] }], failed: [] } } };
    const host = mockHost(() => json(body));
    let cap = capture();
    await runCli(['tasks', 'deck', '--conversation-run-id', 'cr1'], opts(host, cap));
    assert.deepEqual(host.last().query, { conversationRunId: 'cr1' });
    assert.match(cap.stdout, /running\s+r1\s+running\s+Job\s+1/);
    cap = capture();
    await runCli(['tasks', 'deck', '--json'], opts(host, cap));
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('model-router enable/disable send enabled true/false; 404 → exit 2', async () => {
    const host = mockHost(() => json({ config: {} }));
    await runCli(['model-router', 'enable', 'o1'], opts(host, capture()));
    assert.deepEqual(host.last().body, { enabled: true });
    await runCli(['model-router', 'disable', 'o1'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/model-router/orgs/o1/config/enable`);
    assert.deepEqual(host.last().body, { enabled: false });
    const missing = mockHost(() => json({ error: 'not_found', message: 'No router config to enable; set rules first' }, 404));
    const cap = capture();
    assert.equal(await runCli(['model-router', 'enable', 'o1'], opts(missing, cap)), 2);
    assert.match(cap.stderr, /set rules first/);
  });

  it('dev ucp-merchant call wraps the JSON-RPC envelope', async () => {
    const host = mockHost(() => json({ jsonrpc: '2.0', id: 1, result: {} }));
    await runCli(['dev', 'ucp-merchant', 'call', '--tool', 'ucp.search', '--arguments', '{"q":"mug"}'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/dev/ucp-merchant/mcp`);
    assert.deepEqual(host.last().body, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ucp.search', arguments: { q: 'mug' } } });
  });
});

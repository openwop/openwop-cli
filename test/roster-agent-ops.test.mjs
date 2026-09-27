// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const H = '/v1/host/openwop-app';

describe('roster activity/check', () => {
  it('activity passes --limit/--status and renders the table', async () => {
    const host = mockHost(() => json({ rosterId: 'r1', items: [{ runId: 'run1', workflowId: 'wf', status: 'failed', source: 'schedule', timestamp: 't' }] }));
    const cap = capture();
    assert.equal(await runCli(['roster', 'activity', 'r1', '--limit', '5', '--status', 'failed'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${H}/roster/r1/activity`);
    assert.deepEqual(host.last().query, { limit: '5', status: 'failed' });
    assert.match(cap.stdout, /run1\s+wf\s+failed\s+schedule\s+t/);
  });

  it('check POSTs; 404 → exit 2', async () => {
    const host = mockHost(() => json({ error: 'not_found' }, 404));
    const cap = capture();
    assert.equal(await runCli(['roster', 'check', 'r1'], opts(host, cap)), 2);
    assert.equal(host.last().method, 'POST');
    assert.equal(host.last().path, `${H}/roster/r1/check`);
  });
});

describe('agent-ops (extended)', () => {
  it('clear sends --step list and needs --yes', async () => {
    const host = mockHost(() => json({ success: true }));
    let cap = capture();
    assert.equal(await runCli(['agent-ops', 'clear', '--step', 'crm'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['agent-ops', 'clear', '--step', 'crm', '--step', 'kanban', '--yes'], opts(host, cap)), 0, cap.stderr);
    assert.deepEqual(host.last().body, { steps: ['crm', 'kanban'] });
  });

  it('fleet-activity filters by roster; summary + provision-demo paths', async () => {
    const host = mockHost(() => json({ items: [] }));
    let cap = capture();
    await runCli(['agent-ops', 'fleet-activity', '--roster-id', 'r1', '--limit', '10'], opts(host, cap));
    assert.equal(host.last().path, `${H}/fleet/activity`);
    assert.deepEqual(host.last().query, { limit: '10', rosterId: 'r1' });
    assert.match(cap.stdout, /No activity/);
    cap = capture();
    await runCli(['agent-ops', 'summary', '--json'], opts(host, cap));
    assert.equal(host.last().path, `${H}/example-data-summary`);
    const forbidden = mockHost(() => json({ error: 'forbidden' }, 403));
    cap = capture();
    assert.equal(await runCli(['agent-ops', 'provision-demo', '--yes'], opts(forbidden, cap)), 4);
    assert.equal(forbidden.last().path, `${H}/example-data/provision-demo`);
  });
});

describe('twin recalls', () => {
  it('renders the recall audit table', async () => {
    const host = mockHost(() => json({ recalls: [{ timestamp: 't', outcome: 'denied', agentId: 'a1', reason: 'scope' }] }));
    const cap = capture();
    assert.equal(await runCli(['twin', 'recalls'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${H}/profiles/me/twin-recalls`);
    assert.match(cap.stdout, /t\s+denied\s+a1/);
  });
});

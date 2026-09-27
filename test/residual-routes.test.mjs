// Run via `npm test` (builds dist/ first). Routes added to existing
// hand-written groups from route tables: approvals, advisors,
// campaigns-orchestration, notifications, workflows, kanban, profiles,
// job-search and consent.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const H = '/v1/host/openwop-app';

describe('approvals teams-pref', () => {
  it('set PUTs connectionId + chatId; clear DELETEs without --yes', async () => {
    const host = mockHost(() => json({ pref: null }));
    let cap = capture();
    assert.equal(await runCli(['approvals', 'teams-pref', 'set', '--connection-id', 'conn1', '--chat-id', '19:abc'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, `${H}/approval-delivery/teams`);
    assert.deepEqual(host.last().body, { connectionId: 'conn1', chatId: '19:abc' });
    cap = capture();
    assert.equal(await runCli(['approvals', 'teams-pref', 'clear'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'DELETE');
  });
  it('403 → exit 4 with the host line', async () => {
    const host = mockHost(() => json({ error: 'forbidden', message: 'Managing approval delivery requires a signed-in user.' }, 403));
    const cap = capture();
    assert.equal(await runCli(['approvals', 'teams-pref'], opts(host, cap)), 4);
    assert.match(cap.stderr, /HTTP 403 forbidden: Managing approval delivery requires a signed-in user\./);
  });
});

describe('advisors shared knowledge + strategy context', () => {
  it('shared-knowledge set sends kind + shared:false for --no-shared', async () => {
    const host = mockHost(() => json({ items: [{ kind: 'strategy', shared: false, shareable: true, count: 1 }] }));
    const cap = capture();
    assert.equal(await runCli(['advisors', 'shared-knowledge', 'set', 'b1', '--kind', 'strategy', '--no-shared'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${H}/advisors/boards/b1/shared-knowledge`);
    assert.deepEqual(host.last().body, { kind: 'strategy', shared: false });
  });
  it('strategy-context GETs; --json raw', async () => {
    const host = mockHost(() => json({ strategies: [] }));
    const cap = capture();
    await runCli(['advisors', 'strategy-context', 'b1', '--json'], opts(host, cap));
    assert.equal(host.last().path, `${H}/advisors/boards/b1/strategy-context`);
    assert.deepEqual(JSON.parse(cap.stdout), { strategies: [] });
  });
});

describe('campaigns-orchestration projections', () => {
  it('versions renders nested snapshot fields', async () => {
    const host = mockHost(() => json({ versions: [{ version: 2, versionId: 'v2', snapshot: { name: 'Launch', status: 'draft' }, actor: 'u1', at: 't' }] }));
    const cap = capture();
    assert.equal(await runCli(['campaigns-orchestration', 'versions', 'c1'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${H}/campaign-orchestration/campaigns/c1/versions`);
    assert.match(cap.stdout, /2\s+v2\s+Launch\s+draft\s+u1\s+t/);
  });
  it('workspace and dispatches GET their routes', async () => {
    const host = mockHost(() => json({}));
    let cap = capture();
    await runCli(['campaigns-orchestration', 'workspace', 'c1'], opts(host, cap));
    assert.equal(host.last().path, `${H}/campaign-orchestration/campaigns/c1/workspace`);
    cap = capture();
    await runCli(['campaigns-orchestration', 'dispatches', 'c1'], opts(host, cap));
    assert.equal(host.last().path, `${H}/campaign-orchestration/campaigns/c1/dispatches`);
  });
});

describe('notifications preferences', () => {
  it('set is read-modify-write: quiet-hours edits keep the other fields', async () => {
    const preferences = { globalMute: false, types: [{ type: 'workflow.failed', muted: false, desktop: true }], quietHours: { enabled: false, start: '22:00', end: '08:00', days: [0, 1], allowUrgent: true } };
    const host = mockHost((c) => json({ preferences }));
    const cap = capture();
    assert.equal(await runCli(['notifications', 'preferences', 'set', '--quiet-hours', '--timezone', 'Europe/Oslo'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.calls[0].method, 'GET');
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, `${H}/notifications/preferences`);
    assert.deepEqual(host.last().body, { ...preferences, quietHours: { ...preferences.quietHours, enabled: true, timezone: 'Europe/Oslo' } });
  });
});

describe('workflows budget', () => {
  const B = `${H}/workflows/wf%3A1/budget`;
  it('set keeps the current hardCap when not passed', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { budget: { dailyUsd: 5, hardCap: true, updatedAt: 'd' }, spentTodayUsd: 1 } : { budget: {} }));
    const cap = capture();
    assert.equal(await runCli(['workflows', 'budget', 'set', 'wf:1', '--daily-usd', '12.5'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, B);
    assert.deepEqual(host.last().body, { hardCap: true, dailyUsd: 12.5 });
  });
  it('clear sends dailyUsd:null', async () => {
    const host = mockHost(() => json({ budget: null, removed: true }));
    const cap = capture();
    await runCli(['workflows', 'budget', 'clear', 'wf:1'], opts(host, cap));
    assert.equal(host.last().method, 'PUT');
    assert.deepEqual(host.last().body, { dailyUsd: null });
  });
  it('404 → exit 2', async () => {
    const host = mockHost(() => json({ error: 'workflow_not_found', message: 'Workflow not found in this catalog.' }, 404));
    const cap = capture();
    assert.equal(await runCli(['workflows', 'budget', 'wf:1'], opts(host, cap)), 2);
    assert.match(cap.stderr, /HTTP 404 workflow_not_found/);
  });
});

describe('kanban column limit + work-item run', () => {
  it('column-limit PATCHes wipLimit; clear sends null; work-item-run POSTs', async () => {
    const host = mockHost(() => json({}));
    let cap = capture();
    await runCli(['kanban', 'column-limit', 'b1', 'col1', '--wip-limit', '4'], opts(host, cap));
    assert.equal(host.last().method, 'PATCH');
    assert.equal(host.last().path, `${H}/kanban/boards/b1/columns/col1/limit`);
    assert.deepEqual(host.last().body, { wipLimit: 4 });
    cap = capture();
    await runCli(['kanban', 'column-limit', 'clear', 'b1', 'col1'], opts(host, cap));
    assert.deepEqual(host.last().body, { wipLimit: null });
    cap = capture();
    await runCli(['kanban', 'work-item-run', 'b1', 'wi1'], opts(host, cap));
    assert.equal(host.last().method, 'POST');
    assert.equal(host.last().path, `${H}/kanban/boards/b1/work-items/wi1/run`);
  });
});

describe('profiles memory-extraction + job-search answers', () => {
  it('memory-extraction grant PUTs and revoke DELETEs without --yes', async () => {
    const host = mockHost(() => json({ granted: true, updatedAt: 'd' }));
    let cap = capture();
    assert.equal(await runCli(['profiles', 'memory-extraction', 'grant'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, `${H}/profiles/me/memory-extraction`);
    cap = capture();
    assert.equal(await runCli(['profiles', 'memory-extraction', 'revoke'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'DELETE');
  });
  it('job-search answers set sends confirmed:false for --no-confirmed', async () => {
    const host = mockHost(() => json({ ok: true }));
    const cap = capture();
    await runCli(['job-search', 'answers', 'set', '--question-text', 'Years of Go?', '--value', '5', '--no-confirmed'], opts(host, cap));
    assert.equal(host.last().path, `${H}/job-search/me/answers`);
    assert.deepEqual(host.last().body, { questionText: 'Years of Go?', value: '5', confirmed: false });
  });
});

describe('consent purpose vocabulary + readmit', () => {
  const C = `${H}/consent/orgs/org_1`;
  it('purposes add / strict / remove', async () => {
    const host = mockHost(() => json({ purposes: ['marketing'] }));
    let cap = capture();
    await runCli(['consent', 'purposes', 'add', 'org_1', '--code', 'marketing'], opts(host, cap));
    assert.equal(host.last().path, `${C}/purpose-vocab`);
    assert.deepEqual(host.last().body, { code: 'marketing' });
    cap = capture();
    await runCli(['consent', 'purposes', 'strict', 'org_1', '--strict'], opts(host, cap));
    assert.equal(host.last().path, `${C}/purpose-vocab/strict`);
    assert.deepEqual(host.last().body, { strict: true });
    cap = capture();
    assert.equal(await runCli(['consent', 'purposes', 'remove', 'org_1', 'marketing', '--yes'], opts(host, cap)), 0);
    assert.equal(host.last().method, 'DELETE');
  });
  it('readmit needs --yes and sends the attestation', async () => {
    const host = mockHost(() => json({ ok: true, readmitted: true }));
    let cap = capture();
    assert.equal(await runCli(['consent', 'readmit', 'org_1', 'visitor-1', '--attestation', 'ticket 42'], opts(host, cap)), 2);
    assert.equal(host.calls.length, 0);
    cap = capture();
    assert.equal(await runCli(['consent', 'readmit', 'org_1', 'visitor-1', '--attestation', 'ticket 42', '--yes'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${C}/subjects/visitor-1/readmit`);
    assert.deepEqual(host.last().body, { attestation: 'ticket 42' });
  });
});

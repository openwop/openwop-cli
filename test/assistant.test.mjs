// `openwop assistant …` — the executive assistant work graph.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run } from './fixtures/conversation-harness.mjs';

const A = `${H}/assistant`;

describe('assistant', () => {
  it('projects list (human + --json) and create/update/delete', async () => {
    const host = mockHost({
      [`GET ${A}/projects`]: { projects: [{ projectId: 'p1', name: 'Launch', status: 'active', priority: 80, updatedAt: 't' }] },
      [`POST ${A}/projects`]: () => jsonResponse({ projectId: 'p2', name: 'New' }, 201),
      [`PATCH ${A}/projects/p1`]: { projectId: 'p1' },
      [`DELETE ${A}/projects/p1`]: () => jsonResponse(null, 204),
      [`GET ${A}/projects/p1`]: { projectId: 'p1', name: 'Launch', stakeholderIds: ['s1'] },
    });
    const list = await run(['assistant', 'projects', 'list'], host);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /p1\s+Launch\s+active\s+80/);
    const json = await run(['--json', 'assistant', 'projects', 'list'], host);
    assert.equal(JSON.parse(json.stdout).projects[0].projectId, 'p1');
    await run(['assistant', 'projects', 'create', '--name', 'New', '--priority', '40', '--status', 'paused'], host);
    assert.deepEqual(host.calls.at(-1).body, { name: 'New', priority: 40, status: 'paused' });
    await run(['assistant', 'projects', 'update', 'p1', '--summary', 'S'], host);
    assert.deepEqual(host.calls.at(-1).body, { summary: 'S' });
    assert.equal((await run(['assistant', 'projects', 'delete', 'p1'], host)).code, 2);
    assert.equal((await run(['assistant', 'projects', 'delete', 'p1', '--yes'], host)).code, 0);
    const get = await run(['assistant', 'projects', 'get', 'p1'], host);
    assert.match(get.stdout, /stakeholderIds: s1/);
  });

  it('commitments filters + update; decisions/meetings/stakeholders/briefing/health/workspace reads', async () => {
    const host = mockHost({
      [`GET ${A}/commitments`]: { commitments: [{ commitmentId: 'c1', status: 'open', owner: { name: 'Ann' }, description: 'Send deck' }] },
      [`GET ${A}/commitments/c1`]: { commitmentId: 'c1', status: 'open', source: { kind: 'gmail', externalId: 'x' } },
      [`PATCH ${A}/commitments/c1`]: { commitmentId: 'c1', status: 'done' },
      [`DELETE ${A}/commitments/c1`]: () => jsonResponse(null, 204),
      [`GET ${A}/decisions`]: { decisions: [{ decisionId: 'd1', statement: 'Ship Friday' }] },
      [`GET ${A}/meetings`]: { meetings: [{ meetingId: 'm1', title: 'Sync', attendees: [{}, {}] }] },
      [`GET ${A}/meetings/m1`]: { meetingId: 'm1', title: 'Sync', attendees: [{ name: 'A' }] },
      [`GET ${A}/stakeholders`]: { stakeholders: [{ stakeholderId: 's1', person: { name: 'Bo' }, importance: 9 }] },
      [`GET ${A}/briefing`]: { brief: { headline: 'Busy day' } },
      [`GET ${A}/health`]: { health: { ok: true } },
      [`POST ${A}/workspace-conversation`]: () => jsonResponse({ sessionId: 'ws1' }, 201),
    });
    await run(['assistant', 'commitments', 'list', '--status', 'open', '--project', 'p1'], host);
    assert.deepEqual(host.calls.at(-1).query, { status: 'open', projectId: 'p1' });
    assert.match((await run(['assistant', 'commitments', 'get', 'c1'], host)).stdout, /source: gmail:x/);
    await run(['assistant', 'commitments', 'update', 'c1', '--status', 'done', '--due-at', '2026-10-01'], host);
    assert.deepEqual(host.calls.at(-1).body, { status: 'done', dueAt: '2026-10-01' });
    assert.equal((await run(['assistant', 'commitments', 'delete', 'c1', '--yes'], host)).code, 0);
    await run(['assistant', 'decisions', '--project', 'p1'], host);
    assert.deepEqual(host.calls.at(-1).query, { projectId: 'p1' });
    assert.match((await run(['assistant', 'meetings', 'list'], host)).stdout, /m1\s+Sync\s+2/);
    assert.match((await run(['assistant', 'meetings', 'get', 'm1'], host)).stdout, /attendees: A/);
    assert.match((await run(['assistant', 'stakeholders'], host)).stdout, /s1\s+Bo\s+9/);
    assert.match((await run(['assistant', 'briefing'], host)).stdout, /Busy day/);
    assert.match((await run(['assistant', 'health'], host)).stdout, /"ok": true/);
    assert.match((await run(['assistant', 'workspace'], host)).stdout, /Opened workspace conversation ws1/);
  });

  it('pending approve REQUIRES the content hash and forwards it; reject/edit', async () => {
    const host = mockHost({
      [`GET ${A}/pending-actions`]: { pendingActions: [{ actionId: 'a1', kind: 'email.send', status: 'pending', riskLevel: 'low' }] },
      [`POST ${A}/pending-actions/a1/approve`]: { actionId: 'a1', status: 'approved' },
      [`POST ${A}/pending-actions/a1/reject`]: { actionId: 'a1', status: 'rejected' },
      [`PATCH ${A}/pending-actions/a1`]: { actionId: 'a1' },
    });
    await run(['assistant', 'pending', 'list', '--status', 'pending'], host);
    assert.deepEqual(host.calls.at(-1).query, { status: 'pending' });
    const noHash = await run(['assistant', 'pending', 'approve', 'a1'], host);
    assert.equal(noHash.code, 2);
    assert.match(noHash.stderr, /--content-hash/);
    const ok = await run(['assistant', 'pending', 'approve', 'a1', '--content-hash', 'h1'], host);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(host.calls.at(-1).body, { expectedContentHash: 'h1' });
    await run(['assistant', 'pending', 'reject', 'a1'], host);
    assert.deepEqual(host.calls.at(-1).body, {});
    await run(['assistant', 'pending', 'edit', 'a1', '--draft', 'Hi', '--body', '{"recipientDiff":{"before":["a"],"after":["b"]}}'], host);
    assert.deepEqual(host.calls.at(-1).body, { recipientDiff: { before: ['a'], after: ['b'] }, draft: 'Hi' });
  });

  it('loops list/enable/disable', async () => {
    const host = mockHost({
      [`GET ${A}/loops`]: { loops: [{ loopId: 'morning-briefing', label: 'Morning', enabled: false }] },
      [`POST ${A}/loops/morning-briefing/enable`]: { loop: 'morning-briefing', jobId: 'j', enabled: true },
      [`POST ${A}/loops/morning-briefing/disable`]: { loop: 'morning-briefing', jobId: 'j', enabled: false },
    });
    assert.match((await run(['assistant', 'loops'], host)).stdout, /morning-briefing\s+Morning\s+no/);
    await run(['assistant', 'loops', 'enable', 'morning-briefing', '--cron', '0 7 * * *'], host);
    assert.deepEqual(host.calls.at(-1).body, { cronExpr: '0 7 * * *' });
    assert.match((await run(['assistant', 'loops', 'disable', 'morning-briefing'], host)).stdout, /disabled/);
  });

  it('403 on the approval queue → exit 4 with the host message', async () => {
    const host = mockHost({ [`GET ${A}/pending-actions`]: () => jsonResponse({ error: 'forbidden', message: 'workspace:write required' }, 403) });
    const r = await run(['assistant', 'pending', 'list'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /HTTP 403 forbidden: workspace:write required/);
  });
});

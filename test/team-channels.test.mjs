// `openwop channels …` — team channels (not the relay channel normalizers in channels.test.mjs).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run, sseResponse } from './fixtures/conversation-harness.mjs';

const C = `${H}/channels`;

describe('channels', () => {
  it('list (human + --json) and create', async () => {
    const body = { channels: [{ conversationId: 'ch1', channel: { name: 'launch', visibility: 'public' }, joined: true, memberCount: 3, agentCount: 1, unreadCount: 2 }] };
    const host = mockHost({ [`GET ${C}`]: body, [`POST ${C}`]: () => jsonResponse({ channel: { conversationId: 'ch2', channel: { name: 'ops' } } }, 201) });
    const r = await run(['channels', 'list'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ch1\s+launch\s+public\s+yes\s+3\s+1\s+2/);
    assert.deepEqual(JSON.parse((await run(['--json', 'channels'], host)).stdout), body);
    const c = await run(['channels', 'create', '--name', 'ops', '--private', '--agent', 'ag1', '--member', 'u1'], host);
    assert.equal(c.code, 0, c.stderr);
    assert.deepEqual(host.calls.at(-1).body, { name: 'ops', visibility: 'private', memberUserIds: ['u1'], agentIds: ['ag1'] });
    assert.match(c.stdout, /Created channel ch2 \(#ops\)/);
  });

  it('get/update/archive/join/leave/messages/post', async () => {
    const host = mockHost({
      [`GET ${C}/ch1`]: { channel: { conversationId: 'ch1', channel: { name: 'launch' }, viewerIsOwner: true, roster: [{ subjectRef: 'agent:a', displayName: 'Planner', kind: 'agent', role: 'member', responsePolicy: 'mention' }] } },
      [`PATCH ${C}/ch1`]: { channel: { conversationId: 'ch1' } },
      [`POST ${C}/ch1/archive`]: () => jsonResponse(null, 204),
      [`POST ${C}/ch1/join`]: { channel: { conversationId: 'ch1' } },
      [`DELETE ${C}/ch1/members/me`]: () => jsonResponse(null, 204),
      [`GET ${C}/ch1/messages`]: { messages: [{ messageId: 'm', content: 'yo', authorDisplayName: 'Ann', createdAt: 't' }], nextCursor: 'cur' },
      [`POST ${C}/ch1/messages`]: () => jsonResponse({ messageId: 'm2' }, 201),
    });
    assert.match((await run(['channels', 'get', 'ch1'], host)).stdout, /agent:a\s+Planner\s+agent\s+member\s+mention/);
    await run(['channels', 'update', 'ch1', '--description', 'D'], host);
    assert.deepEqual(host.calls.at(-1).body, { description: 'D' });
    assert.equal((await run(['channels', 'archive', 'ch1'], host)).code, 2);
    assert.equal((await run(['channels', 'archive', 'ch1', '--yes'], host)).code, 0);
    assert.equal((await run(['channels', 'join', 'ch1'], host)).code, 0);
    assert.equal((await run(['channels', 'leave', 'ch1'], host)).code, 0);
    const msgs = await run(['channels', 'messages', 'ch1', '--limit', '20'], host);
    assert.deepEqual(host.calls.at(-1).query, { limit: '20' });
    assert.match(msgs.stdout, /Ann: yo/);
    assert.match(msgs.stdout, /--before cur/);
    await run(['channels', 'post', 'ch1', '--content', '@planner hi'], host);
    assert.deepEqual(host.calls.at(-1).body, { content: '@planner hi' });
  });

  it('members / agents / catchup / presence snapshot / typing', async () => {
    const host = mockHost({
      [`POST ${C}/ch1/members`]: { channel: {} },
      [`DELETE ${C}/ch1/members/u1`]: { channel: {} },
      [`DELETE ${C}/ch1/agents/ag1`]: { channel: {} },
      [`PUT ${C}/ch1/agents/ag1/policy`]: { channel: {} },
      [`POST ${C}/ch1/catchup`]: () => jsonResponse({ runId: 'r1', unreadCount: 4 }, 202),
      [`GET ${C}/ch1/presence/snapshot`]: { conversationId: 'ch1', present: ['user:u'], typing: [] },
      [`POST ${C}/ch1/presence/typing`]: () => jsonResponse(null, 204),
    });
    await run(['channels', 'members', 'add', 'ch1', '--agent', 'ag1'], host);
    assert.deepEqual(host.calls.at(-1).body, { agentId: 'ag1' });
    await run(['channels', 'members', 'add', 'ch1', '--user', 'u1'], host);
    assert.deepEqual(host.calls.at(-1).body, { userId: 'u1' });
    assert.equal((await run(['channels', 'members', 'remove', 'ch1', 'u1'], host)).code, 0);
    assert.equal((await run(['channels', 'agents', 'remove', 'ch1', 'ag1'], host)).code, 0);
    assert.equal((await run(['channels', 'agents', 'policy', 'ch1', 'ag1', 'bogus'], host)).code, 2);
    await run(['channels', 'agents', 'policy', 'ch1', 'ag1', 'mention'], host);
    assert.deepEqual(host.calls.at(-1).body, { policy: 'mention' });
    assert.match((await run(['channels', 'catchup', 'ch1'], host)).stdout, /run r1 \(4 unread/);
    assert.match((await run(['channels', 'presence-snapshot', 'ch1'], host)).stdout, /present: user:u/);
    await run(['channels', 'typing', 'ch1', '--stop'], host);
    assert.deepEqual(host.calls.at(-1).body, { typing: false });
  });

  it('stream + presence consume server-sent events and stop at --max-events', async () => {
    const host = mockHost({
      [`GET ${C}/ch1/stream`]: () => sseResponse([{ event: 'channel.message', data: { messageId: 'm1' } }, { event: 'channel.message', data: { messageId: 'm2' } }]),
      [`GET ${C}/ch1/presence`]: () => sseResponse([{ event: 'channel.presence', data: { present: ['user:a'], typing: [] } }]),
    });
    const s = await run(['channels', 'stream', 'ch1', '--max-events', '1'], host);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /\[channel\.message\] \{"messageId":"m1"\}/);
    assert.doesNotMatch(s.stdout, /m2/);
    assert.equal(host.calls.at(-1).headers.accept, 'text/event-stream');
    const p = await run(['--json', 'channels', 'presence', 'ch1'], host);
    assert.deepEqual(JSON.parse(p.stdout.trim()), { event: 'channel.presence', data: { present: ['user:a'], typing: [] } });
  });

  it('403 on a stream (not a member) → exit 4, legible', async () => {
    const host = mockHost({ [`GET ${C}/ch1/stream`]: () => jsonResponse({ error: 'forbidden', message: 'Not a channel member.' }, 403) });
    const r = await run(['channels', 'stream', 'ch1'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /HTTP 403 forbidden: Not a channel member\./);
  });
});

// `openwop scheduled-chats …` — org + channel scoped scheduled agent chats.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run } from './fixtures/conversation-harness.mjs';

const ORG = `${H}/scheduled-chats/orgs/o1/chats`;
const CH = `${H}/scheduled-chats/channels/c1/chats`;

describe('scheduled-chats', () => {
  it('list per scope (human + --json); scope is required and exclusive', async () => {
    const body = { chats: [{ chatId: 'x', agentId: 'ag', cronExpr: '0 9 * * 1', enabled: true, nextRunAt: 'n', prompt: 'status' }] };
    const host = mockHost({ [`GET ${ORG}`]: body, [`GET ${CH}`]: { chats: [] } });
    const r = await run(['scheduled-chats', 'list', '--org', 'o1'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /x\s+ag\s+0 9 \* \* 1\s+yes\s+n/);
    assert.deepEqual(JSON.parse((await run(['--json', 'scheduled-chats', 'list', '--org', 'o1'], host)).stdout), body);
    assert.match((await run(['scheduled-chats', 'list', '--channel', 'c1'], host)).stdout, /No scheduled chats/);
    assert.equal((await run(['scheduled-chats', 'list'], host)).code, 2);
    assert.equal((await run(['scheduled-chats', 'list', '--org', 'o1', '--channel', 'c1'], host)).code, 2);
  });

  it('create (org needs --conversation; channel forces it), get, pause/resume, delete', async () => {
    const host = mockHost({
      [`POST ${ORG}`]: () => jsonResponse({ chat: { chatId: 'n1' } }, 201),
      [`POST ${CH}`]: () => jsonResponse({ chat: { chatId: 'n2' } }, 201),
      [`GET ${ORG}/n1`]: { chat: { chatId: 'n1', cronExpr: '* * * * *', enabled: false } },
      [`POST ${ORG}/n1/pause`]: { chat: {} },
      [`POST ${CH}/n2/pause`]: { chat: {} },
      [`DELETE ${CH}/n2`]: () => jsonResponse(null, 204),
    });
    assert.equal((await run(['scheduled-chats', 'create', '--org', 'o1', '--agent', 'a', '--prompt', 'p', '--cron', '0 9 * * *'], host)).code, 2);
    await run(['scheduled-chats', 'create', '--org', 'o1', '--conversation', 'cv', '--agent', 'a', '--prompt', 'p', '--cron', '0 9 * * *', '--timezone', 'UTC'], host);
    assert.deepEqual(host.calls.at(-1).body, { agentId: 'a', prompt: 'p', cronExpr: '0 9 * * *', conversationId: 'cv', timezone: 'UTC' });
    await run(['scheduled-chats', 'create', '--channel', 'c1', '--agent', 'a', '--prompt', 'p', '--cron', '0 9 * * *'], host);
    assert.deepEqual(host.calls.at(-1).body, { agentId: 'a', prompt: 'p', cronExpr: '0 9 * * *' });
    assert.match((await run(['scheduled-chats', 'get', 'n1', '--org', 'o1'], host)).stdout, /enabled: no/);
    await run(['scheduled-chats', 'pause', 'n1', '--org', 'o1'], host);
    assert.deepEqual(host.calls.at(-1).body, { enabled: false });
    await run(['scheduled-chats', 'resume', 'n2', '--channel', 'c1'], host);
    assert.deepEqual(host.calls.at(-1).body, { enabled: true });
    assert.equal((await run(['scheduled-chats', 'delete', 'n2', '--channel', 'c1', '--yes'], host)).code, 0);
  });

  it('403 → exit 4 with the host message', async () => {
    const host = mockHost({ [`POST ${CH}`]: () => jsonResponse({ error: 'forbidden', message: 'Only the channel owner can manage schedules.' }, 403) });
    const r = await run(['scheduled-chats', 'create', '--channel', 'c1', '--agent', 'a', '--prompt', 'p', '--cron', '* * * * *'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /Only the channel owner/);
  });
});

// `openwop chat <conversation subcommands>` — the persistent conversation primitive.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run } from './fixtures/conversation-harness.mjs';

const S = `${H}/chat/sessions`;

describe('chat sessions', () => {
  it('lists conversations as a table and passes --json through', async () => {
    const body = { sessions: [{ sessionId: 's1', title: 'Plan', type: 'group', messageCount: 3, participants: [{ subjectRef: 'agent:a' }], updatedAt: 't' }] };
    const host = mockHost({ [`GET ${S}`]: body });
    const human = await run(['chat', 'sessions', 'list'], host);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /s1\s+group\s+Plan\s+3\s+1/);
    const json = await run(['--json', 'chat', 'sessions', 'list'], host);
    assert.deepEqual(JSON.parse(json.stdout), body);
  });

  it('creates with the host field names + an idempotency key', async () => {
    const host = mockHost({ [`POST ${S}`]: () => jsonResponse({ sessionId: 'new', title: 'T' }, 201) });
    const r = await run(['chat', 'sessions', 'create', '--title', 'T', '--type', 'group', '--participant', 'agent:x', '--participant', 'user:y', '--board-id', 'b1'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(host.calls[0].body, { title: 'T', type: 'group', participants: ['agent:x', 'user:y'], boardId: 'b1' });
    assert.match(host.calls[0].headers['idempotency-key'], /^[A-Za-z0-9._~-]{22,128}$/);
    assert.match(r.stdout, /Created conversation new/);
  });

  it('get / update / delete / branch / read / board / bind-run hit their routes', async () => {
    const id = 'a/b';
    const p = `${S}/${encodeURIComponent(id)}`;
    const host = mockHost({
      [`GET ${p}`]: { sessionId: id, title: 'x', participants: [] },
      [`PATCH ${p}`]: { sessionId: id, title: 'y' },
      [`DELETE ${p}`]: () => jsonResponse(null, 204),
      [`POST ${p}/branch`]: () => jsonResponse({ sessionId: 'child', messageCount: 2 }, 201),
      [`POST ${p}/read`]: () => jsonResponse(null, 204),
      [`POST ${p}/board`]: { sessionId: id, participants: [{}, {}] },
      [`PUT ${p}/conversation-run`]: () => jsonResponse(null, 204),
    });
    assert.equal((await run(['chat', 'sessions', 'get', id], host)).code, 0);
    assert.equal((await run(['chat', 'sessions', 'update', id, '--title', 'y'], host)).code, 0);
    assert.deepEqual(host.calls.at(-1).body, { title: 'y' });
    assert.equal((await run(['chat', 'sessions', 'delete', id], host)).code, 2, 'delete refuses without --yes');
    assert.equal((await run(['chat', 'sessions', 'delete', id, '--yes'], host)).code, 0);
    const br = await run(['chat', 'sessions', 'branch', id, '--from-seq', '2'], host);
    assert.equal(br.code, 0, br.stderr);
    assert.deepEqual(host.calls.at(-1).body, { fromSeq: 2 });
    assert.equal((await run(['chat', 'sessions', 'read', id], host)).code, 0);
    assert.equal((await run(['chat', 'sessions', 'board', id, '--board-id', 'b9'], host)).code, 0);
    assert.deepEqual(host.calls.at(-1).body, { boardId: 'b9' });
    assert.equal((await run(['chat', 'sessions', 'bind-run', id, '--run-id', 'r1'], host)).code, 0);
    assert.deepEqual(host.calls.at(-1).body, { conversationRunId: 'r1' });
    assert.ok(host.calls.every((c) => c.path.startsWith(p)), 'the id is URL-encoded as one segment');
  });

  it('403 → legible message + exit 4', async () => {
    const host = mockHost({ [`GET ${S}`]: () => jsonResponse({ error: 'forbidden', message: 'Not a participant.' }, 403) });
    const r = await run(['chat', 'sessions', 'list'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /HTTP 403 forbidden: Not a participant\./);
    assert.doesNotMatch(r.stderr, /at .*\.js/);
  });
});

describe('chat messages', () => {
  const p = `${S}/s1/messages`;
  it('lists with paging params and renders the next cursor', async () => {
    const host = mockHost({ [`GET ${p}`]: { messages: [{ messageId: 'm1', role: 'user', content: 'hi', createdAt: 't', reactions: [{ emoji: '👍', count: 2 }] }], nextCursor: 'c1' } });
    const r = await run(['chat', 'messages', 'list', 's1', '--limit', '10', '--before', 'c0'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(host.calls[0].query, { limit: '10', before: 'c0' });
    assert.match(r.stdout, /user m1: hi\s+\[👍2\]/);
    assert.match(r.stdout, /--before c1/);
  });

  it('send mints a messageId and defaults role=user; edit/delete/react/unreact', async () => {
    const host = mockHost({
      [`POST ${p}`]: (c) => jsonResponse({ messageId: c.body.messageId }, 201),
      [`PUT ${p}/m1`]: { messageId: 'm1', content: 'new' },
      [`DELETE ${p}/m1`]: () => jsonResponse(null, 204),
      [`PUT ${p}/m1/reactions/${encodeURIComponent('👍')}`]: { messageId: 'm1', reactions: [{ emoji: '👍', count: 1 }] },
      [`DELETE ${p}/m1/reactions/${encodeURIComponent('👍')}`]: { messageId: 'm1', reactions: [] },
    });
    const sent = await run(['chat', 'messages', 'send', 's1', '--content', 'hello', '--meta', '{"k":1}'], host);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(host.calls[0].body.role, 'user');
    assert.equal(host.calls[0].body.content, 'hello');
    assert.equal(host.calls[0].body.meta, '{"k":1}');
    assert.match(host.calls[0].body.messageId, /^[0-9a-f-]{36}$/);
    assert.equal((await run(['chat', 'messages', 'edit', 's1', 'm1', '--content', 'new'], host)).code, 0);
    assert.deepEqual(host.calls.at(-1).body, { content: 'new' });
    assert.equal((await run(['chat', 'messages', 'delete', 's1', 'm1', '--yes'], host)).code, 0);
    const react = await run(['chat', 'messages', 'react', 's1', 'm1', '👍'], host);
    assert.equal(react.code, 0, react.stderr);
    assert.match(react.stdout, /Reacted 👍 on m1\. Now: 👍1/);
    assert.equal((await run(['chat', 'messages', 'unreact', 's1', 'm1', '👍'], host)).code, 0);
    assert.equal(host.calls.at(-1).method, 'DELETE');
  });
});

describe('chat participants / open / feedback / models', () => {
  it('participants add/remove/list', async () => {
    const base = `${S}/s1/participants`;
    const host = mockHost({
      [`GET ${base}`]: { participants: [{ subjectRef: 'agent:a', role: 'member' }] },
      [`PUT ${base}`]: { participants: [] },
      [`DELETE ${base}/${encodeURIComponent('agent:a')}`]: { participants: [] },
    });
    const list = await run(['chat', 'participants', 'list', 's1'], host);
    assert.match(list.stdout, /agent:a\s+member/);
    await run(['chat', 'participants', 'add', 's1', 'agent:a'], host);
    assert.deepEqual(host.calls.at(-1).body, { subjectRef: 'agent:a' });
    assert.equal((await run(['chat', 'participants', 'remove', 's1', 'agent:a'], host)).code, 0);
  });

  it('open resolves a 1:1 conversation', async () => {
    const host = mockHost({ [`POST ${H}/chat/conversations/open`]: () => jsonResponse({ sessionId: 'dm1' }, 201) });
    const r = await run(['chat', 'open', '--subject', 'agent:bot', '--type', 'agent'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(host.calls[0].body, { subjectRef: 'agent:bot', type: 'agent' });
    assert.match(r.stdout, /Opened conversation dm1/);
  });

  it('feedback set/get/list', async () => {
    const host = mockHost({
      [`POST ${H}/chat/messages/m1/feedback`]: { rating: 'up' },
      [`GET ${H}/chat/messages/m1/feedback`]: { feedback: { rating: 'down', reason: 'wrong' } },
      [`GET ${S}/s1/feedback`]: { feedback: { m1: 'up' } },
    });
    await run(['chat', 'feedback', 'set', 'm1', '--conversation', 's1', '--rating', 'up', '--reason', 'good'], host);
    assert.deepEqual(host.calls[0].body, { conversationId: 's1', rating: 'up', reason: 'good' });
    const got = await run(['chat', 'feedback', 'get', 'm1', '--conversation', 's1'], host);
    assert.deepEqual(host.calls[1].query, { conversationId: 's1' });
    assert.match(got.stdout, /m1: down — wrong/);
    const list = await run(['chat', 'feedback', 'list', 's1'], host);
    assert.match(list.stdout, /m1\s+up/);
  });

  it('models renders the picker', async () => {
    const host = mockHost({ [`GET ${H}/chat/model-capabilities`]: { providers: [{ provider: 'anthropic', models: [{ id: 'claude-x', label: 'X', recommended: true, capabilities: ['text', 'tools', 'vision'] }] }] } });
    const r = await run(['chat', 'models'], host);
    assert.match(r.stdout, /anthropic\s+claude-x\s+X\s+yes\s+text,tools,vision/);
  });
});

describe('chat search / export / import / tools', () => {
  it('search via GET query and via --post body', async () => {
    const host = mockHost({ [`GET ${H}/chat/search`]: { hits: [{ conversationId: 'c1', title: 'T', snippet: 'a  b', score: 1 }] }, [`POST ${H}/chat/search`]: { hits: [] } });
    const r = await run(['chat', 'search', 'price', 'list', '--type', 'group', '--limit', '5'], host);
    assert.deepEqual(host.calls[0].query, { q: 'price list', type: 'group', limit: '5' });
    assert.match(r.stdout, /c1\s+T/);
    const p = await run(['chat', 'search', 'x', '--post'], host);
    assert.equal(p.code, 0);
    assert.deepEqual(host.calls[1].body, { q: 'x' });
    assert.match(p.stdout, /No matches/);
  });

  it('export writes markdown to a file; json passes through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-chat-'));
    const host = mockHost({
      [`GET ${H}/chat-export/s1`]: (c) => c.query.format === 'md'
        ? new Response('# Plan\n\nuser: hi\n', { status: 200, headers: { 'content-type': 'text/markdown' } })
        : jsonResponse({ version: 1, messages: [] }),
    });
    const out = join(dir, 't.md');
    const r = await run(['chat', 'export', 's1', '--output', out], host);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(out, 'utf8'), '# Plan\n\nuser: hi\n');
    const j = await run(['chat', 'export', 's1', '--format', 'json'], host);
    assert.deepEqual(JSON.parse(j.stdout), { version: 1, messages: [] });
  });

  it('import posts { format, data } from the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-chat-'));
    const f = join(dir, 'e.json');
    writeFileSync(f, JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'x' }] }));
    const host = mockHost({ [`POST ${H}/chat-export/import`]: () => jsonResponse({ sessionId: 'imp', imported: 1 }, 201) });
    const r = await run(['chat', 'import', '--file', f, '--format', 'openwop'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(host.calls[0].body.format, 'openwop');
    assert.equal(host.calls[0].body.data.messages[0].content, 'x');
    assert.match(r.stdout, /Imported 1 message\(s\) into conversation imp/);
  });

  it('tools set reads first and replaces only the lists passed; approve/deny', async () => {
    const base = `${H}/conversation-tools/sessions/s1`;
    const host = mockHost({
      [`GET ${base}/capability-scope`]: { scope: { mode: 'restricted', enabled: ['a'], disabled: ['b'] }, approvals: [{ toolName: 't', status: 'pending', requestedAt: 'x' }] },
      [`PUT ${base}/capability-scope`]: (c) => jsonResponse({ scope: c.body.scope ?? { mode: 'agent-default' } }),
      [`POST ${base}/approvals/t`]: { approval: { status: 'approved' } },
    });
    const g = await run(['chat', 'tools', 'get', 's1'], host);
    assert.match(g.stdout, /mode: restricted/);
    assert.match(g.stdout, /t\s+pending/);
    await run(['chat', 'tools', 'set', 's1', '--require-approval', 'c'], host);
    assert.deepEqual(host.calls.at(-1).body, { scope: { mode: 'restricted', enabled: ['a'], disabled: ['b'], requireApproval: ['c'] } });
    await run(['chat', 'tools', 'set', 's1', '--clear'], host);
    assert.deepEqual(host.calls.at(-1).body, { scope: null });
    await run(['chat', 'tools', 'deny', 's1', 't'], host);
    assert.deepEqual(host.calls.at(-1).body, { decision: 'denied' });
  });

  it('an unknown first word still starts the REPL (workflow id), not a subcommand error', async () => {
    const r = await run(['chat'], mockHost());
    assert.equal(r.code, 2);
    assert.match(r.stdout, /openwop chat sessions list/);
  });
});

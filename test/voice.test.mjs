// `openwop voice …` — walkie-talkie sessions + the realtime bridge.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run, sseResponse } from './fixtures/conversation-harness.mjs';

const V = `${H}/voice/session`;
const R = `${H}/voice/realtime`;

describe('voice session', () => {
  it('start / audio (file → base64 chunks) / commit / speak / barge-in / close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-voice-'));
    const audio = join(dir, 'a.webm');
    writeFileSync(audio, Buffer.from('hello audio'));
    const host = mockHost({
      [`POST ${V}`]: () => jsonResponse({ session: { sessionId: 'v1', transport: 'http-chunked', streamRef: 'sr' } }, 201),
      [`POST ${V}/v1/audio`]: (c) => jsonResponse({ streamRef: 'sr', bytes: Buffer.from(c.body.audioChunk, 'base64').length }, 202),
      [`POST ${V}/v1/commit`]: { finalText: 'hello there', language: 'en', turns: 1, events: [{ type: 'voice.transcript_final', payload: {} }] },
      [`POST ${V}/v1/speak`]: { turnId: 't1', audio: { url: 'https://x/a.mp3', mimeType: 'audio/mpeg' } },
      [`POST ${V}/v1/barge-in`]: { cancelledTurn: 't1', events: [{ type: 'voice.barge_in', payload: { atMs: 5 } }] },
      [`DELETE ${V}/v1`]: () => jsonResponse(null, 204),
    });
    const st = await run(['voice', 'session', 'start', '--agent', 'ag', '--conversation', 'cv'], host);
    assert.equal(st.code, 0, st.stderr);
    assert.deepEqual(host.calls.at(-1).body, { conversationId: 'cv', agentId: 'ag' });
    assert.match(st.stdout, /Voice session v1 open/);
    const up = await run(['voice', 'session', 'audio', 'v1', '--file', audio], host);
    assert.equal(up.code, 0, up.stderr);
    assert.equal(Buffer.from(host.calls.at(-1).body.audioChunk, 'base64').toString(), 'hello audio');
    assert.match(up.stdout, /11 bytes/);
    const cm = await run(['voice', 'session', 'commit', 'v1', '--language', 'en'], host);
    assert.deepEqual(host.calls.at(-1).body, { languageCode: 'en' });
    assert.match(cm.stdout, /transcript: hello there/);
    const sp = await run(['voice', 'session', 'speak', 'v1', '--text', 'Hi', '--voice-id', 'aria'], host);
    assert.deepEqual(host.calls.at(-1).body, { text: 'Hi', voiceId: 'aria' });
    assert.match(sp.stdout, /url: https:\/\/x\/a\.mp3/);
    await run(['voice', 'session', 'barge-in', 'v1', '--at-ms', '5'], host);
    assert.deepEqual(host.calls.at(-1).body, { atMs: 5 });
    assert.equal((await run(['voice', 'session', 'close', 'v1'], host)).code, 0);
  });

  it('barge-in-demo drives the scripted seam', async () => {
    const host = mockHost({ [`POST ${H}/voice/barge-in`]: { events: [{ type: 'voice.synthesis_chunk', payload: { seq: 0 } }, { type: 'voice.cancelled', payload: {} }], droppedChunks: 2 } });
    const r = await run(['voice', 'barge-in-demo', '--chunks', '4', '--barge-in-at-seq', '1'], host);
    assert.deepEqual(host.calls[0].body, { chunks: 4, bargeInAtSeq: 1 });
    assert.match(r.stdout, /droppedChunks: 2/);
  });

  it('voice mode off → 404 → exit 2 with the host message', async () => {
    const host = mockHost({ [`POST ${V}`]: () => jsonResponse({ error: 'not_found', message: 'Voice mode is not enabled.' }, 404) });
    const r = await run(['voice', 'session', 'start'], host);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Voice mode is not enabled/);
  });
});

describe('voice realtime', () => {
  it('session redacts the ephemeral token unless --reveal-token (which warns once)', async () => {
    const body = { hostSessionId: 'h1', realtime: { provider: 'openai-realtime', model: 'm', token: 'eph_SECRET', connect: { kind: 'webrtc', url: 'https://p' }, tools: [] } };
    const host = mockHost({ [`POST ${R}/session`]: body });
    const plain = await run(['--json', 'voice', 'realtime', 'session', '--agent', 'ag'], host);
    assert.equal(plain.code, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /eph_SECRET/);
    assert.equal(JSON.parse(plain.stdout).hostSessionId, 'h1');
    const human = await run(['voice', 'realtime', 'session'], host);
    assert.doesNotMatch(human.stdout, /eph_SECRET/);
    const reveal = await run(['voice', 'realtime', 'session', '--reveal-token'], host);
    assert.match(reveal.stdout, /token: eph_SECRET/);
    assert.match(reveal.stderr, /warning/);
  });

  it('config set reads first and changes only what is passed; capability; tool-call; resolve-approval', async () => {
    const host = mockHost({
      [`GET ${R}/config`]: { provider: 'openai-realtime', credentialRef: 'ref-1', model: 'm1' },
      [`PUT ${R}/config`]: (c) => jsonResponse(c.body),
      [`GET ${R}/capability`]: { provider: 'gemini-live' },
      [`POST ${R}/tool-call`]: { callId: 'c', status: 'ok' },
      [`POST ${R}/held-approvals/resolve`]: { status: 'approved' },
    });
    await run(['voice', 'realtime', 'config', 'set', '--model', 'm2'], host);
    assert.deepEqual(host.calls.at(-1).body, { provider: 'openai-realtime', credentialRef: 'ref-1', model: 'm2' });
    assert.match((await run(['voice', 'realtime', 'config', 'get'], host)).stdout, /credentialRef: ref-1/);
    assert.match((await run(['voice', 'realtime', 'capability'], host)).stdout, /gemini-live/);
    await run(['voice', 'realtime', 'tool-call', '--session', 'h1', '--name', 'kb.search', '--arguments', '{"q":"x"}', '--user-approved'], host);
    assert.deepEqual(host.calls.at(-1).body, { sessionId: 'h1', name: 'kb.search', arguments: { q: 'x' }, userApproved: true });
    assert.equal((await run(['voice', 'realtime', 'resolve-approval', '--call-id', 'c', '--fc-id', 'f'], host)).code, 2);
    await run(['voice', 'realtime', 'resolve-approval', '--call-id', 'c', '--fc-id', 'f', '--deny'], host);
    assert.deepEqual(host.calls.at(-1).body, { callId: 'c', fcId: 'f', approve: false });
  });

  it('connect exchanges an SDP offer; transcript streams message ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-voice-'));
    const offer = join(dir, 'offer.sdp');
    writeFileSync(offer, 'v=0\r\noffer\r\n');
    const host = mockHost({
      [`POST ${R}/openai/connect`]: { sessionId: 'rtc', sdp: 'v=0\r\nanswer\r\n' },
      [`GET ${R}/messages/stream`]: () => sseResponse([{ event: 'chat.message', data: { messageId: 'm1' } }]),
    });
    const c = await run(['voice', 'realtime', 'connect', '--sdp-file', offer, '--agent', 'ag'], host);
    assert.equal(c.code, 0, c.stderr);
    assert.deepEqual(host.calls.at(-1).body, { sdp: 'v=0\r\noffer\r\n', agentId: 'ag' });
    assert.match(c.stdout, /answer/);
    const t = await run(['voice', 'realtime', 'transcript', '--conversation', 'cv', '--max-events', '1'], host);
    assert.equal(t.code, 0, t.stderr);
    assert.deepEqual(host.calls.at(-1).query, { conversationId: 'cv' });
    assert.match(t.stdout, /\[chat\.message\] \{"messageId":"m1"\}/);
  });

  it('config read by a non-operator → 403 → exit 4', async () => {
    const host = mockHost({ [`GET ${R}/config`]: () => jsonResponse({ error: 'forbidden', message: 'Superadmin required.' }, 403) });
    const r = await run(['voice', 'realtime', 'config', 'get'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /HTTP 403 forbidden: Superadmin required\./);
  });
});

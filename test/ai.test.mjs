// `openwop ai …` — the AI-provider seams + the subscription-credential bind rail.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run } from './fixtures/conversation-harness.mjs';

describe('ai', () => {
  it('call wraps --message as one user turn; --json passes through', async () => {
    const body = { ok: true, accepted: true, advertised: ['text', 'image'], modalities: ['text'] };
    const host = mockHost({ [`POST ${H}/ai/call`]: body });
    const r = await run(['ai', 'call', '--message', 'hi', '--provider', 'anthropic', '--model', 'm'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(host.calls[0].body, { messages: [{ role: 'user', content: 'hi' }], provider: 'anthropic', model: 'm' });
    assert.match(r.stdout, /accepted: yes/);
    assert.match(r.stdout, /modalities: text/);
    const j = await run(['--json', 'ai', 'call', '--messages-json', '[{"role":"user","content":"x"}]'], host);
    assert.deepEqual(JSON.parse(j.stdout), body);
  });

  it('an unadvertised modality is a legible 400 (exit 2)', async () => {
    const host = mockHost({ [`POST ${H}/ai/call`]: () => jsonResponse({ error: 'unsupported_modality', message: 'audio is not advertised' }, 400) });
    const r = await run(['ai', 'call', '--messages-json', '[{"role":"user","content":[{"type":"audio","url":"u"}]}]'], host);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /HTTP 400 unsupported_modality: audio is not advertised/);
  });

  it('speech + transcribe hit their seams with the host field names', async () => {
    const host = mockHost({
      [`POST ${H}/ai/call-speech-synthesizer`]: { audio: { url: 'https://a', mimeType: 'audio/mpeg' }, voiceId: 'v' },
      [`POST ${H}/ai/call-transcriber`]: { finalText: 'hello', language: 'en', events: [{ type: 'voice.transcript_final' }] },
    });
    const s = await run(['ai', 'speech', '--text', 'Hi', '--voice-id', 'v', '--stream'], host);
    assert.deepEqual(host.calls[0].body, { text: 'Hi', voiceId: 'v', stream: true });
    assert.match(s.stdout, /url: https:\/\/a/);
    const t = await run(['ai', 'transcribe', '--url', 'https://f.wav', '--language', 'en'], host);
    assert.deepEqual(host.calls[1].body, { audio: { url: 'https://f.wav' }, languageCode: 'en' });
    assert.match(t.stdout, /transcript: hello/);
  });

  it('bind-credential reads the value from a file/env (never argv) and prints only the ref', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-ai-'));
    const f = join(dir, 'tok');
    writeFileSync(f, 'sk-SECRET-VALUE\n');
    const host = mockHost({ [`POST ${H}/credentials/bind`]: (c) => jsonResponse({ bound: true, scope: 'user', ...(c.body.value ? { credentialRef: 'sub:example:user' } : {}) }) });
    const probe = await run(['ai', 'bind-credential', '--provider', 'example', '--scope', 'user'], host);
    assert.deepEqual(host.calls[0].body, { provider: 'example', mode: 'subscription', scope: 'user' });
    assert.match(probe.stdout, /Scope check passed/);
    const bound = await run(['ai', 'bind-credential', '--provider', 'example', '--scope', 'user', '--value-file', f, '--acknowledge-risk'], host);
    assert.equal(bound.code, 0, bound.stderr);
    assert.deepEqual(host.calls[1].body, { provider: 'example', mode: 'subscription', scope: 'user', value: 'sk-SECRET-VALUE', acknowledgedRisk: true });
    assert.doesNotMatch(bound.stdout + bound.stderr, /sk-SECRET-VALUE/);
    assert.match(bound.stdout, /sub:example:user/);
    const j = await run(['--json', 'ai', 'bind-credential', '--provider', 'example', '--scope', 'user', '--value-file', f, '--acknowledge-risk'], host);
    assert.doesNotMatch(j.stdout, /sk-SECRET-VALUE/);
  });

  it('tenant scope is refused by the server → 403 → exit 4', async () => {
    const host = mockHost({ [`POST ${H}/credentials/bind`]: () => jsonResponse({ error: 'credential_scope_forbidden', message: 'Subscription credentials bind at user scope only.' }, 403) });
    const r = await run(['ai', 'bind-credential', '--provider', 'example', '--scope', 'tenant'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /credential_scope_forbidden/);
  });
});

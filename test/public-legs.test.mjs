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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so the mock sees the literal /v1/host/openwop-app paths (no discovery fetch).
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });

/** A fetch mock that records every call and answers from `reply(url, init)`. */
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    let body;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body, headers: init.headers ?? {}, redirect: init.redirect });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}
const lines = (r) => r.calls.map((c) => `${c.method} ${c.path}${c.search}`);
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const E = '/v1/host/openwop-app/public-email';
const html = (status = 200) => new Response('<html>page</html>', { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('email public legs', () => {
  it('open reports the pixel; click reports the redirect without following it', async () => {
    const cap = capture();
    const r = recorder((u) => (u.pathname.includes('/o/')
      ? new Response(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), { status: 200, headers: { 'content-type': 'image/gif' } })
      : new Response(null, { status: 302, headers: { location: 'https://example.com/landing' } })));
    assert.equal(await runCli(['email', 'public', 'open', 'tok/1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['email', 'public', 'click', 'tok_2'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(lines(r), [`GET ${E}/o/tok%2F1`, `GET ${E}/c/tok_2`]);
    assert.equal(r.calls[1].redirect, 'manual');
    assert.ok(r.calls.every((c) => !c.headers.authorization));
    assert.match(cap.stdout, /contentType: image\/gif/);
    assert.match(cap.stdout, /redirect: 302 -> https:\/\/example\.com\/landing/);
    const cap2 = capture();
    assert.equal(await runCli(['email', 'public', 'click', 'tok_2', '--json'], opts(r.fetchImpl, cap2)), 0);
    assert.deepEqual(JSON.parse(cap2.stdout), { status: 302, location: 'https://example.com/landing' });
  });

  it('unsubscribe: GET shows the page; --confirm needs --yes and POSTs urlencoded', async () => {
    const cap = capture();
    const r = recorder(() => html());
    assert.equal(await runCli(['email', 'public', 'unsubscribe', 'u1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.match(cap.stdout, /status: 200/);
    assert.doesNotMatch(cap.stdout, /<html>/);
    assert.equal(await runCli(['email', 'public', 'unsubscribe', 'u1', '--confirm'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 1);
    assert.equal(await runCli(['email', 'public', 'unsubscribe', 'u1', '--confirm', '--yes', '--html'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(lines(r), [`GET ${E}/u/u1`, `POST ${E}/u/u1`]);
    assert.equal(r.calls[1].headers['content-type'], 'application/x-www-form-urlencoded');
    assert.match(cap.stdout, /unsubscribed: true/);
    assert.match(cap.stdout, /<html>page<\/html>/);
  });

  it('preferences --set posts only the ON channels (requires --yes); a 409 refusal exits 2', async () => {
    const cap = capture();
    let status = 200;
    const r = recorder(() => html(status));
    assert.equal(await runCli(['email', 'public', 'preferences', 'p1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['email', 'public', 'preferences', 'p1', '--set', 'email=on,sms=off'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['email', 'public', 'preferences', 'p1', '--set', 'email=on,sms=off,push=on', '--yes'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    status = 409;
    assert.equal(await runCli(['email', 'public', 'preferences', 'p1', '--set', 'email=on', '--yes'], opts(r.fetchImpl, cap)), 2);
    assert.deepEqual(lines(r), [`GET ${E}/p/p1`, `POST ${E}/p/p1`, `POST ${E}/p/p1`]);
    assert.equal(r.calls[1].body, 'email=on&push=on');
    assert.equal(await runCli(['email', 'public', 'preferences', 'p1', '--set', 'fax=on', '--yes'], opts(r.fetchImpl, cap)), 2);
  });

  it('event replays the raw body verbatim with forwarded headers; a 401 is exit 4', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-evt-'));
    const file = join(dir, 'batch.json');
    const raw = '[ {"event":"bounce","email":"a@x.test"} ]';
    writeFileSync(file, raw);
    const cap = capture();
    let captured;
    const r = recorder((_u, init) => { captured = init.body; return json({ received: true, suppressed: 1, escalated: 0, failed: 0 }); });
    assert.equal(await runCli(['email', 'public', 'event', 'wh_1', '--body-file', file, '--header', 'X-Twilio-Email-Event-Webhook-Signature: sig=='], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(captured, raw);
    assert.equal(r.calls[0].path, `${E}/events/wh_1`);
    assert.equal(r.calls[0].headers['x-twilio-email-event-webhook-signature'], 'sig==');
    assert.equal(r.calls[0].headers['content-type'], 'application/json');
    assert.match(cap.stdout, /suppressed: 1/);
    const r401 = recorder(() => new Response('Signature verification failed.', { status: 401, headers: { 'content-type': 'text/plain' } }));
    const cap2 = capture();
    assert.equal(await runCli(['email', 'public', 'event', 'wh_1', '--body-file', file], opts(r401.fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /HTTP 401(?: \S+)?: Signature verification failed/);
    assert.equal(await runCli(['email', 'public', 'event', 'wh_1'], opts(r401.fetchImpl, cap2)), 2);
  });
});

describe('forms public legs', () => {
  it('get + submit hit /public-forms anonymously with the mirrored body', async () => {
    const cap = capture();
    const r = recorder((u) => json(u.pathname.endsWith('/submit') ? { ok: true, submissionId: 'sub_1', message: 'Thanks!' } : { formId: 'f_1', title: 'Contact', fields: [] }, u.pathname.endsWith('/submit') ? 201 : 200));
    assert.equal(await runCli(['forms', 'public', 'get', 'f_1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['forms', 'public', 'submit', 'f_1', '--values-json', '{"email":"a@x.test"}', '--referrer', 'https://site', '--session-key', 's1', '--utm-json', '{"source":"x"}', '--client-key', 'ck1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(lines(r), ['GET /v1/host/openwop-app/public-forms/f_1', 'POST /v1/host/openwop-app/public-forms/f_1/submit']);
    assert.deepEqual(r.calls[1].body, { values: { email: 'a@x.test' }, referrer: 'https://site', sessionKey: 's1', utm: { source: 'x' }, clientKey: 'ck1' });
    assert.ok(r.calls.every((c) => !c.headers.authorization));
    assert.match(cap.stdout, /Submitted \(submission sub_1\) — Thanks!/);
    const cap2 = capture();
    assert.equal(await runCli(['forms', 'public', 'get', 'f_1', '--json'], opts(r.fetchImpl, cap2)), 0);
    assert.equal(JSON.parse(cap2.stdout).formId, 'f_1');
  });

  it('submit without --values-json is a usage error; a 400 is exit 2', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'validation_error', message: 'email is required' }, 400));
    assert.equal(await runCli(['forms', 'public', 'submit', 'f_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['forms', 'public', 'submit', 'f_1', '--values-json', '{}'], opts(r.fetchImpl, cap)), 2);
    assert.match(cap.stderr, /HTTP 400(?: \S+)?: email is required/);
  });
});

describe('chat-widget public legs', () => {
  it('config + message send the token and the Origin header, no bearer', async () => {
    const cap = capture();
    const r = recorder((u) => json(u.pathname.endsWith('/message') ? { reply: 'Hi there' } : { widgetId: 'w_1', agentId: 'a_1', caps: {} }));
    assert.equal(await runCli(['chat-widget', 'public', 'config', '--token', 't/1', '--origin', 'https://site.test'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['chat-widget', 'public', 'message', '--token', 't1', '--origin', 'https://site.test', '--message', 'hello', '--session', 's1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(lines(r), ['GET /v1/host/openwop-app/public/widget/config?token=t%2F1', 'POST /v1/host/openwop-app/public/widget/message']);
    assert.deepEqual(r.calls[1].body, { token: 't1', message: 'hello', hp: '', sessionId: 's1' });
    assert.ok(r.calls.every((c) => c.headers.origin === 'https://site.test' && !c.headers.authorization));
    assert.match(cap.stdout, /Hi there/);
  });

  it('embed prints the script; a 403 (origin not allowed) is exit 4', async () => {
    const cap = capture();
    const r = recorder(() => new Response('(function(){})();', { status: 200, headers: { 'content-type': 'application/javascript' } }));
    assert.equal(await runCli(['chat-widget', 'public', 'embed'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/public/widget/embed.js');
    assert.match(cap.stdout, /\(function\(\)\{\}\)\(\);/);
    const r403 = recorder(() => json({ error: 'forbidden', message: 'This domain is not allowed to embed this widget.' }, 403));
    assert.equal(await runCli(['chat-widget', 'public', 'config', '--token', 't', '--origin', 'https://evil.test'], opts(r403.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /not allowed to embed/);
    assert.equal(await runCli(['chat-widget', 'public', 'message', '--token', 't', '--origin', 'https://site.test'], opts(r403.fetchImpl, cap)), 2);
  });
});

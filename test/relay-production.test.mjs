// openwop-app ADR 1043 (CHAN-P1) — the device relay to production grade.
// Run via `npm test` (builds dist/ first); imports the bundle at ../dist/cli.js.
//
// Contract tests against fixtures under test/fixtures/relay/: host-answers.json was
// RECORDED from the openwop-app host (see its _source); the platform payloads are in
// the shape Baileys, signal-cli and chat.db emit (no real account was linked; the
// scripted live check in docs/relay-live-check.md is how they get re-captured).
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCli,
  parseWhatsappMessage, parseSignalEnvelope, parseImessageRow, normalizeAccountId,
  computeBackoff, withRetries, InboundBatcher, EchoGuard, DeliveredSet,
  mediaKindOf, whatsappMediaContent, DeliveryError,
  RelayBridge, relayAuthMessage, assertRelayServerUrl, buildRelayServicePlan, riskNotice,
  getChannelPlugin, setWhatsappModuleForTests,
  assertSafeMediaUrl, isPublicAddress, setMediaOptionsForTests,
} from '../dist/cli.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/relay/${name}`, import.meta.url), 'utf8'));
const HOST = fx('host-answers.json');
const WA = fx('whatsapp-baileys.json');
const SIG = fx('signal-cli-jsonrpc.json');
const IMSG = fx('imessage-chatdb.json');

function capture() {
  const c = { stdout: '', stderr: '' };
  c.io = { stdout: { write: (s) => { c.stdout += s; } }, stderr: { write: (s) => { c.stderr += s; } } };
  return c;
}
const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * A mock host implementing the ADR 1043 D1 device contract, answering with the
 * RECORDED bodies. `script` overrides answers per route; every call is logged.
 */
function mockHost(script = {}) {
  const calls = [];
  const queue = [];
  let token = 'dtok_A';
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^.*\/messaging/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const tok = init.headers?.['x-openwop-device-token'];
    calls.push({ path, method: init.method ?? 'GET', body, tok, host: u.host });
    if (!u.pathname.includes('/messaging')) return json(404, { error: 'not_found' });
    if (script[path]) { const r = await script[path]({ body, tok, calls }); if (r) return r; }
    if (path.startsWith('/device/') && tok !== token) return json(401, HOST.authInvalid.body);
    switch (path) {
      case '/relay/register': return json(201, HOST.register.body);
      case '/relay/activate': return json(200, { ...HOST.activate.body, deviceToken: token });
      case '/device/heartbeat': return json(200, HOST.heartbeat.body);
      case '/device/rotate': token = 'dtok_B'; return json(200, { ...HOST.rotate.body, deviceToken: 'dtok_B' });
      case '/device/outbound': return json(200, { relayId: 'r', messages: queue.slice() });
      case '/device/ack': {
        const ids = new Set(body.egressIds ?? []);
        for (const f of body.failed ?? []) if (f.permanent) ids.add(f.egressId);
        for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].egressId)) queue.splice(i, 1);
        return json(200, { acked: (body.egressIds ?? []).length, failed: (body.failed ?? []).length, deadLettered: 0 });
      }
      case '/device/inbound': return json(202, HOST.inboundAccepted.body);
      default: return json(404, { error: 'not_found' });
    }
  };
  return { fetchImpl, calls, queue, setToken: (t) => { token = t; } };
}

function bridgeCtx(host, extra = {}) {
  const cap = capture();
  return { cap, ctx: { baseUrl: 'https://relay.example.test', apiKey: undefined, fetchImpl: host.fetchImpl, env: {}, io: cap.io, json: false, ...extra } };
}
const noSleep = async () => {};

describe('fixtures — platform payloads normalize per ADR 1043 D6', () => {
  it('WhatsApp (Baileys): DM, group mention, caption; from-me only in the note-to-self chat', () => {
    const out = WA.upsert.messages.map((m) => parseWhatsappMessage(m, { accountId: WA.ownAccount }));
    assert.equal(out[0].text, 'hi from Ada');
    assert.equal(out[0].fromMe, undefined);
    assert.deepEqual(out[1].mentions, [WA.ownAccount]);
    assert.equal(out[1].peerId, '15550003333@s.whatsapp.net');
    assert.equal(out[2].fromMe, true, 'note-to-self is forwarded, marked from-me');
    assert.equal(out[2].conversationId, WA.ownAccount);
    assert.equal(out[3], null, 'my own message to a contact never leaves the device');
    assert.equal(out[4].text, 'look at this');
    assert.equal(out[5], null, 'protocol messages are not inbound');
    // Without an account id, NO from-me message is forwarded.
    assert.equal(parseWhatsappMessage(WA.upsert.messages[2]), null);
  });

  it('Signal (signal-cli JSON-RPC): DM, group, note-to-self sync; others dropped', () => {
    const n = SIG.notifications;
    const o = { accountId: SIG.ownAccount };
    assert.equal(parseSignalEnvelope(n.dm, o).conversationId, '+15550002222');
    const g = parseSignalEnvelope(n.group, o);
    assert.match(g.conversationId, /^group:/);
    assert.equal(g.channelMeta.groupId, n.group.params.envelope.dataMessage.groupInfo.groupId);
    assert.ok(g.mentions.length > 0);
    const self = parseSignalEnvelope(n.noteToSelf, o);
    assert.equal(self.fromMe, true);
    assert.equal(self.conversationId, SIG.ownAccount);
    assert.equal(parseSignalEnvelope(n.sentToContact, o), null);
    assert.equal(parseSignalEnvelope(n.noteToSelf), null, 'no account id: no from-me');
    assert.equal(parseSignalEnvelope(n.receipt, o), null);
    assert.equal(parseSignalEnvelope(n.typing, o), null);
  });

  it('iMessage (chat.db rows): the note-to-self row once, the mirrored copy and outgoing dropped', () => {
    const o = { accountId: IMSG.ownAccount };
    const out = IMSG.rows.map((r) => parseImessageRow(r, o));
    assert.equal(out[0].text, 'hi from Ada');
    assert.equal(out[1].fromMe, true);
    assert.equal(out[1].conversationId, IMSG.ownAccount);
    assert.equal(out[2], null, 'mirrored received copy of a note-to-self');
    assert.equal(out[3], null, 'my own message to a contact');
    assert.equal(out[4], null, 'empty body');
  });

  it('normalizes the device account id to the form its chats use', () => {
    assert.equal(normalizeAccountId('whatsapp', '+1 (555) 000-1111'), '15550001111@s.whatsapp.net');
    assert.equal(normalizeAccountId('whatsapp', '15550001111@s.whatsapp.net'), '15550001111@s.whatsapp.net');
    assert.equal(normalizeAccountId('signal', '+1 555 000 1111'), '+15550001111');
    assert.equal(normalizeAccountId('signal', '5550001111'), undefined);
    assert.equal(normalizeAccountId('imessage', 'Me@iCloud.com'), 'me@icloud.com');
  });
});

describe('reliability primitives (ADR 1043 D5)', () => {
  it('backoff is full jitter under an exponential ceiling with a 5-minute cap', () => {
    assert.equal(computeBackoff(0, { random: () => 0.999 }), 999);
    assert.equal(computeBackoff(3, { random: () => 0.5 }), 4000);
    assert.equal(computeBackoff(40, { random: () => 0.999999 }), 299_999);
    assert.equal(computeBackoff(5, { random: () => 0 }), 0);
  });

  it('withRetries retries transient errors and stops on a permanent one', async () => {
    let n = 0;
    await assert.rejects(withRetries(async () => { n++; throw new DeliveryError('no such user', true); }, { attempts: 3, isTransient: (e) => !e.permanent, sleepFn: noSleep }));
    assert.equal(n, 1);
    n = 0;
    const v = await withRetries(async () => { if (++n < 3) throw new Error('blip'); return 'ok'; }, { attempts: 3, isTransient: () => true, sleepFn: noSleep });
    assert.equal(v, 'ok');
    assert.equal(n, 3);
  });

  it('batches a burst from one sender, flushes a non-batchable message in order', async () => {
    const sent = [];
    const timers = [];
    const b = new InboundBatcher(async (m) => { sent.push(m); }, { debounceMs: 1500, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, now: () => 0 });
    const m = (id, text, extra = {}) => ({ platformMessageId: id, conversationId: 'c1', peerId: 'p1', text, timestamp: 't', ...extra });
    await b.push(m('1', 'hello'));
    await b.push(m('2', 'are you there'));
    assert.equal(sent.length, 0);
    await b.push(m('3', '👍', { kind: 'reaction' }));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, 'hello\nare you there');
    assert.equal(sent[0].platformMessageId, '2', 'the merged message carries the LAST id');
    assert.deepEqual(sent[0].channelMeta.batchedIds, ['1', '2']);
    assert.equal(sent[1].kind, 'reaction');
    for (let i = 0; i < 10; i++) await b.push(m(`x${i}`, `m${i}`));
    assert.equal(sent.length, 3, 'max 10 per batch flushes without waiting');
  });

  it('the echo guard recognises the relay\'s own sends by id or by text in the chat', () => {
    let t = 0;
    const g = new EchoGuard(1000, () => t);
    g.recordSent('self', 'Here is your summary', ['WAID1']);
    assert.ok(g.isEcho({ platformMessageId: 'WAID1', conversationId: 'self', text: 'x' }));
    assert.ok(g.isEcho({ platformMessageId: 'other', conversationId: 'self', text: 'Here is your summary', fromMe: true }));
    assert.ok(!g.isEcho({ platformMessageId: 'other', conversationId: 'self', text: 'Here is your summary' }), 'a contact saying the same thing is not an echo');
    t = 2000;
    assert.ok(!g.isEcho({ platformMessageId: 'WAID1', conversationId: 'self', text: 'x' }), 'expires');
  });

  it('the delivered-id set persists 0600 across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owop-dlv-'));
    try {
      const p = join(dir, 'relay-delivered.json');
      new DeliveredSet(p).add('egr_1');
      assert.ok(new DeliveredSet(p).has('egr_1'));
      assert.equal(statSync(p).mode & 0o777, 0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the bridge against the recorded host contract (ADR 1043 D1)', () => {
  it('acks delivered, reports permanent and (after 3 tries) transient failures', async () => {
    const host = mockHost();
    host.queue.push({ egressId: 'e_ok', conversationId: 'c', text: 'ok' }, { egressId: 'e_perm', conversationId: 'c', text: 'perm' }, { egressId: 'e_flaky', conversationId: 'c', text: 'flaky' });
    const tries = {};
    const { ctx } = bridgeCtx(host);
    const bridge = new RelayBridge({
      ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, sleepFn: noSleep,
      deliver: async (e) => {
        tries[e.egressId] = (tries[e.egressId] ?? 0) + 1;
        if (e.egressId === 'e_perm') throw new DeliveryError('recipient not on Signal', true);
        if (e.egressId === 'e_flaky') throw new Error('socket closed');
      },
    });
    const n = await bridge.cycle();
    assert.deepEqual(n, { delivered: 1, failed: 2 });
    assert.deepEqual(tries, { e_ok: 1, e_perm: 1, e_flaky: 3 });
    const ack = host.calls.find((c) => c.path === '/device/ack');
    assert.deepEqual(ack.body.egressIds, ['e_ok']);
    assert.deepEqual(ack.body.failed.map((f) => [f.egressId, f.permanent === true]), [['e_perm', true], ['e_flaky', false]]);
  });

  it('a lost ack never re-sends: the next cycle acks from the delivered-id set', async () => {
    let failAck = true;
    const host = mockHost({ '/device/ack': () => (failAck ? json(503, { error: 'unavailable' }) : undefined) });
    host.queue.push({ egressId: 'e1', conversationId: 'c', text: 'once' });
    const dir = mkdtempSync(join(tmpdir(), 'owop-bridge-'));
    try {
      let sends = 0;
      const make = () => new RelayBridge({
        ctx: bridgeCtx(host).ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, sleepFn: noSleep,
        deliveredPath: join(dir, 'd.json'), deliver: async () => { sends++; },
      });
      await assert.rejects(make().cycle());
      failAck = false;
      await make().cycle(); // a restarted relay
      assert.equal(sends, 1);
      assert.equal(host.queue.length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rotates when the heartbeat says it is due, saving the new token before using it', async () => {
    const host = mockHost({ '/device/heartbeat': () => json(200, { ...HOST.heartbeat.body, rotateAfter: '2000-01-01T00:00:00.000Z' }) });
    const saved = [];
    const bridge = new RelayBridge({ ctx: bridgeCtx(host).ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: (c) => saved.push(c.deviceToken), sleepFn: noSleep, deliver: async () => {} });
    await bridge.cycle();
    assert.deepEqual(saved, ['dtok_B']);
    const outbound = host.calls.find((c) => c.path === '/device/outbound');
    assert.equal(outbound.tok, 'dtok_B');
  });

  for (const key of ['authExpired', 'authRevoked', 'authInvalid']) {
    it(`stops for good on the recorded ${key} refusal`, async () => {
      const host = mockHost({ '/device/heartbeat': () => json(401, HOST[key].body) });
      const { ctx, cap } = bridgeCtx(host);
      const bridge = new RelayBridge({ ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, sleepFn: noSleep, deliver: async () => {} });
      const r = await bridge.run();
      assert.deepEqual(r, { stopped: 'auth', reason: HOST[key].body.details.reason });
      assert.match(cap.stderr, new RegExp(relayAuthMessage(HOST[key].body.details.reason).slice(0, 30).replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')));
    });
  }

  it('backs off with jitter on server errors, then recovers', async () => {
    let n = 0;
    const host = mockHost({ '/device/heartbeat': () => (++n <= 2 ? json(503, { error: 'unavailable' }) : undefined) });
    const sleeps = [];
    const ctrl = new AbortController();
    const bridge = new RelayBridge({
      ctx: bridgeCtx(host).ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, deliver: async () => {},
      random: () => 0.5, sleepFn: async (ms) => { sleeps.push(ms); if (sleeps.length === 3) ctrl.abort(); },
    });
    const r = await bridge.run({ signal: ctrl.signal });
    assert.equal(r.stopped, 'aborted');
    assert.deepEqual(sleeps, [500, 1000, 5000], 'two backoffs (base 1 s, ×2, half jitter), then the poll interval');
  });

  it('honours the recorded 429 Retry-After on inbound, then shows typing', async () => {
    let n = 0;
    const host = mockHost({ '/device/inbound': () => (++n === 1 ? json(429, HOST.inboundRateLimited.body, { 'retry-after': HOST.inboundRateLimited.retryAfter }) : undefined) });
    const sleeps = [];
    const typing = [];
    const plugin = { channel: 'signal', isAvailable: () => ({ available: true }), deliver: async () => {}, startReceive: async () => () => {}, setTyping: async (c, on) => { typing.push([c, on]); } };
    const bridge = new RelayBridge({ ctx: bridgeCtx(host).ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, deliver: async () => {}, plugin, debounceMs: 0, sleepFn: async (ms) => { sleeps.push(ms); } });
    await bridge.onInbound({ platformMessageId: 'p', conversationId: '+1555', peerId: '+1555', text: 'hi', timestamp: 't' });
    assert.deepEqual(sleeps, [60_000]);
    assert.deepEqual(typing, [['+1555', true]]);
    // The reply's delivery clears it.
    host.queue.push({ egressId: 'e', conversationId: '+1555', text: 'answer' });
    await bridge.outboundCycle();
    assert.deepEqual(typing, [['+1555', true], ['+1555', false]]);
  });

  it('an inbound refused for the token stops the loop', async () => {
    const host = mockHost({ '/device/inbound': () => json(401, HOST.authRevoked.body) });
    const bridge = new RelayBridge({ ctx: bridgeCtx(host).ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, deliver: async () => {}, debounceMs: 0, sleepFn: noSleep });
    await bridge.onInbound({ platformMessageId: 'p', conversationId: 'c', peerId: 'c', text: 'hi', timestamp: 't' });
    assert.deepEqual(await bridge.run(), { stopped: 'auth', reason: 'device_revoked' });
  });

  it('the watchdog restarts receive after 30 minutes of silence', async () => {
    let t = 0;
    const host = mockHost();
    const ctrl = new AbortController();
    let restarts = 0;
    const bridge = new RelayBridge({ ctx: bridgeCtx(host).ctx, creds: { relayId: 'r', channel: 'signal', deviceToken: 'dtok_A' }, saveCreds: () => {}, deliver: async () => {}, now: () => t, sleepFn: async () => { t += 10 * 60 * 1000; if (t > 60 * 60 * 1000) ctrl.abort(); } });
    await bridge.run({ signal: ctrl.signal, restartReceive: async () => { restarts++; } });
    assert.equal(restarts, 1, 'restarted once the silence passed 30 min (and the restart resets the clock)');
  });
});

describe('setup: consent, account id and the pinned server (ADR 1043 D6/D7)', { timeout: 10_000 }, () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'owop-relay-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  const creds = () => JSON.parse(readFileSync(join(home, '.openwop', 'relay-credentials.json'), 'utf8'));
  const run = (argv, host, seams = {}, cap = capture()) =>
    runCli(['--base-url', 'https://relay.example.test', ...argv], { io: cap.io, fetchImpl: host.fetchImpl, env: { OPENWOP_CONFIG_HOME: home }, cwd: home, repoRoot: home, relaySeams: seams }).then((code) => ({ code, cap }));

  it('without a terminal and without --accept-risk, nothing is registered', async () => {
    const host = mockHost();
    const { code, cap } = await run(['relay', 'setup', '--channel', 'whatsapp'], host, { isTTY: false, prompt: async () => { throw new Error('must not prompt without a terminal'); } });
    assert.equal(code, 2);
    assert.match(cap.stderr, /WhatsApp can BAN the number/);
    assert.equal(host.calls.filter((c) => c.path.startsWith('/relay')).length, 0);
  });

  it('a terminal answer other than "yes" cancels before any call', async () => {
    const host = mockHost();
    const { code } = await run(['relay', 'setup', '--channel', 'imessage'], host, { isTTY: true, prompt: async () => 'sure' });
    assert.equal(code, 1);
    assert.equal(host.calls.filter((c) => c.path.startsWith('/relay')).length, 0);
  });

  it('"yes" registers with the normalized account id, and stores consent + the pinned server', async () => {
    const host = mockHost();
    const answers = ['yes', '+1 555 000 1111'];
    const { code, cap } = await run(['relay', 'setup', '--channel', 'whatsapp'], host, { isTTY: true, prompt: async () => answers.shift() });
    assert.equal(code, 0, cap.stderr);
    const reg = host.calls.find((c) => c.path === '/relay/register');
    assert.equal(reg.body.accountId, '15550001111@s.whatsapp.net');
    assert.equal(host.calls.find((c) => c.path === '/relay/activate').body.accountId, '15550001111@s.whatsapp.net');
    const c = creds();
    assert.equal(c.baseUrl, 'https://relay.example.test');
    assert.equal(c.accountId, '15550001111@s.whatsapp.net');
    assert.ok(c.riskAcceptedAt);
    assert.equal(c.riskNoticeVersion, 1);
    assert.ok(!cap.stdout.includes('dtok_'), 'the token is never printed');
  });

  it('Discord (a bot token, not a personal account) needs no consent', async () => {
    const { code } = await run(['relay', 'setup', '--channel', 'discord'], mockHost(), { isTTY: false });
    assert.equal(code, 0);
    assert.equal(riskNotice('discord').includes('BAN'), false);
  });

  it('refuses a server address with a query string, user info, or plain http off loopback', async () => {
    assert.throws(() => assertRelayServerUrl('https://evil.example/?gatewayUrl=x'), /query string/);
    assert.throws(() => assertRelayServerUrl('https://u:p@host.example'), /user name/);
    assert.throws(() => assertRelayServerUrl('http://host.example'), /https/);
    assert.equal(assertRelayServerUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
    const host = mockHost();
    const cap = capture();
    const code = await runCli(['--base-url', 'https://app.example/?token=steal', 'relay', 'setup', '--channel', 'discord'], { io: cap.io, fetchImpl: host.fetchImpl, env: { OPENWOP_CONFIG_HOME: home }, cwd: home, repoRoot: home });
    assert.equal(code, 2);
    assert.equal(host.calls.length, 0);
  });

  it('start talks only to the server the relay was set up with', async () => {
    const host = mockHost();
    await run(['relay', 'setup', '--channel', 'discord'], host, { isTTY: false });
    const cap = capture();
    const code = await runCli(['--base-url', 'https://other.example', 'relay', 'start', '--once'], { io: cap.io, fetchImpl: host.fetchImpl, env: { OPENWOP_CONFIG_HOME: home }, cwd: home, repoRoot: home, relayDeliver: async () => {} });
    assert.equal(code, 2);
    assert.match(cap.stderr, /refusing to send its token/);
    host.calls.length = 0;
    const cap2 = capture();
    // No explicit address: the pinned one is used even though the default differs.
    const ok = await runCli(['relay', 'start', '--once'], { io: cap2.io, fetchImpl: host.fetchImpl, env: { OPENWOP_CONFIG_HOME: home }, cwd: home, repoRoot: home, relayDeliver: async () => {} });
    assert.equal(ok, 0, cap2.stderr);
    assert.ok(host.calls.length > 0 && host.calls.every((c) => c.host === 'relay.example.test'));
  });
});

describe('user service installer (ADR 1043 D6)', () => {
  const base = { nodeBin: '/usr/local/bin/node', entry: '/opt/openwop/dist/openwop.js', baseUrl: 'https://relay.example.test', logPath: '/home/u/.openwop/relay.log' };

  it('launchd: restart only on failure, throttled, no secret in the file', () => {
    const p = buildRelayServicePlan({ ...base, platform: 'darwin', home: '/Users/u', uid: 501 });
    assert.equal(p.path, '/Users/u/Library/LaunchAgents/dev.openwop.relay.plist');
    assert.match(p.contents, /<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.match(p.contents, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    assert.match(p.contents, /<string>relay<\/string>\s*<string>start<\/string>/);
    assert.ok(!/dtok_|deviceToken/.test(p.contents));
    assert.deepEqual(p.install[1], ['launchctl', 'bootstrap', 'gui/501', p.path]);
  });

  it('systemd: Restart=on-failure, quoted ExecStart', () => {
    const p = buildRelayServicePlan({ ...base, platform: 'linux', home: '/home/u' });
    assert.equal(p.path, '/home/u/.config/systemd/user/openwop-relay.service');
    assert.match(p.contents, /^Restart=on-failure$/m);
    assert.match(p.contents, /^ExecStart="\/usr\/local\/bin\/node" "\/opt\/openwop\/dist\/openwop.js" "--base-url" "https:\/\/relay.example.test" "relay" "start"$/m);
    assert.equal(buildRelayServicePlan({ ...base, platform: 'win32' }), null);
  });

  it('install writes the unit and runs the manager; uninstall removes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owop-svc-'));
    try {
      const host = mockHost();
      const env = { OPENWOP_CONFIG_HOME: home, HOME: home };
      await runCli(['--base-url', 'https://relay.example.test', 'relay', 'setup', '--channel', 'discord'], { io: capture().io, fetchImpl: host.fetchImpl, env, cwd: home, repoRoot: home });
      const ran = [];
      const seams = { platform: 'linux', home, runCommand: (a) => { ran.push(a.join(' ')); return { status: 0 }; } };
      const cap = capture();
      const code = await runCli(['relay', 'service', 'install'], { io: cap.io, fetchImpl: host.fetchImpl, env, cwd: home, repoRoot: home, relaySeams: seams });
      assert.equal(code, 0, cap.stderr);
      const unit = join(home, '.config/systemd/user/openwop-relay.service');
      assert.ok(existsSync(unit));
      assert.ok(readFileSync(unit, 'utf8').includes('"https://relay.example.test"'));
      assert.deepEqual(ran, ['systemctl --user daemon-reload', 'systemctl --user enable --now openwop-relay.service']);
      await runCli(['relay', 'service', 'uninstall'], { io: capture().io, fetchImpl: host.fetchImpl, env, cwd: home, repoRoot: home, relaySeams: seams });
      assert.ok(!existsSync(unit));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('WhatsApp through a Baileys stand-in fed the fixtures (ADR 1043 D5)', () => {
  /** A fake Baileys module: each makeWASocket is a socket whose events the test drives. */
  function fakeBaileys() {
    const sockets = [];
    const mod = {
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
      makeWASocket: () => {
        const handlers = {};
        const sent = [];
        const sock = {
          sent,
          ev: {
            on: (ev, fn) => { (handlers[ev] ??= []).push(fn); if (ev === 'connection.update') queueMicrotask(() => fn(WA.connectionUpdates.open)); },
            off: (ev, fn) => { handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn); },
            emit: (ev, payload) => { for (const fn of handlers[ev] ?? []) fn(payload); },
          },
          sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: `SENT${sent.length}` } }; },
          sendPresenceUpdate: async (state, jid) => { sent.push({ presence: state, jid }); },
          end: () => {},
        };
        sockets.push(sock);
        return sock;
      },
    };
    return { mod, sockets };
  }

  it('sends every attachment by type with the caption on the first, and shows typing', async () => {
    const { mod, sockets } = fakeBaileys();
    setWhatsappModuleForTests(mod);
    // Public resolution and a stub getter: WhatsApp now downloads, then sends BYTES.
    const fetched = [];
    setMediaOptionsForTests({ resolver: async () => ['93.184.216.34'], get: async (u) => { fetched.push(u.href); return Buffer.from(`bytes:${u.pathname}`); } });
    try {
      const wa = getChannelPlugin('whatsapp');
      const r = await wa.deliver({ conversationId: '15550002222@s.whatsapp.net', text: 'files', media: [
        { url: 'https://h.example/a.png', mimeType: 'image/png' },
        { url: 'https://h.example/b.pdf', mimeType: 'application/pdf', filename: 'b.pdf' },
        { url: 'https://h.example/c.mp4', mimeType: 'video/mp4' },
      ] });
      const sent = sockets[0].sent.map((s) => s.content);
      assert.equal(sent.length, 3);
      assert.deepEqual(Object.keys(sent[0]).sort(), ['caption', 'image']);
      assert.equal(sent[0].caption, 'files');
      assert.equal(sent[1].document.toString(), 'bytes:/b.pdf', 'Baileys gets bytes, never the URL');
      assert.equal(sent[1].fileName, 'b.pdf');
      assert.equal(fetched.length, 3);
      assert.equal(sent[1].caption, undefined);
      assert.ok(sent[2].video);
      assert.deepEqual(r.platformMessageIds, ['SENT1', 'SENT2', 'SENT3']);
      await wa.setTyping('15550002222@s.whatsapp.net', true);
      assert.equal(sockets[0].sent.at(-1).presence, 'composing');
    } finally { setWhatsappModuleForTests(undefined); setMediaOptionsForTests(undefined); }
  });

  it('H1 — refuses a loopback or private media URL before sending anything', async () => {
    const { mod, sockets } = fakeBaileys();
    setWhatsappModuleForTests(mod);
    let fetched = 0;
    setMediaOptionsForTests({ resolver: async () => ['10.0.0.5'], get: async () => { fetched++; return Buffer.from('x'); } });
    try {
      const wa = getChannelPlugin('whatsapp');
      for (const url of ['http://localhost:8080/secret', 'https://127.0.0.1/x', 'https://intranet.example/x']) {
        await assert.rejects(wa.deliver({ conversationId: '15550002222@s.whatsapp.net', text: 'x', media: [{ url, mimeType: 'image/png' }] }),
          (e) => e instanceof DeliveryError && e.permanent === true, url);
      }
      assert.equal(fetched, 0, 'nothing fetched');
      assert.equal((sockets[0]?.sent ?? []).filter((m) => m.content).length, 0, 'nothing sent');
    } finally { setWhatsappModuleForTests(undefined); setMediaOptionsForTests(undefined); }
  });

  it('reconnects after a close and keeps receiving; a logout is fatal', async () => {
    const { mod, sockets } = fakeBaileys();
    setWhatsappModuleForTests(mod);
    try {
      const got = [];
      const fatal = [];
      const stop = await getChannelPlugin('whatsapp').startReceive(async (m) => { got.push(m); }, { env: { HOME: '/tmp' }, accountId: WA.ownAccount, sleepFn: noSleep, onFatal: (e) => fatal.push(e.message) });
      sockets[0].ev.emit('messages.upsert', WA.upsert);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(got.length, 4, 'DM, group, note-to-self, caption');
      sockets[0].ev.emit('connection.update', WA.connectionUpdates.closedConnectionLost);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sockets.length, 2, 'a new socket after the close');
      sockets[1].ev.emit('messages.upsert', { type: 'notify', messages: [WA.upsert.messages[0]] });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(got.length, 5);
      sockets[1].ev.emit('connection.update', WA.connectionUpdates.closedLoggedOut);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fatal.length, 1);
      assert.match(fatal[0], /logged this device out/);
      assert.equal(sockets.length, 2, 'no reconnect after a logout');
      stop();
    } finally { setWhatsappModuleForTests(undefined); }
  });

  it('media kinds and Baileys content', () => {
    assert.equal(mediaKindOf({ url: 'https://h/x.ogg' }), 'audio');
    assert.equal(mediaKindOf({ url: 'https://h/x', mimeType: 'text/csv' }), 'document');
    const data = Buffer.from('a');
    assert.deepEqual(whatsappMediaContent({ url: 'https://h/a.mp3', mimeType: 'audio/mpeg' }, data, 'ignored'), { audio: data, mimetype: 'audio/mpeg' });
  });
});

describe('relay devices (ADR 1043 D3, CHAN-P0-8 shape)', () => {
  it('shows presence, the owner and whether you can revoke; tolerates a host without presence', async () => {
    const host = mockHost({ '/relay/devices': () => json(200, { devices: [
      { relayId: 'r1', channel: 'signal', status: 'active', registeredAt: 't', online: true, presence: 'online', owner: { userId: 'me', ownedByCaller: true }, canRevoke: true },
      { relayId: 'r2', channel: 'whatsapp', status: 'active', registeredAt: 't', online: false, owner: { userId: 'x', ownedByCaller: false }, canRevoke: false },
      { relayId: 'r3', channel: 'imessage', status: 'active', registeredAt: 't', online: true, owner: null },
    ] }) });
    const home = mkdtempSync(join(tmpdir(), 'owop-dev-'));
    try {
      const cap = capture();
      const code = await runCli(['--base-url', 'https://relay.example.test', 'relay', 'devices'], { io: cap.io, fetchImpl: host.fetchImpl, env: { OPENWOP_CONFIG_HOME: home }, cwd: home, repoRoot: home });
      assert.equal(code, 0, cap.stderr);
      const lines = cap.stdout.trim().split('\n');
      assert.match(lines[0], /^r1 .*online {2}yours.*\(you can revoke\)$/);
      assert.match(lines[1], /^r2 .*offline {2}another member's/);
      assert.ok(!lines[1].includes('you can revoke'));
      assert.match(lines[2], /^r3 .*online {2}no owner/, 'no presence field: falls back to online');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('H1 — media URLs: public https only, checked after DNS', () => {
  it('classifies addresses', () => {
    const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
      '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', 'fd00:ec2::254',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', 'ff02::1', '2001:db8::1'];
    for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34']) assert.equal(isPublicAddress(ip), true, ip);
  });

  it('refuses non-https, user info, private literals, local names and names that RESOLVE private', async () => {
    const pub = async () => ['93.184.216.34'];
    const refused = async (url, resolver = pub) => assert.rejects(assertSafeMediaUrl(url, resolver), (e) => e instanceof DeliveryError && e.permanent === true, url);
    await refused('http://cdn.example.com/a.png');
    await refused('https://u:p@cdn.example.com/a.png');
    await refused('https://127.0.0.1/a.png');
    await refused('https://[::1]/a.png');
    await refused('https://169.254.169.254/latest/meta-data');
    await refused('https://[fd00::1]/a');
    await refused('https://localhost/a');
    await refused('https://metadata.google.internal/a');
    await refused('https://intranet/a');
    await refused('https://rebind.example.com/a', async () => ['93.184.216.34', '192.168.0.10']);
    assert.equal((await assertSafeMediaUrl('https://cdn.example.com/a.png', pub)).hostname, 'cdn.example.com');
  });
});

describe('L4 — credentials are created 0600 in a 0700 directory', () => {
  it('modes after setup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owop-modes-'));
    try {
      const code = await runCli(['--base-url', 'https://relay.example.test', 'relay', 'setup', '--channel', 'discord'], { io: capture().io, fetchImpl: mockHost().fetchImpl, env: { OPENWOP_CONFIG_HOME: home }, cwd: home, repoRoot: home });
      assert.equal(code, 0);
      assert.equal(statSync(join(home, '.openwop')).mode & 0o777, 0o700);
      assert.equal(statSync(join(home, '.openwop', 'relay-credentials.json')).mode & 0o777, 0o600);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('a lost rotation answer (security review)', () => {
  it('a superseded token stops the relay with a NON-zero exit and says to run setup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'owop-sup-'));
    try {
      const host = mockHost({
        '/device/heartbeat': () => json(200, { ...HOST.heartbeat.body, rotateAfter: '2000-01-01T00:00:00.000Z' }),
        '/device/rotate': () => json(401, { error: 'unauthenticated', message: 'replaced', details: { reason: 'device_token_superseded' } }),
      });
      const env = { OPENWOP_CONFIG_HOME: home };
      await runCli(['--base-url', 'https://relay.example.test', 'relay', 'setup', '--channel', 'discord'], { io: capture().io, fetchImpl: host.fetchImpl, env, cwd: home, repoRoot: home });
      const cap = capture();
      const code = await runCli(['relay', 'start', '--no-receive'], { io: cap.io, fetchImpl: host.fetchImpl, env, cwd: home, repoRoot: home, relayDeliver: async () => {}, relaySeams: { sleep: async () => {} } });
      assert.equal(code, 1);
      assert.match(cap.stderr, /never saved the new one/);
      assert.match(cap.stderr, /relay setup/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// Stream origin (openwop-app ADR 0761) + idle watchdog. Helpers copied from sse-resume.test.mjs.
// SSE resume + stream mode (spec/v2/core/events.md §The events channel —
// §Stream modes, §SSE frames, §Resuming with `Last-Event-ID`; v1
// spec/v1/stream-modes.md §Mode selection / §Resumption and
// rest-endpoints.md §Server-Sent Events).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli, streamRunEvents, streamBaseFrom, explicitStreamBase } from '../dist/cli.js';

const enc = new TextEncoder();

/** A stream that emits `chunks` then either closes or ERRORS (a dropped socket). */
function sseBody(chunks, { drop = false } = {}) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else if (drop) controller.error(new TypeError('terminated: other side closed'));
      else controller.close();
    },
  });
}

const sse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const frame = (seq, type, extra = '') => `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ sequence: seq, type, ...(extra ? { payload: { output: extra } } : {}) })}\n\n`;

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

/**
 * A host whose events stream is scripted per connection: `connections[i]` is
 * the i-th SSE response factory. Run status reads answer `status`. Records
 * every request (path, search, headers). Discovery answers `major`.
 */
function host({ connections, status = () => 'running', major = '2', extensions }) {
  const seen = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = init.headers ?? {};
    seen.push({ origin: u.origin, path: u.pathname, search: u.search, headers });
    if (u.pathname.endsWith('/.well-known/openwop')) return json({ protocolVersions: major === '2' ? ['1.1', '2.0'] : ['1.1'], ...(extensions ? { extensions } : {}) });
    if (/\/events$/.test(u.pathname)) {
      const make = connections[n++];
      if (!make) throw new Error(`unexpected connection #${n}`);
      return make(headers, u);
    }
    if (/\/events\/poll$/.test(u.pathname)) return json({ events: [], isTerminal: true, isComplete: true });
    if (/\/runs\/[^/]+$/.test(u.pathname)) return json({ runId: 'r', status: status() });
    throw new Error(`unexpected ${u.pathname}`);
  };
  return { seen, fetchImpl, get connections() { return n; } };
}


/** A body that emits `chunks` then STALLS (never closes, never errors) — a half-open socket. */
function stallingBody(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) { controller.enqueue(enc.encode(chunks[i++])); return; }
      return new Promise(() => {}); // hang forever
    },
  });
}

const ctxFor = (h, over = {}) => ({ baseUrl: 'https://front.example/api', apiKey: 'k', fetchImpl: h.fetchImpl, env: {}, io: capture().io, json: false, cwd: '/tmp', ...over });
const streams = (h) => h.seen.filter((r) => /\/events$/.test(r.path));
const nonStreams = (h) => h.seen.filter((r) => !/\/events$/.test(r.path) && r.path !== '/.well-known/openwop' && r.path !== '/api/.well-known/openwop');
const oneShot = () => sse(sseBody([frame(0, 'run.started'), frame(1, 'run.completed')]));

describe('stream origin (openwop-app ADR 0761) — only event streams move; everything else stays on --base-url', () => {
  it('an explicit streamBaseUrl carries the stream (with the bearer); status reads stay on the base', async () => {
    const h = host({ connections: [oneShot], status: () => 'completed' });
    await streamRunEvents(ctxFor(h, { streamBaseUrl: 'https://stream.example' }), 'r', {});
    const s = streams(h);
    assert.equal(s.length, 1);
    assert.equal(s[0].origin, 'https://stream.example');
    assert.equal(s[0].headers.authorization, 'Bearer k');
    assert.ok(nonStreams(h).every((r) => r.origin === 'https://front.example'), JSON.stringify(nonStreams(h)));
  });

  it('a host-advertised https streamBase is used when the user set none', async () => {
    const h = host({ connections: [oneShot], extensions: { 'openwop-app.host': { root: '/host/openwop-app/', streamBase: 'https://svc.run.app/' } } });
    await streamRunEvents(ctxFor(h), 'r', {});
    assert.equal(streams(h)[0].origin, 'https://svc.run.app');
  });

  it('the user setting wins over the advertisement', async () => {
    const h = host({ connections: [oneShot], extensions: { 'x.y': { streamBase: 'https://svc.run.app' } } });
    await streamRunEvents(ctxFor(h, { streamBaseUrl: 'https://mine.example' }), 'r', {});
    assert.equal(streams(h)[0].origin, 'https://mine.example');
  });

  for (const [bad, why] of [['http://svc.run.app', 'scheme downgrade'], ['https://u:p@svc.run.app', 'credentials'], ['https://svc.run.app/?q=1', 'query'], ['not a url', 'garbage']]) {
    it(`an advertised streamBase with ${why} is ignored — the stream stays on the base`, async () => {
      const h = host({ connections: [oneShot], extensions: { 'openwop-app.host': { streamBase: bad } } });
      await streamRunEvents(ctxFor(h), 'r', {});
      assert.equal(streams(h)[0].origin, 'https://front.example');
    });
  }

  it('streamBaseFrom: loopback http is accepted only for a loopback base', () => {
    const ext = { a: { streamBase: 'http://127.0.0.1:9000' } };
    assert.equal(streamBaseFrom(ext, 'http://localhost:8080'), 'http://127.0.0.1:9000');
    assert.equal(streamBaseFrom(ext, 'https://front.example'), undefined);
    assert.equal(streamBaseFrom({ a: { streamBase: 'https://s.example' } }, 'http://front.example'), undefined, 'https advertised by a plaintext host is not trusted');
  });

  it('explicitStreamBase: any parseable URL (the user chose it); garbage is a usage error', () => {
    assert.equal(explicitStreamBase('http://anything.example/'), 'http://anything.example');
    assert.equal(explicitStreamBase(undefined), undefined);
    assert.throws(() => explicitStreamBase('nope'), /not a URL/);
  });

  it('--stream-base-url (global) routes `runs watch`; OPENWOP_STREAM_BASE_URL too', async () => {
    for (const [argv, env] of [[['--stream-base-url', 'https://flag.example'], {}], [[], { OPENWOP_STREAM_BASE_URL: 'https://env.example' }]]) {
      const h = host({ connections: [oneShot], status: () => 'completed' });
      const cap = capture();
      const code = await runCli(['--base-url', 'https://front.example/api', '--api-key', 'k', ...argv, 'runs', 'watch', 'r1'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_PROTOCOL_MAJOR: '2', ...env } });
      assert.equal(code, 0, cap.stderr);
      assert.equal(streams(h)[0].origin, argv.length ? 'https://flag.example' : 'https://env.example');
    }
  });
});

describe('idle watchdog — a half-open stream is resumed, not waited on forever', () => {
  it('no bytes for idleTimeoutMs → abort + reconnect with Last-Event-ID; no duplicates', async () => {
    const h = host({
      connections: [
        () => sse(stallingBody(['retry: 1\n\n', frame(0, 'run.started'), frame(1, 'node.started')])),
        (headers) => { assert.equal(headers['last-event-id'], '1'); return sse(sseBody([frame(1, 'node.started'), frame(2, 'run.completed')])); },
      ],
    });
    const events = [];
    const t0 = Date.now();
    await streamRunEvents(ctxFor(h), 'r', { idleTimeoutMs: 150, onEvent: (e) => events.push(e.sequence) });
    assert.deepEqual(events, [0, 1, 2]);
    assert.equal(h.connections, 2);
    assert.ok(Date.now() - t0 < 5000, 'resumed promptly');
  });

  it('keep-alive comments count as activity — a quiet but healthy stream is NOT aborted', async () => {
    // Bytes every ~50ms (comments only), idle timeout 150ms, then the terminal event.
    let i = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 50));
        if (i === 0) controller.enqueue(enc.encode(frame(0, 'run.started')));
        else if (i < 6) controller.enqueue(enc.encode(': keep-alive\n\n'));
        else { controller.enqueue(enc.encode(frame(1, 'run.completed'))); controller.close(); }
        i++;
      },
    });
    const h = host({ connections: [() => sse(body)] });
    const events = [];
    await streamRunEvents(ctxFor(h), 'r', { idleTimeoutMs: 150, onEvent: (e) => events.push(e.sequence) });
    assert.deepEqual(events, [0, 1]);
    assert.equal(h.connections, 1, 'never reconnected');
  });
});

describe('idle watchdog — failure paths never hold the process open', () => {
  it('a front door that never sends headers is abandoned after idleTimeoutMs and the poll fallback runs', async () => {
    const h = host({ connections: [() => new Promise(() => {})] });
    // The fetch stub ignores the abort signal; emulate a real fetch that honours it.
    const realish = async (url, init = {}) => {
      if (/\/events$/.test(new URL(String(url)).pathname)) {
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
      }
      return h.fetchImpl(url, init);
    };
    const t0 = Date.now();
    await streamRunEvents({ ...ctxFor(h), fetchImpl: realish }, 'r', { idleTimeoutMs: 150, timeoutMs: 2000 });
    assert.ok(Date.now() - t0 < 1500, 'did not wait for the stream');
    assert.ok(h.seen.some((r) => /\/events\/poll$/.test(r.path)), 'fell back to the poll endpoint');
  });
});

describe('the stream origin is never silent (1.2.0 release review)', () => {
  const doctorRow = async (extraArgv, env, extensions) => {
    const h = host({ connections: [], extensions });
    const cap = capture();
    await runCli(['--base-url', 'https://front.example/api', '--api-key', 'k', ...extraArgv, 'doctor'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', repoRoot: null, env: { OPENWOP_PROTOCOL_MAJOR: undefined, ...env } });
    return cap.stdout.split('\n').find((l) => l.includes('stream origin')) ?? '';
  };
  it('doctor names --base-url when nothing moves the stream', async () => {
    assert.match(await doctorRow([], {}), /event streams use --base-url \(https:\/\/front\.example\/api\)/);
  });
  it("doctor names the host's advertised origin and the opt-out", async () => {
    const row = await doctorRow([], {}, { 'openwop-app.host': { streamBase: 'https://svc.run.app' } });
    assert.match(row, /https:\/\/svc\.run\.app — the host's advertised streamBase; set --stream-base-url to your --base-url/);
  });
  it('doctor names the user setting', async () => {
    assert.match(await doctorRow(['--stream-base-url', 'https://mine.example'], {}), /https:\/\/mine\.example — your --stream-base-url/);
  });
  it('--verbose says where the stream is read from when it is not --base-url', async () => {
    const h = host({ connections: [oneShot], extensions: { 'openwop-app.host': { streamBase: 'https://svc.run.app' } } });
    const cap = capture();
    await streamRunEvents({ ...ctxFor(h), verbose: true, io: cap.io }, 'r', {});
    assert.match(cap.stderr, /reading the event stream from https:\/\/svc\.run\.app \(the host's advertised streamBase\)/);
    const h2 = host({ connections: [oneShot] });
    const cap2 = capture();
    await streamRunEvents({ ...ctxFor(h2), verbose: true, io: cap2.io }, 'r', {});
    assert.doesNotMatch(cap2.stderr, /reading the event stream/);
  });
});

describe('stream UX — a silent front door is explained, not waited on (grade-ux)', () => {
  const buffering = (h) => async (url, init = {}) => {
    if (/\/events$/.test(new URL(String(url)).pathname)) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
    }
    return h.fetchImpl(url, init);
  };
  it('headers that never arrive are given up on at the HEADERS timeout (not the idle one), with a hint naming --stream-base-url', async () => {
    const h = host({ connections: [] });
    const cap = capture();
    const t0 = Date.now();
    await streamRunEvents({ ...ctxFor(h), io: cap.io, fetchImpl: buffering(h) }, 'r', { idleTimeoutMs: 60000, headersTimeoutMs: 120, timeoutMs: 2000 });
    assert.ok(Date.now() - t0 < 1500, 'did not wait for the 60 s idle timeout');
    assert.match(cap.stderr, /sent nothing for 120 ms — the host's front door may be buffering streams\. Following by polling instead; for live events pass --stream-base-url/);
  });
  it('once headers arrive, only the IDLE timeout applies — a quiet healthy stream outlives the headers timeout', async () => {
    let first = true;
    const body = new ReadableStream({
      async pull(controller) {
        // First bytes 250 ms after the headers: past the 100 ms headers timeout, inside the 400 ms idle one.
        await new Promise((r) => setTimeout(r, first ? 250 : 10));
        if (first) { controller.enqueue(enc.encode(frame(0, 'run.started'))); first = false; }
        else { controller.enqueue(enc.encode(frame(1, 'run.completed'))); controller.close(); }
      },
    });
    const h = host({ connections: [() => sse(body)] });
    const events = [];
    await streamRunEvents(ctxFor(h), 'r', { idleTimeoutMs: 400, headersTimeoutMs: 100, onEvent: (e) => events.push(e.sequence) });
    assert.deepEqual(events, [0, 1]);
    assert.equal(h.connections, 1, 'not cut off at the headers timeout');
  });

  it('--quiet suppresses the hint', async () => {
    const h = host({ connections: [] });
    const cap = capture();
    await streamRunEvents({ ...ctxFor(h), io: cap.io, quiet: true, fetchImpl: buffering(h) }, 'r', { headersTimeoutMs: 50, timeoutMs: 2000 });
    assert.equal(cap.stderr, '');
  });
  it('--verbose says a reconnect was a STALL, with the silence', async () => {
    const h = host({
      connections: [
        () => sse(stallingBody(['retry: 1\n\n', frame(0, 'run.started')])),
        () => sse(sseBody([frame(1, 'run.completed')])),
      ],
    });
    const cap = capture();
    await streamRunEvents({ ...ctxFor(h), io: cap.io, verbose: true }, 'r', { idleTimeoutMs: 120 });
    assert.match(cap.stderr, /events stream stalled \(no bytes for 120ms\); reconnecting/);
  });
  it('giving up says how to continue', async () => {
    const h = host({ connections: Array.from({ length: 3 }, () => () => sse(sseBody(['retry: 1\n\n'], { drop: true }))) });
    await assert.rejects(
      () => streamRunEvents(ctxFor(h), 'r', { maxReconnects: 1 }),
      /dropped 2 times without progress.*--since <last sequence printed>.*--no-stream/s,
    );
  });
});

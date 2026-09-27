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

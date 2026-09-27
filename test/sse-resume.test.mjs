// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// SSE resume + stream mode (spec/v2/core/events.md §The events channel —
// §Stream modes, §SSE frames, §Resuming with `Last-Event-ID`; v1
// spec/v1/stream-modes.md §Mode selection / §Resumption and
// rest-endpoints.md §Server-Sent Events).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli, streamRunEvents, consumeSse, parseStreamStart } from '../dist/cli.js';

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
function host({ connections, status = () => 'running', major = '2' }) {
  const seen = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = init.headers ?? {};
    seen.push({ path: u.pathname, search: u.search, headers });
    if (u.pathname === '/.well-known/openwop') return json({ protocolVersions: major === '2' ? ['1.1', '2.0'] : ['1.1'] });
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

const ctxFor = (h, env = {}) => ({ baseUrl: 'http://h', apiKey: 'k', fetchImpl: h.fetchImpl, env, io: capture().io, json: false, cwd: '/tmp' });
const streams = (h) => h.seen.filter((r) => /\/events$/.test(r.path));

describe('SSE resume with Last-Event-ID (events.md §Resuming; v1 stream-modes.md §Resumption)', () => {
  for (const major of ['1', '2']) {
    it(`reconnects after a mid-stream drop with the last id seen, without duplicates (major ${major})`, async () => {
      const h = host({
        connections: [
          // retry: 1 — the server-set reconnection delay (keeps the test fast).
          () => sse(sseBody(['retry: 1\n\n', frame(0, 'run.started'), frame(1, 'node.started'), frame(2, 'node.completed', 'hi')], { drop: true })),
          // A host that (wrongly) re-emits the resumption point: the CLI still prints it once.
          () => sse(sseBody([frame(2, 'node.completed', 'hi'), frame(3, 'run.completed')])),
        ],
      });
      const events = [];
      await streamRunEvents(ctxFor(h, { OPENWOP_PROTOCOL_MAJOR: major }), 'r', { onEvent: (e) => events.push(e.sequence) });
      assert.deepEqual(events, [0, 1, 2, 3]);
      const s = streams(h);
      assert.equal(s.length, 2);
      assert.equal(s[0].headers['last-event-id'], undefined);
      assert.equal(s[1].headers['last-event-id'], '2');
      assert.equal(s[0].path, major === '2' ? '/runs/r/events' : '/v1/runs/r/events');
    });
  }

  it('resumes from the batch id and dedupes events inside a batch', async () => {
    const batch = (id, seqs) => `id: ${id}\nevent: batch\ndata: ${JSON.stringify(seqs.map((s) => ({ sequence: s, type: 'node.started' })))}\n\n`;
    const h = host({
      connections: [
        () => sse(sseBody(['retry: 1\n\n', batch(1, [0, 1])], { drop: true })),
        () => sse(sseBody([batch(3, [1, 2, 3]), frame(4, 'run.completed')])),
      ],
    });
    const events = [];
    await streamRunEvents(ctxFor(h, { OPENWOP_PROTOCOL_MAJOR: '2' }), 'r', { onEvent: (e) => events.push(e.sequence) });
    assert.deepEqual(events, [0, 1, 2, 3, 4]);
    assert.equal(streams(h)[1].headers['last-event-id'], '1');
  });

  it('a clean close before the terminal event reconnects while the run is live', async () => {
    const h = host({
      connections: [
        () => sse(sseBody(['retry: 1\n\n', frame(0, 'run.started')])),
        () => sse(sseBody([frame(1, 'run.completed')])),
      ],
    });
    const events = [];
    await streamRunEvents(ctxFor(h, { OPENWOP_PROTOCOL_MAJOR: '2' }), 'r', { onEvent: (e) => events.push(e.type) });
    assert.deepEqual(events, ['run.started', 'run.completed']);
    assert.equal(streams(h)[1].headers['last-event-id'], '0');
  });

  it('stops without reconnecting when the server closes after the run went terminal (no terminal frame in this mode)', async () => {
    const h = host({
      status: () => 'completed',
      connections: [() => sse(sseBody([`id: 5\nevent: ai.message.chunk\ndata: {"text":"hel"}\n\n`]))],
    });
    const events = [];
    await streamRunEvents(ctxFor(h, { OPENWOP_PROTOCOL_MAJOR: '2' }), 'r', { streamMode: 'messages', onEvent: (e) => events.push(e) });
    assert.equal(h.connections, 1);
    assert.deepEqual(events, [{ type: 'ai.message.chunk', sequence: 5, payload: { text: 'hel' } }]);
    assert.equal(streams(h)[0].search, '?streamMode=messages');
  });

  it('gives up after maxReconnects drops without progress (exit-1 CliError), backing off from retry:', async () => {
    const delays = [];
    const drop = () => sse(sseBody(['retry: 2\n\n'], { drop: true }));
    const h = host({ connections: [() => sse(sseBody(['retry: 2\n\n', frame(0, 'run.started')], { drop: true })), drop, drop, drop] });
    await assert.rejects(
      streamRunEvents(ctxFor(h, { OPENWOP_PROTOCOL_MAJOR: '2' }), 'r', { maxReconnects: 2, onEvent: () => {}, onReconnect: (i) => delays.push(i) }),
      (err) => err.code === 1 && /dropped 3 times without progress/.test(err.message),
    );
    assert.deepEqual(delays.map((d) => [d.attempt, d.delayMs, d.lastEventId]), [[1, 2, '0'], [2, 4, '0']]);
  });

  it('a resume refused with a 4xx is surfaced, not retried or polled', async () => {
    const h = host({
      connections: [
        () => sse(sseBody(['retry: 1\n\n', frame(0, 'run.started')], { drop: true })),
        () => json({ error: 'validation_error', message: 'bad Last-Event-ID' }, 400),
      ],
    });
    await assert.rejects(
      streamRunEvents(ctxFor(h, { OPENWOP_PROTOCOL_MAJOR: '2' }), 'r', { onEvent: () => {} }),
      (err) => err.status === 400 && /validation_error/.test(err.message),
    );
    assert.equal(h.seen.filter((r) => r.path.endsWith('/poll')).length, 0);
  });

  it('a keep-alive comment is not an event and an id-only block still moves the cursor', async () => {
    const frames = [];
    const controls = [];
    await consumeSse(sseBody([':keepalive\n\n', 'id: 9\n\n', 'retry: 250\n\n', frame(10, 'node.started')]), (f) => frames.push(f), (c) => controls.push(c));
    assert.equal(frames.length, 1);
    assert.deepEqual(controls, [{ id: '9' }, { retry: 250 }]);
  });
});

describe('streaming run commands: --since / --last-event-id / --stream-mode', () => {
  for (const major of ['1', '2']) {
    it(`runs events --follow --since 4 sends Last-Event-ID: 4 (no since query param) under major ${major}`, async () => {
      const cap = capture();
      const h = host({ major, connections: [() => sse(sseBody([frame(5, 'node.completed', 'ok'), frame(6, 'run.completed')]))] });
      const code = await runCli(['--base-url', 'http://h', 'runs', 'events', 'r', '--follow', '--since', '4', '--stream-mode', 'updates,messages'], {
        io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: major },
      });
      assert.equal(code, 0, cap.stderr);
      const [s] = streams(h);
      assert.equal(s.headers['last-event-id'], '4');
      assert.equal(s.search, '?streamMode=updates%2Cmessages');
      assert.equal(s.path, major === '2' ? '/runs/r/events' : '/v1/runs/r/events');
      if (major === '2') assert.equal(s.headers['openwop-version'], '2.0');
      assert.match(cap.stdout, /\[5\] assistant> ok/);
      assert.match(cap.stdout, /\[6\] · run completed/);
    });
  }

  it('runs watch is events --follow; --json prints one event per line; exit 1 on run.failed', async () => {
    const cap = capture();
    const h = host({ connections: [() => sse(sseBody([frame(0, 'run.started'), frame(1, 'run.failed')]))] });
    const code = await runCli(['--base-url', 'http://h', '--json', 'runs', 'watch', 'r'], {
      io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '2' },
    });
    assert.equal(code, 1);
    assert.deepEqual(cap.stdout.trim().split('\n').map((l) => JSON.parse(l).sequence), [0, 1]);
  });

  it('--last-event-id is sent verbatim under v1 (opaque id) and must be an integer under v2', async () => {
    const v1 = await parseStreamStart({ env: { OPENWOP_PROTOCOL_MAJOR: '1' } }, { lastEventId: 'evt-abc' });
    assert.deepEqual(v1, { lastEventId: 'evt-abc' });
    await assert.rejects(parseStreamStart({ env: { OPENWOP_PROTOCOL_MAJOR: '2' } }, { lastEventId: 'evt-abc' }), /non-negative integer under protocol v2/);
    assert.deepEqual(await parseStreamStart({ env: { OPENWOP_PROTOCOL_MAJOR: '2' } }, { lastEventId: '7' }), { lastEventId: '7' });
    await assert.rejects(parseStreamStart({ env: {} }, { since: '3', lastEventId: '3' }), /pass one/);
    await assert.rejects(parseStreamStart({ env: {} }, { since: '-1' }), /non-negative integer/);
  });

  it('--last-event-id seeds dedupe: a host replaying from the resumption point prints nothing twice', async () => {
    const cap = capture();
    const h = host({ major: '1', connections: [() => sse(sseBody([frame(7, 'node.started'), frame(8, 'run.completed')]))] });
    const code = await runCli(['--base-url', 'http://h', 'runs', 'watch', 'r', '--last-event-id', '7'], {
      io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' },
    });
    assert.equal(code, 0);
    assert.equal(streams(h)[0].headers['last-event-id'], '7');
    assert.doesNotMatch(cap.stdout, /\[7\]/);
    assert.match(cap.stdout, /\[8\]/);
  });

  it('--stream-mode is validated against the spec pattern before any request', async () => {
    for (const bad of ['values,updates', 'everything', 'updates,', '']) {
      const cap = capture();
      const h = host({ connections: [] });
      const code = await runCli(['--base-url', 'http://h', 'runs', 'watch', 'r', `--stream-mode=${bad}`], {
        io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '2' },
      });
      assert.equal(code, 2, `${bad}: ${cap.stderr}`);
      assert.equal(streams(h).length, 0);
    }
  });

  it('a host 400 unsupported_stream_mode is reported, not silently polled', async () => {
    const cap = capture();
    const h = host({ connections: [() => json({ error: 'unsupported_stream_mode', message: "Server does not implement streamMode='debug'", details: { supported: ['updates'] } }, 400)] });
    const code = await runCli(['--base-url', 'http://h', 'runs', 'watch', 'r', '--stream-mode', 'debug'], {
      io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '2' },
    });
    assert.notEqual(code, 0);
    assert.match(cap.stderr, /unsupported_stream_mode/);
    assert.equal(h.seen.filter((r) => r.path.endsWith('/poll')).length, 0);
  });

  it('--no-stream follows over the poll endpoint from the --since cursor (afterSequence under v2)', async () => {
    const cap = capture();
    const seen = [];
    const fetchImpl = async (url) => {
      const u = new URL(String(url));
      seen.push(u.pathname + u.search);
      return json({ events: [{ sequence: 4, type: 'run.completed' }], lastSequence: 4, status: 'completed', isTerminal: true });
    };
    const code = await runCli(['--base-url', 'http://h', 'runs', 'watch', 'r', '--since', '3', '--no-stream'], {
      io: cap.io, fetchImpl, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '2' },
    });
    assert.equal(code, 0);
    assert.deepEqual(seen, ['/runs/r/events/poll?afterSequence=3']);
  });

  it('--last-event-id without --follow is refused', async () => {
    const cap = capture();
    const code = await runCli(['--base-url', 'http://h', 'runs', 'events', 'r', '--stream-mode', 'updates'], {
      io: cap.io, fetchImpl: async () => { throw new Error('no request expected'); }, cwd: '/tmp', env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '2' },
    });
    assert.equal(code, 2);
  });
});

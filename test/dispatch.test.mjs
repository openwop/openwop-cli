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

function json(body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fake v1 host: `/.well-known/openwop` advertises protocol 1.x (so paths are
 * sent exactly as written); every other request is recorded and answered by
 * `handler(method, path, body, url)`.
 */
function fakeHost(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/openwop') return json({ protocolVersions: ['1.1'] });
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers ?? {} });
    return handler(method, u.pathname, body, u);
  };
  return { fetchImpl, calls };
}

async function run(argv, handler, env = {}) {
  const cap = capture();
  const { fetchImpl, calls } = fakeHost(handler);
  const code = await runCli(argv, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', ...env } });
  return { code, stdout: cap.stdout, stderr: cap.stderr, calls };
}

const forbidden = () => json({ error: 'forbidden', message: 'Missing required scope' }, 403);

describe('dispatch fanout (RFC 0118)', () => {
  it('POSTs nextWorkerIds + a parallel config built from flags', async () => {
    const r = await run(['dispatch', 'fanout', '--worker', 'a', '--worker', 'b', '--join', 'quorum', '--quorum', '1', '--max-concurrency', '2'],
      () => json({ joinOutcome: 'satisfied', children: [{ childRunId: 'c0', status: 'completed' }, { childRunId: 'c1', status: 'completed' }], mergeOrder: ['c0', 'c1'], completedCount: 2, failedCount: 0, cancelledCount: 0 }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/dispatch/fanout');
    assert.deepEqual(r.calls[0].body, { nextWorkerIds: ['a', 'b'], config: { fanOutPolicy: 'parallel', maxConcurrency: 2, joinPolicy: { mode: 'quorum', quorum: 1 } } });
    assert.match(r.stdout, /joinOutcome: satisfied/);
    assert.match(r.stdout, /mergeOrder: c0, c1/);
  });

  it('exits 1 when the join is not satisfied (--json)', async () => {
    const body = { joinOutcome: 'failed', children: [], mergeOrder: [] };
    const r = await run(['--json', 'dispatch', 'fanout', '--worker', 'a', '--worker', 'b'], () => json(body));
    assert.equal(r.code, 1);
    assert.deepEqual(JSON.parse(r.stdout), body);
  });

  it('needs two workers', async () => {
    const r = await run(['dispatch', 'fanout', '--worker', 'a'], () => json({}));
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it('a 403 exits 4', async () => {
    const r = await run(['dispatch', 'fanout', '--worker', 'a', '--worker', 'b'], forbidden);
    assert.equal(r.code, 4);
  });
});

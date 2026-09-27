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

const DOC = { openapi: '3.1.0', info: { title: 'OpenWOP', version: '1.2.3' }, paths: {
  '/v1/runs': { get: { operationId: 'listRuns' }, post: { operationId: 'createRun' } },
  '/v1/agents': { get: { operationId: 'listAgents' } },
} };

describe('openapi', () => {
  it('summarises the served document', async () => {
    const r = await run(['openapi'], () => json(DOC));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, '/v1/openapi.json');
    assert.match(r.stdout, /version: 1\.2\.3/);
    assert.match(r.stdout, /operations: 3 across 2 paths/);
  });

  it('paths lists operations, --filter narrows, --json emits rows', async () => {
    let r = await run(['openapi', 'paths', '--filter', 'runs'], () => json(DOC));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /GET\s+\/v1\/runs\s+listRuns/);
    assert.doesNotMatch(r.stdout, /listAgents/);
    r = await run(['--json', 'openapi', 'paths'], () => json(DOC));
    assert.equal(JSON.parse(r.stdout).length, 3);
  });

  it('--json prints the whole document', async () => {
    const r = await run(['--json', 'openapi'], () => json(DOC));
    assert.deepEqual(JSON.parse(r.stdout), DOC);
  });

  it('a 403 exits 4', async () => {
    const r = await run(['openapi'], forbidden);
    assert.equal(r.code, 4);
  });
});

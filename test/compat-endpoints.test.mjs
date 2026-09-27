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

const CE = '/v1/host/openwop-app/compat-endpoints';

describe('compat-endpoints (RFC 0108)', () => {
  it('list reads ?orgId= and renders hasKey, never a key', async () => {
    const r = await run(['compat-endpoints', 'list', '--org', 'o1'], () => json({ endpoints: [{ id: 'compat-1', label: 'vLLM', baseUrl: 'https://llm.example.com', hasKey: true, models: ['m1'] }] }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, CE);
    assert.equal(r.calls[0].search, '?orgId=o1');
    assert.match(r.stdout, /compat-1\s+vLLM\s+https:\/\/llm\.example\.com\s+yes\s+m1/);
  });

  it('create sends the key from an env var (never argv) and capabilities', async () => {
    const r = await run(['compat-endpoints', 'create', '--org', 'o1', '--label', 'vLLM', '--base-url-endpoint', 'https://llm.example.com/v1',
      '--api-key-env', 'VLLM_KEY', '--model', 'm1', '--tools'], (m, p, b) => json({ id: 'compat-2', label: b.label, hasKey: true }, 201), { VLLM_KEY: 'sk-test' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.deepEqual(r.calls[0].body, {
      orgId: 'o1', label: 'vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test', models: ['m1'],
      capabilities: { vision: false, tools: true, longContext: false },
    });
    assert.doesNotMatch(r.stdout, /sk-test/);
    assert.match(r.stdout, /Created compat endpoint compat-2/);
  });

  it('--json passes the list through', async () => {
    const body = { endpoints: [] };
    const r = await run(['--json', 'compat-endpoints', 'list', '--org', 'o1'], () => json(body));
    assert.deepEqual(JSON.parse(r.stdout), body);
  });

  it('delete needs --yes, then DELETEs', async () => {
    let r = await run(['compat-endpoints', 'delete', 'compat-1'], () => json({}));
    assert.equal(r.code, 2);
    r = await run(['compat-endpoints', 'delete', 'compat-1', '--yes'], () => new Response(null, { status: 204 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['DELETE', `${CE}/compat-1`]);
  });

  it('a disabled surface (404) fails closed with exit 1', async () => {
    const r = await run(['compat-endpoints', 'list', '--org', 'o1'], () => json({ error: 'not_found', message: 'compat-endpoints disabled' }, 404));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /compat-endpoints disabled/);
  });

  it('a 403 exits 4', async () => {
    const r = await run(['compat-endpoints', 'list', '--org', 'o1'], forbidden);
    assert.equal(r.code, 4);
  });
});

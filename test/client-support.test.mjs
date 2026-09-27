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

describe('client-support (ADR 0413)', () => {
  it('asks unauthenticated with build + platform and exits 0 when supported', async () => {
    const r = await run(['client-support', '--build', '41', '--platform', 'ios'], () => json({ platform: 'ios', minBuild: 40, build: 41, supported: true }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, '/v1/host/openwop-app/client-support');
    assert.equal(r.calls[0].search, '?build=41&platform=ios');
    assert.equal(r.calls[0].headers.authorization, undefined);
    assert.match(r.stdout, /supported: yes/);
  });

  it('exits 3 below the floor and prints the upgrade URL; --json passes through', async () => {
    const body = { platform: 'web', minBuild: 50, build: 41, supported: false, upgradeUrl: 'https://example.com/up' };
    let r = await run(['client-support', '--build', '41'], () => json(body));
    assert.equal(r.code, 3);
    assert.match(r.stdout, /upgradeUrl: https:\/\/example\.com\/up/);
    r = await run(['--json', 'client-support', '--build', '41'], () => json(body));
    assert.equal(r.code, 3);
    assert.deepEqual(JSON.parse(r.stdout), body);
  });

  it('rejects a bad --build / --platform locally', async () => {
    let r = await run(['client-support', '--build', 'x'], () => json({}));
    assert.equal(r.code, 2);
    r = await run(['client-support', '--platform', 'tv'], () => json({}));
    assert.equal(r.code, 2);
  });

  it('a 403 exits 4', async () => {
    const r = await run(['client-support'], forbidden);
    assert.equal(r.code, 4);
  });
});

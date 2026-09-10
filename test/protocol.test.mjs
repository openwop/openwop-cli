// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// Protocol-major negotiation (src/protocol.ts; spec/v2/core/versioning.md §1.2–§1.5):
// the CLI reads `/.well-known/openwop` once, selects the highest major it
// implements that the host advertises, and under major 2 rewrites manifest-named
// `/v1/<op>` requests to the unversioned twin + `OpenWOP-Version: 2.0`, leaving
// host-proprietary `/v1/host/sample/*` routes exactly as written.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

/** A host whose discovery advertises `protocolVersions`; records every request it sees. */
function host(protocolVersions, preferredVersion) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const headers = init?.headers ?? {};
    seen.push({ path: u.pathname, search: u.search, method: init?.method ?? 'GET', version: headers['openwop-version'] ?? null });
    if (u.pathname === '/.well-known/openwop') {
      return new Response(JSON.stringify({ protocolVersions, preferredVersion }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/health') return new Response('{}', { status: 200 });
    if (u.pathname === '/v1/host/sample/daemon-status') {
      return new Response(JSON.stringify({ pid: 1, uptimeSeconds: 2, startTime: 't' }), { status: 200 });
    }
    if (/^(\/v1)?\/runs\/r-1\/annotations$/.test(u.pathname) && init?.method === 'POST') {
      return new Response(JSON.stringify({ annotationId: 'a2', signal: JSON.parse(init.body).signal }), { status: 201 });
    }
    throw new Error(`unexpected fetch: ${u.pathname}`);
  };
  return { seen, fetchImpl };
}

function opts(h, cap, env = {}) {
  return { io: cap.io, fetchImpl: h.fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', ...env } };
}

const annotate = ['runs', 'annotate', 'r-1', '--rating', '5', '--note', 'nice', '--base-url', 'http://h'];

describe('protocol negotiation', () => {
  it('a dual-stack host: manifest-named /v1/<op> goes unversioned with OpenWOP-Version: 2.0', async () => {
    const h = host(['1.9', '2.0'], '1.9');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap)), 0, cap.stderr);
    const discovery = h.seen.filter((r) => r.path === '/.well-known/openwop');
    assert.equal(discovery.length, 1, 'discovery is read exactly once per process');
    assert.equal(discovery[0].version, null, 'discovery is read header-less');
    const post = h.seen.find((r) => r.method === 'POST');
    assert.equal(post.path, '/runs/r-1/annotations');
    assert.equal(post.version, '2.0');
  });

  it('a v1-only host: the /v1 literal is sent as written, no version header', async () => {
    const h = host(['1.9'], '1.9');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap)), 0, cap.stderr);
    const post = h.seen.find((r) => r.method === 'POST');
    assert.equal(post.path, '/v1/runs/r-1/annotations');
    assert.equal(post.version, null);
  });

  it('OPENWOP_PROTOCOL_MAJOR=1 pins major 1 without probing discovery', async () => {
    const h = host(['1.9', '2.0'], '1.9');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap, { OPENWOP_PROTOCOL_MAJOR: '1' })), 0, cap.stderr);
    assert.equal(h.seen.filter((r) => r.path === '/.well-known/openwop').length, 0);
    assert.equal(h.seen.find((r) => r.method === 'POST').path, '/v1/runs/r-1/annotations');
  });

  it('an unreachable host stays on the v1 default and the command reports its own failure', async () => {
    const cap = capture();
    const fetchImpl = async () => { throw new Error('connect refused'); };
    const code = await runCli(annotate, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } });
    assert.notEqual(code, 0);
    assert.match(cap.stderr, /connect refused/);
  });

  it('doctor: proprietary /v1/host/sample/* stays /v1 under major 2, and the protocol row names the selected major', async () => {
    const h = host(['1.9', '2.0'], '1.9');
    const cap = capture();
    await runCli(['doctor', '--json', '--base-url', 'http://h'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const daemon = h.seen.filter((r) => r.path.endsWith('/host/sample/daemon-status'));
    assert.equal(daemon.length, 1);
    assert.equal(daemon[0].path, '/v1/host/sample/daemon-status', 'a path the manifest does not name is never rewritten');
    assert.equal(daemon[0].version, null);
    const row = JSON.parse(cap.stdout).checks.find((c) => c.name === 'protocol');
    assert.equal(row.status, 'ok');
    assert.match(row.message, /protocolVersions 1\.9, 2\.0; preferredVersion 1\.9; CLI speaks major 2/);
  });

  it('doctor: a v2-only host passes the protocol row (the CLI speaks major 2)', async () => {
    const h = host(['2.0'], '2.0');
    const cap = capture();
    await runCli(['doctor', '--json', '--base-url', 'http://h'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const row = JSON.parse(cap.stdout).checks.find((c) => c.name === 'protocol');
    assert.equal(row.status, 'ok');
    assert.match(row.message, /CLI speaks major 2/);
  });

  it('doctor: a host advertising neither major fails the protocol row', async () => {
    const h = host(['3.0'], '3.0');
    const cap = capture();
    await runCli(['doctor', '--json', '--base-url', 'http://h'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const row = JSON.parse(cap.stdout).checks.find((c) => c.name === 'protocol');
    assert.equal(row.status, 'fail');
    assert.match(row.message, /neither major/);
  });
});

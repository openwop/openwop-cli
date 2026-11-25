// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// The v2-only wire (src/protocol.ts; spec/v2/core/versioning.md §1.2–§1.5, §5):
// the CLI reads `/.well-known/openwop` once, refuses a host that serves only
// major 1 (end of support 2026-10-04, RFC 0234), sends every path as written,
// adds `OpenWOP-Version: 2.0` to protocol paths, and leaves host-proprietary
// `/host/<org>/*` routes header-less.
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
function host(protocolVersions, preferredVersion, { extensions, strict = false } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const headers = init?.headers ?? {};
    seen.push({ path: u.pathname, search: u.search, method: init?.method ?? 'GET', version: headers['openwop-version'] ?? null });
    if (u.pathname === '/.well-known/openwop') {
      const asked = headers['openwop-version'];
      // A `strict` host implements §1.3: a header naming an unserved major is a 406.
      if (strict && asked && !protocolVersions.some((v) => v.startsWith(`${String(asked).split('.')[0]}.`))) {
        return new Response(JSON.stringify({ error: 'protocol_version_unsupported', details: { protocolVersions } }), { status: 406 });
      }
      return new Response(JSON.stringify({ protocolVersions, preferredVersion, ...(extensions ? { extensions } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/health') return new Response('{}', { status: 200 });
    if (u.pathname === '/host/openwop-app/daemon-status') {
      return new Response(JSON.stringify({ pid: 1, uptimeSeconds: 2, startTime: 't' }), { status: 200 });
    }
    if (u.pathname === '/runs/r-1/annotations' && init?.method === 'POST') {
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

const V1_EOS = /major 1 reached end of support on 2026-10-04 \(RFC 0234\)/;

describe('protocol negotiation (v2 only)', () => {
  it('a v2 host: the unversioned path is sent as written with OpenWOP-Version: 2.0, after ONE discovery read', async () => {
    const h = host(['2.0'], '2.0');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap)), 0, cap.stderr);
    const discovery = h.seen.filter((r) => r.path === '/.well-known/openwop');
    assert.equal(discovery.length, 1, 'discovery is read exactly once per process');
    assert.equal(discovery[0].version, '2', 'discovery asks for the v2 representation (the one carrying extensions.<org>.host)');
    const post = h.seen.find((r) => r.method === 'POST');
    assert.equal(post.path, '/runs/r-1/annotations');
    assert.equal(post.version, '2.0');
    assert.ok(!h.seen.some((r) => r.path.startsWith('/v1/')), 'nothing is ever sent to /v1');
  });

  it('a host that also lists a 1.x version is still spoken to on major 2', async () => {
    const h = host(['1.9', '2.0'], '1.9');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap)), 0, cap.stderr);
    assert.equal(h.seen.find((r) => r.method === 'POST').version, '2.0');
  });

  it('a v1-only host is refused with a message naming major 1 end of support, and nothing is sent', async () => {
    const h = host(['1.9'], '1.9');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap)), 1);
    assert.match(cap.stderr, /does not serve OpenWOP protocol major 2 \(it advertises 1\.9\)/);
    assert.match(cap.stderr, V1_EOS);
    assert.equal(h.seen.filter((r) => r.method === 'POST').length, 0);
  });

  it('a strict v1-only host answers the v2 discovery ask with 406: its details.protocolVersions is read and the host is refused', async () => {
    const h = host(['1.9'], '1.9', { strict: true });
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap)), 1);
    assert.match(cap.stderr, /it advertises 1\.9/);
    assert.match(cap.stderr, V1_EOS);
    assert.equal(h.seen.filter((r) => r.method === 'POST').length, 0);
  });

  it('OPENWOP_PROTOCOL_MAJOR=1 is refused (exit 2) with a message naming major 1 end of support', async () => {
    const h = host(['1.9', '2.0'], '1.9');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap, { OPENWOP_PROTOCOL_MAJOR: '1' })), 2);
    assert.match(cap.stderr, /OPENWOP_PROTOCOL_MAJOR=1 is not supported/);
    assert.match(cap.stderr, V1_EOS);
    assert.equal(h.seen.length, 0, 'nothing is sent');
  });

  it('OPENWOP_PROTOCOL_MAJOR=2 skips the discovery read', async () => {
    const h = host(['2.0'], '2.0');
    const cap = capture();
    assert.equal(await runCli(annotate, opts(h, cap, { OPENWOP_PROTOCOL_MAJOR: '2' })), 0, cap.stderr);
    assert.equal(h.seen.filter((r) => r.path === '/.well-known/openwop').length, 0);
    const post = h.seen.find((r) => r.method === 'POST');
    assert.deepEqual([post.path, post.version], ['/runs/r-1/annotations', '2.0']);
  });

  it('an unreachable host is not refused: the command reports its own failure', async () => {
    const cap = capture();
    const fetchImpl = async () => { throw new Error('connect refused'); };
    const code = await runCli(annotate, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } });
    assert.notEqual(code, 0);
    assert.match(cap.stderr, /connect refused/);
  });

  it('doctor: proprietary /host/openwop-app/* carries no version header, and the protocol row names major 2', async () => {
    const h = host(['2.0'], '2.0');
    const cap = capture();
    await runCli(['doctor', '--json', '--base-url', 'http://h'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const daemon = h.seen.filter((r) => r.path.endsWith('/daemon-status'));
    assert.equal(daemon.length, 1);
    assert.equal(daemon[0].path, '/host/openwop-app/daemon-status');
    assert.equal(daemon[0].version, null, 'a /host/<org>/ path has no major (§5) — no OpenWOP-Version');
    const row = JSON.parse(cap.stdout).checks.find((c) => c.name === 'protocol');
    assert.equal(row.status, 'ok');
    assert.match(row.message, /protocolVersions 2\.0; preferredVersion 2\.0; CLI speaks major 2/);
  });

  it('doctor: a v1-only host fails the protocol row with the end-of-support message', async () => {
    const h = host(['1.9'], '1.9');
    const cap = capture();
    await runCli(['doctor', '--json', '--base-url', 'http://h'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const row = JSON.parse(cap.stdout).checks.find((c) => c.name === 'protocol');
    assert.equal(row.status, 'fail');
    assert.match(row.message, V1_EOS);
  });

  it('doctor: a host advertising only an unknown major fails the protocol row', async () => {
    const h = host(['3.0'], '3.0');
    const cap = capture();
    await runCli(['doctor', '--json', '--base-url', 'http://h'], { io: cap.io, fetchImpl: h.fetchImpl, cwd: '/tmp', env: {} });
    const row = JSON.parse(cap.stdout).checks.find((c) => c.name === 'protocol');
    assert.equal(row.status, 'fail');
    assert.match(row.message, /does not serve OpenWOP protocol major 2/);
  });
});

describe('hostSurfaceAdvertised', async () => {
  const { hostSurfaceAdvertised } = await import('../dist/cli.js');
  const P = '/host/openwop-app/workforces';
  it('reads the advertised extension root (versioning.md §5)', () => {
    assert.equal(hostSurfaceAdvertised({ extensions: { 'openwop-app.host': { root: '/host/openwop-app/' } } }, P), true);
    assert.equal(hostSurfaceAdvertised({ extensions: { 'openwop-app.host': { root: '/host/openwop-app' } } }, P), true);
    assert.equal(hostSurfaceAdvertised({ extensions: { 'other.host': { root: '/host/other/' } } }, P), false);
    assert.equal(hostSurfaceAdvertised({}, P), false);
    assert.equal(hostSurfaceAdvertised(null, P), false);
  });
  it('a v1 paths map is not an advertisement (major 1 ended 2026-10-04)', () => {
    assert.equal(hostSurfaceAdvertised({ paths: { '/v1/host/openwop-app/workforces': {} } }, P), false);
  });
});

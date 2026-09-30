// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
//
// A dual-stack host serves two discovery documents at /.well-known/openwop,
// selected by OpenWOP-Version, and they need not carry the same records: the
// v2 reference host keeps `a2a` only at its closed v2 root, while
// app.openwop.dev keeps it only in the v1 document. A capability check that
// reads one of them reports "absent" for a record the host does advertise.
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

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function opts(fetchImpl, cap) {
  return { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } };
}

const versionOf = (init) => {
  const h = init?.headers;
  if (!h) return undefined;
  return typeof h.get === 'function' ? h.get('openwop-version') ?? undefined : h['openwop-version'] ?? h['OpenWOP-Version'];
};

// The v2 reference host's shape: v1 document without a2a, v2 root with it.
function dualStack({ v1 = {}, v2 = {} } = {}, handler = async () => jsonResponse({})) {
  return async (url, init) => {
    if (new URL(url).pathname === '/.well-known/openwop') {
      return versionOf(init) === '2'
        ? jsonResponse({ protocolVersions: ['1.11', '2.0'], preferredVersion: '1.11', ...v2 }, 200, { 'openwop-version': '2.0' })
        : jsonResponse({ protocolVersions: ['1.11', '2.0'], preferredVersion: '1.11', ...v1 });
    }
    return handler(url, init);
  };
}

const V2_A2A = { status: 'experimental', since: '2.0', until: '2.1', witness: 'seam-gated', streaming: false, pushNotifications: false, durableTasks: false };

describe('capability records across discovery representations', () => {
  it('a2a status finds a record the host advertises only at its v2 root', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'status'], opts(dualStack({ v2: { a2a: V2_A2A } }), cap));
    assert.equal(code, 0, cap.stdout + cap.stderr);
    assert.match(cap.stdout, /a2a.supported: yes/); // v2: presence is the claim
    assert.match(cap.stdout, /durableTasks: no/);
  });

  it('a2a status still finds a record the host advertises only in its v1 document', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'status'], opts(dualStack({ v1: { capabilities: { a2a: { supported: true, durableTasks: true } } } }), cap));
    assert.equal(code, 0, cap.stdout + cap.stderr);
    assert.match(cap.stdout, /durableTasks: yes/);
  });

  it('still fails closed when neither representation advertises the record', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'status'], opts(dualStack(), cap));
    assert.equal(code, 1);
    assert.match(cap.stdout, /does not advertise A2A/);
  });

  it('goals stays refused when neither representation advertises agents.goals', async () => {
    const cap = capture();
    const code = await runCli(['goals', 'list'], opts(dualStack({ v2: { agents: { status: 'experimental', since: '2.0', witness: 'seam-gated' } } }), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr + cap.stdout, /does not advertise the standing-goals capability/);
  });
});

describe('interrupts list on a host without the openwop-app extension', () => {
  it('fails closed with a legible message instead of a bare 404', async () => {
    const cap = capture();
    const code = await runCli(['interrupts', 'list', 'tenant/run_1'], opts(dualStack({}, async () =>
      jsonResponse({ error: 'not_found', message: 'no operation at /v1/host/openwop-app/runs/tenant%2Frun_1/interrupts' }, 404)), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /reads the openwop-app host extension/);
    assert.match(cap.stderr, /interrupts respond <runId> <nodeId>/);
  });

  it('keeps an ordinary 404 (the route is served, the run is not found) as it was', async () => {
    const cap = capture();
    const code = await runCli(['interrupts', 'list', 'run_missing'], opts(dualStack({}, async () =>
      jsonResponse({ error: 'run_not_found', message: 'no such run' }, 404)), cap));
    assert.notEqual(code, 0);
    assert.doesNotMatch(cap.stderr, /reads the openwop-app host extension/);
  });
});

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function opts(fetchImpl, cap) {
  return { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k' } };
}

function wellKnown(withProposals = true) {
  const paths = { '/v1/runs': { get: {} } };
  if (withProposals) paths['/v1/host/sample/proposals'] = { get: {} };
  return { protocolVersion: '1.0', paths };
}

function host(handler, { advertised = true } = {}) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/openwop') return jsonResponse(wellKnown(advertised));
    return handler(url, init);
  };
}

describe('proposals list', () => {
  it('renders the queue as a table', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/proposals$/);
      return jsonResponse({ proposals: [
        { proposalId: 'prop_1', state: 'pending', kind: 'agent-manifest', activation: 'approval-gate', persona: 'Triage', title: 'Tighten the triage rubric', createdAt: '2026-06-13' },
      ] });
    });
    const code = await runCli(['proposals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /prop_1\s+pending\s+agent-manifest\s+approval-gate\s+Triage/);
  });

  it('passes --state and --kind through as query filters', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      const u = new URL(url);
      assert.match(u.search, /state=pending/);
      assert.match(u.search, /kind=agent-manifest/);
      return jsonResponse({ proposals: [] });
    });
    const code = await runCli(['proposals', 'list', '--state', 'pending', '--kind', 'agent-manifest'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No proposals in state pending of kind agent-manifest/);
  });

  it('emits raw JSON with --json', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ proposals: [{ proposalId: 'prop_9', state: 'applied' }] }));
    const code = await runCli(['proposals', 'list', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), { proposals: [{ proposalId: 'prop_9', state: 'applied' }] });
  });

  it('fails closed (exit 1) when the host does not advertise the surface', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ proposals: [] }), { advertised: false });
    const code = await runCli(['proposals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise/);
  });
});

describe('proposals get', () => {
  it('renders one proposal and exits 3 for a pending state', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/proposals\/prop_1$/);
      return jsonResponse({ proposalId: 'prop_1', state: 'pending', kind: 'agent-manifest', activation: 'approval-gate', title: 'x' });
    });
    const code = await runCli(['proposals', 'get', 'prop_1'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr);
    assert.match(cap.stdout, /state: pending/);
  });

  it('exits 0 for an applied proposal and 1 for a rejected one', async () => {
    const capA = capture();
    let code = await runCli(['proposals', 'get', 'p'], opts(host(async () => jsonResponse({ proposalId: 'p', state: 'applied' })), capA));
    assert.equal(code, 0, capA.stderr);
    const capR = capture();
    code = await runCli(['proposals', 'get', 'p'], opts(host(async () => jsonResponse({ proposalId: 'p', state: 'rejected' })), capR));
    assert.equal(code, 1);
  });
});

describe('proposals apply', () => {
  it('applies and reports the installed artifact ref (exit 0)', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/proposals\/prop_1\/apply$/);
      return jsonResponse({ installedArtifactRef: 'artifact:agent/triage@7' });
    });
    const code = await runCli(['proposals', 'apply', 'prop_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /installed artifact:agent\/triage@7/);
  });

  it('surfaces a host 403 (no scope) as a fail-closed exit 1', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'forbidden' }, 403));
    const code = await runCli(['proposals', 'apply', 'prop_1'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /lack the scope/);
  });

  it('surfaces a host 422 (malformed-for-kind) as exit 1', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'artifact malformed for kind agent-manifest' }, 422));
    const code = await runCli(['proposals', 'apply', 'prop_1'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /malformed for kind/);
  });

  it('reports a routed-to-approval-gate apply as pending (exit 3)', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ state: 'pending', activation: 'approval-gate' }));
    const code = await runCli(['proposals', 'apply', 'prop_1'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr);
    assert.match(cap.stdout, /activation gate/);
  });
});

describe('proposals revise / reject / archive', () => {
  it('revise PATCHes the draft and refuses an empty revision (exit 2)', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'PATCH');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.artifact, { systemPrompt: 'tighter' });
      return jsonResponse({ proposalId: 'prop_1', state: 'revised' });
    });
    let code = await runCli(['proposals', 'revise', 'prop_1', '--artifact-json', '{"systemPrompt":"tighter"}'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr); // revised → pending bucket
    assert.match(cap.stdout, /not activated/);

    const cap2 = capture();
    code = await runCli(['proposals', 'revise', 'prop_1'], opts(host(async () => jsonResponse({})), cap2));
    assert.equal(code, 2);
    assert.match(cap2.stderr, /Nothing to revise/);
  });

  it('reject reports the rejected verdict (exit 1)', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.match(new URL(url).pathname, /\/reject$/);
      assert.equal(JSON.parse(init.body).note, 'out of scope');
      return jsonResponse({ proposalId: 'prop_1', state: 'rejected' });
    });
    const code = await runCli(['proposals', 'reject', 'prop_1', '--note', 'out of scope'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stdout, /Rejected proposal prop_1/);
  });

  it('archive requires --yes', async () => {
    const cap = capture();
    let called = false;
    const fetchImpl = host(async (url, init) => { called = true; assert.equal(init.method, 'DELETE'); return jsonResponse({ state: 'archived' }); });
    let code = await runCli(['proposals', 'archive', 'prop_1'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /without --yes/);

    const cap2 = capture();
    code = await runCli(['proposals', 'archive', 'prop_1', '--yes'], opts(fetchImpl, cap2));
    assert.equal(code, 1, cap2.stderr); // archived → terminal-dismissal bucket
    assert.match(cap2.stdout, /Archived proposal prop_1/);
  });
});

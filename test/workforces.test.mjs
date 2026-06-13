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

function wellKnown(withWorkforces = true) {
  const paths = { '/v1/runs': { get: {} } };
  if (withWorkforces) paths['/v1/host/sample/workforces'] = { get: {} };
  return { protocolVersion: '1.0', paths };
}

function host(handler, { advertised = true } = {}) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/openwop') return jsonResponse(wellKnown(advertised));
    return handler(url, init);
  };
}

describe('workforces list', () => {
  it('renders workforces as a table', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/workforces$/);
      return jsonResponse({ workforces: [
        { workforceId: 'wf_1', name: 'Support', businessFunction: 'CX', status: 'piloting', autonomyLevel: 'assisted', agents: [{}, {}] },
      ] });
    });
    const code = await runCli(['workforces', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /wf_1\s+Support\s+CX\s+piloting\s+assisted\s+2/);
  });

  it('fleet alias works and --json passes through', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ workforces: [{ workforceId: 'wf_1', status: 'shadow' }] }));
    const code = await runCli(['fleet', 'list', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), { workforces: [{ workforceId: 'wf_1', status: 'shadow' }] });
  });

  it('fails closed when the host does not advertise the surface', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ workforces: [] }), { advertised: false });
    const code = await runCli(['workforces', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise the workforces surface/);
  });
});

describe('workforces get / metrics / governance', () => {
  it('renders a workforce bundle', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/workforces\/wf_1$/);
      return jsonResponse({ workforceId: 'wf_1', name: 'Support', businessFunction: 'CX', status: 'piloting',
        autonomyLevel: 'assisted', purpose: { statement: 'Handle tickets' }, agents: [{ agentRef: 'a1', role: 'supervisor', autonomyLevel: 'assisted' }] });
    });
    const code = await runCli(['workforces', 'get', 'wf_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /name: Support/);
    assert.match(cap.stdout, /a1 \[supervisor\]/);
  });

  it('renders metrics with the /metrics suffix', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/workforces\/wf_1\/metrics$/);
      return jsonResponse({ workforceId: 'wf_1', totalRuns: 10, terminalRuns: 8, openApprovals: 1, overrideRate: 0.25, source: 'tenant' });
    });
    const code = await runCli(['workforces', 'metrics', 'wf_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /totalRuns: 10/);
    assert.match(cap.stdout, /overrideRate: 25\.0%/);
  });

  it('renders governance (autonomy + posture)', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/workforces\/wf_1\/governance$/);
      return jsonResponse({ autonomy: { workforceId: 'wf_1', currentTier: 'assisted', nextTier: 'auto', eligibleForNext: false },
        posture: { overrides: 2, escalations: 3, falsePositives: 0, recoveries: 1, policyViolations: 0 }, source: 'tenant' });
    });
    const code = await runCli(['workforces', 'governance', 'wf_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /currentTier: assisted/);
    assert.match(cap.stdout, /overrides: 2/);
  });

  it('translates a 404 into a legible not-found', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'Workforce `nope` not found.' }, 404));
    const code = await runCli(['workforces', 'get', 'nope'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /not found/);
  });
});

describe('workforces trace', () => {
  it('passes --q as a query and tables matches', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.equal(new URL(url).search, '?q=batch_42');
      return jsonResponse({ workforceId: 'wf_1', matches: [{ runId: 'r1', status: 'completed', outcome: 'ok', createdAt: '2026-06-13' }] });
    });
    const code = await runCli(['workforces', 'trace', 'wf_1', '--q', 'batch_42'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /r1\s+completed\s+ok/);
  });

  it('reports no matches cleanly', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ workforceId: 'wf_1', matches: [] }));
    const code = await runCli(['workforces', 'trace', 'wf_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No trace matches/);
  });
});

describe('workforces status', () => {
  it('PATCHes the status and confirms', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'PATCH');
      assert.match(new URL(url).pathname, /\/workforces\/wf_1$/);
      assert.deepEqual(JSON.parse(init.body), { status: 'production' });
      return jsonResponse({ workforceId: 'wf_1', status: 'production' });
    });
    const code = await runCli(['workforces', 'status', 'wf_1', 'production'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /✓ wf_1 → status production/);
  });

  it('rejects an invalid status with exit 2', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({}));
    const code = await runCli(['workforces', 'status', 'wf_1', 'bogus'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /status must be one of/);
  });

  it('surfaces a 409 cutover-ineligible legibly', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'Cannot cut over to production: the workforce must graduate to bounded-autonomous first (current tier: assisted).' }, 409));
    const code = await runCli(['workforces', 'status', 'wf_1', 'production'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /must graduate to bounded-autonomous/);
  });
});

describe('workforces eval', () => {
  it('fails closed (exit 1) when the host does not enable the eval suite', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'This host does not enable the agent eval suite (set OPENWOP_AGENT_EVAL_SUITE_ENABLED=true).' }, 501));
    const code = await runCli(['workforces', 'eval', 'wf_1'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not enable the agent eval suite/);
  });
});

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

// A discovery doc that advertises (or omits) the approval surface, so the
// capability gate has something honest to read.
function wellKnown(withApprovals = true) {
  const paths = { '/v1/runs': { get: {} } };
  if (withApprovals) paths['/v1/host/sample/approvals'] = { get: {} };
  return { protocolVersion: '1.0', paths };
}

// Route a fake host: the well-known + an approvals handler the test supplies.
function host(approvals, { advertised = true } = {}) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/openwop') return jsonResponse(wellKnown(advertised));
    return approvals(url, init);
  };
}

describe('approvals list', () => {
  it('renders the queue as a table', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/approvals$/);
      return jsonResponse({ items: [
        { approvalId: 'appr_1', status: 'pending', kind: 'run-proposal', persona: 'Triage', proposal: 'Run the nightly report', createdAt: '2026-06-13' },
      ] });
    });
    const code = await runCli(['approvals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /appr_1\s+pending\s+run-proposal\s+Triage/);
  });

  it('passes --status through as a query filter', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.equal(new URL(url).search, '?status=pending');
      return jsonResponse({ items: [] });
    });
    const code = await runCli(['approvals', 'list', '--status', 'pending'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No approvals with status pending/);
  });

  it('emits raw JSON with --json', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [{ approvalId: 'appr_9', status: 'approved' }] }));
    const code = await runCli(['approvals', 'list', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), { items: [{ approvalId: 'appr_9', status: 'approved' }] });
  });

  it('rejects an invalid --status with exit 2', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [] }));
    const code = await runCli(['approvals', 'list', '--status', 'bogus'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /--status must be one of/);
  });
});

describe('approvals capability honesty', () => {
  it('fails closed when the host does not advertise the surface', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [] }), { advertised: false });
    const code = await runCli(['approvals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise the approval-inbox surface/);
  });

  it('translates a 404 from an unmounted route into a legible failure', async () => {
    const cap = capture();
    // Well-known unreachable (inconclusive) → defer to the live call, which 404s.
    const fetchImpl = async (url) => {
      const { pathname } = new URL(url);
      if (pathname === '/.well-known/openwop') return jsonResponse({ error: 'nope' }, 404);
      return jsonResponse({ message: 'Not Found' }, 404);
    };
    const code = await runCli(['approvals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /the host must mount \/v1\/host\/sample\/approvals/);
  });
});

describe('approvals get', () => {
  it('selects one approval client-side and exits 3 for pending', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [
      { approvalId: 'appr_1', status: 'approved' },
      { approvalId: 'appr_2', status: 'pending', persona: 'Triage', proposal: 'do thing', createdAt: '2026-06-13' },
    ] }));
    const code = await runCli(['approvals', 'get', 'appr_2'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr); // pending → 3
    assert.match(cap.stdout, /approvalId: appr_2/);
    assert.match(cap.stdout, /status: pending/);
  });

  it('exits 0 when the approval is approved', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [{ approvalId: 'appr_1', status: 'approved' }] }));
    const code = await runCli(['approvals', 'get', 'appr_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
  });

  it('errors (exit 1) when the id is absent from the queue', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ items: [] }));
    const code = await runCli(['approvals', 'get', 'missing'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /no approval found with id missing/);
  });
});

describe('approvals claim / reject', () => {
  it('claim POSTs to /claim with the note and exits 0 (approved)', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/approvals\/appr_1\/claim$/);
      assert.deepEqual(JSON.parse(init.body), { note: 'ship it' });
      return jsonResponse({ approvalId: 'appr_1', status: 'approved', runId: 'run_7' });
    });
    const code = await runCli(['approvals', 'claim', 'appr_1', '--note', 'ship it'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /✓ Claimed approval appr_1 → approved \(run run_7\)/);
  });

  it('approve is an alias for claim', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/approvals\/appr_1\/claim$/);
      return jsonResponse({ approvalId: 'appr_1', status: 'approved' });
    });
    const code = await runCli(['approvals', 'approve', 'appr_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
  });

  it('reject POSTs to /reject and exits 1 (denied), per the verdict contract', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/approvals\/appr_1\/reject$/);
      return jsonResponse({ approvalId: 'appr_1', status: 'rejected' });
    });
    const code = await runCli(['approvals', 'reject', 'appr_1'], opts(fetchImpl, cap));
    assert.equal(code, 1, cap.stderr); // rejected/denied → 1, even on success
    assert.match(cap.stdout, /✓ Rejected approval appr_1 → rejected/);
  });

  it('surfaces a 409 already-resolved conflict legibly', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ status: 'approved' }, 409));
    const code = await runCli(['approvals', 'claim', 'appr_1'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /already approved/);
  });
});

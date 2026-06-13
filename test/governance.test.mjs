// Run via `npm test` (builds dist/ first) — these import the esbuild bundle at ../dist/cli.js.
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

const POLICY_BODY = {
  policy: {
    tenantId: 'acme',
    actionPolicy: { 'email.send': 'draft-only' },
    providerAllowlist: ['anthropic'],
    updatedAt: '2026-06-13T00:00:00Z',
    updatedByUserId: 'u1',
  },
  defaults: { actionPolicy: 'approval-required', providerAllowlist: null },
  actionKinds: ['email.send', 'calendar.invite', 'calendar.reschedule', 'nudge'],
};

describe('governance policy get', () => {
  it('renders the host-resolved view (stored value + default fallbacks)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/governance\/policy$/);
      return jsonResponse(POLICY_BODY);
    };
    const code = await runCli(['governance', 'policy'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /tenant acme/);
    assert.match(cap.stdout, /email\.send\s+draft-only/);
    // unset kinds render the host's declared default — not a CLI-computed outcome.
    assert.match(cap.stdout, /calendar\.invite\s+\(default → approval-required\)/);
    assert.match(cap.stdout, /Provider allowlist: anthropic/);
  });

  it('emits raw host JSON under --json', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse(POLICY_BODY);
    const code = await runCli(['--json', 'governance', 'policy', 'get'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), POLICY_BODY);
  });

  it('alias `policy` maps to the governance group', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse(POLICY_BODY);
    const code = await runCli(['policy', 'get'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Governance policy/);
  });
});

describe('governance policy set', () => {
  it('PUTs an action-policy patch and confirms', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PUT');
      assert.match(new URL(url).pathname, /\/governance\/policy$/);
      assert.deepEqual(JSON.parse(init.body), { actionPolicy: { 'nudge': 'disabled' } });
      return jsonResponse({ policy: { tenantId: 'acme', actionPolicy: { nudge: 'disabled' } } });
    };
    const code = await runCli(['governance', 'policy', 'set', '--action', 'nudge=disabled'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Updated governance policy for tenant acme/);
    assert.match(cap.stdout, /nudge → disabled/);
  });

  it('builds provider allowlist + retention into one body', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.deepEqual(JSON.parse(init.body), {
        providerAllowlist: ['anthropic', 'openai'],
        retention: { assistantGraphDays: 90 },
      });
      return jsonResponse({ policy: { tenantId: 'acme', providerAllowlist: ['anthropic', 'openai'] } });
    };
    const code = await runCli(
      ['governance', 'policy', 'set', '--provider-allowlist', 'anthropic, openai', '--retention-graph-days', '90'],
      opts(fetchImpl, cap),
    );
    assert.equal(code, 0, cap.stderr);
  });

  it('rejects an unknown action kind locally (exit 2, no request)', async () => {
    const cap = capture();
    let called = false;
    const fetchImpl = async () => { called = true; return jsonResponse({}); };
    const code = await runCli(['governance', 'policy', 'set', '--action', 'bogus=disabled'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /Unknown action kind 'bogus'/);
  });

  it('rejects an empty patch (exit 2)', async () => {
    const cap = capture();
    const code = await runCli(['governance', 'policy', 'set'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /Nothing to set/);
  });
});

describe('governance audit', () => {
  it('lists audit rows as a table and threads query params', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      const u = new URL(url);
      assert.match(u.pathname, /\/governance\/audit$/);
      assert.equal(u.searchParams.get('actionPrefix'), 'governance.');
      assert.equal(u.searchParams.get('limit'), '20');
      return jsonResponse({ items: [{ timestamp: '2026-06-13T01:02:03Z', principalId: 'u1', action: 'governance.policy.updated', resource: 'governance:acme', outcome: 'success' }] });
    };
    const code = await runCli(['governance', 'audit', '--prefix', 'governance.', '--limit', '20'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /governance\.policy\.updated\s+governance:acme\s+success/);
  });

  it('reports empty (fail-closed) audit results legibly', async () => {
    const cap = capture();
    const code = await runCli(['governance', 'audit'], opts(async () => jsonResponse({ items: [] }), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No audit rows match/);
  });
});

describe('governance capability honesty', () => {
  it('fails closed legibly when the surface is not advertised (404)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'not found' }, 404);
    const code = await runCli(['governance', 'policy'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /does not advertise governance administration/);
  });
});

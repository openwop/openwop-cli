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

function wellKnown(withGoals = true) {
  // §11: advertised via capabilities.agents.goals, not a paths map.
  const capabilities = withGoals
    ? { agents: { goals: { judge: 'verifier', requiresBounds: true } } }
    : {};
  return { protocolVersion: '1.0', capabilities };
}

function host(handler, { advertised = true } = {}) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/.well-known/openwop') return jsonResponse(wellKnown(advertised));
    return handler(url, init);
  };
}

describe('goals list', () => {
  it('renders the goals as a table with iterations/bounds', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/goals$/);
      return jsonResponse({ goals: [
        { goalId: 'goal_1', state: 'active', judge: 'verifier', objective: 'Keep backlog under 20', progress: { iterations: 3 }, bounds: { maxIterations: 50 }, createdAt: '2026-06-13' },
      ] });
    });
    const code = await runCli(['goals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /goal_1\s+active\s+verifier\s+Keep backlog under 20\s+3\/50/);
  });

  it('passes --state through and reports empty', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.equal(new URL(url).search, '?state=satisfied');
      return jsonResponse({ goals: [] });
    });
    const code = await runCli(['goals', 'list', '--state', 'satisfied'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No goals in state satisfied/);
  });

  it('emits raw JSON with --json', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ goals: [{ goalId: 'g1', state: 'satisfied' }] }));
    const code = await runCli(['goals', 'list', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), { goals: [{ goalId: 'g1', state: 'satisfied' }] });
  });

  it('fails closed (exit 1) when the surface is not advertised', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ goals: [] }), { advertised: false });
    const code = await runCli(['goals', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise/);
  });
});

describe('goals get exit codes mirror the judge verdict', () => {
  it('0 satisfied, 3 active/escalated, 1 bound-exceeded', async () => {
    for (const [state, expected] of [['satisfied', 0], ['active', 3], ['escalated', 3], ['bound-exceeded', 1]]) {
      const cap = capture();
      const code = await runCli(['goals', 'get', 'g'], opts(host(async () => jsonResponse({ goalId: 'g', state })), cap));
      assert.equal(code, expected, `${state} → ${expected} (${cap.stderr})`);
    }
  });
});

describe('goals create', () => {
  it('builds the body (objective/judge/continuation/bounds) and returns the created goal', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.equal(body.objective, 'Keep backlog under 20');
      assert.equal(body.judge, 'verifier');
      assert.deepEqual(body.continuation, ['schedule']);
      assert.deepEqual(body.bounds, { maxIterations: 50, maxCost: 5 });
      return jsonResponse({ goalId: 'goal_9', state: 'active', judge: 'verifier' });
    });
    const code = await runCli(
      ['goals', 'create', '--objective', 'Keep backlog under 20', '--judge', 'verifier', '--continuation', 'schedule', '--max-iterations', '50', '--max-cost', '5'],
      opts(fetchImpl, cap),
    );
    assert.equal(code, 3, cap.stderr); // freshly active → still-open bucket
    assert.match(cap.stdout, /Created goal goal_9/);
  });

  it('requires --objective (exit 2)', async () => {
    const cap = capture();
    const code = await runCli(['goals', 'create'], opts(host(async () => jsonResponse({})), cap));
    assert.equal(code, 2);
  });

  it('rejects an invalid --judge (exit 2)', async () => {
    const cap = capture();
    const code = await runCli(['goals', 'create', '--objective', 'x', '--judge', 'me'], opts(host(async () => jsonResponse({})), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /--judge must be one of/);
  });

  it('surfaces the host 422 (requiresBounds) as a legible exit 1', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'an active goal requires bounds' }, 422));
    const code = await runCli(['goals', 'create', '--objective', 'x'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /requires bounds/);
  });
});

describe('goals pause / resume / abandon', () => {
  it('pause POSTs to /pause and reports paused (exit 3)', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/goals\/g1\/pause$/);
      return jsonResponse({ goalId: 'g1', state: 'paused' });
    });
    const code = await runCli(['goals', 'pause', 'g1'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr);
    assert.match(cap.stdout, /Paused goal g1/);
  });

  it('abandon requires --yes, then closes the goal (exit 1)', async () => {
    const cap = capture();
    let called = false;
    const fetchImpl = host(async (url, init) => { called = true; assert.match(new URL(url).pathname, /\/abandon$/); return jsonResponse({ goalId: 'g1', state: 'abandoned' }); });
    let code = await runCli(['goals', 'abandon', 'g1'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.equal(called, false);

    const cap2 = capture();
    code = await runCli(['goals', 'abandon', 'g1', '--yes'], opts(fetchImpl, cap2));
    assert.equal(code, 1, cap2.stderr);
    assert.match(cap2.stdout, /Abandoned goal g1/);
  });

  it('never offers a way to set state:satisfied (no such verb)', async () => {
    const cap = capture();
    const code = await runCli(['goals', 'satisfy', 'g1'], opts(host(async () => jsonResponse({})), cap));
    assert.equal(code, 2); // unknown subcommand → CliError (usage error, exit 2)
    assert.match(cap.stderr, /Unknown goals command/);
  });
});

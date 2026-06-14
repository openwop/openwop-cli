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

// a2a advertised via capabilities.a2a; durableTasks gates the durable read.
function wellKnown({ a2a = { supported: true, streaming: true, pushNotifications: true, durableTasks: true } } = {}) {
  const capabilities = {};
  if (a2a) capabilities.a2a = a2a;
  return { protocolVersion: '1.0', capabilities };
}

function host(handler, wkOpts = {}) {
  return async (url, init) => {
    if (new URL(url).pathname === '/.well-known/openwop') return jsonResponse(wellKnown(wkOpts));
    return handler(url, init);
  };
}

describe('a2a status', () => {
  it('renders the advertised a2a capability', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'status'], opts(host(async () => jsonResponse({})), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /a2a.supported: yes/);
    assert.match(cap.stdout, /durableTasks: yes/);
  });

  it('exits 1 + reports absence when a2a is not advertised', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'status'], opts(host(async () => jsonResponse({}), { a2a: null }), cap));
    assert.equal(code, 1);
    assert.match(cap.stdout, /does not advertise A2A/);
  });
});

describe('a2a task', () => {
  it('reads the durable A2ATaskState and renders it', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/a2a\/tasks\/run_abc$/);
      return jsonResponse({ taskId: 'run_abc', runId: 'run_abc', state: 'working', contextId: 'ctx_1', updatedAt: '2026-06-14T00:00:00Z' });
    });
    const code = await runCli(['a2a', 'task', 'run_abc'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr); // working → in-progress
    assert.match(cap.stdout, /taskId: run_abc/);
    assert.match(cap.stdout, /state: working/);
  });

  it('maps task state to exit codes', async () => {
    for (const [state, expected] of [['completed', 0], ['working', 3], ['input-required', 3], ['failed', 1], ['canceled', 1], ['rejected', 1]]) {
      const cap = capture();
      const code = await runCli(['a2a', 'task', 't'], opts(host(async () => jsonResponse({ taskId: 't', runId: 't', state, updatedAt: 'x' })), cap));
      assert.equal(code, expected, `${state} → ${expected} (${cap.stderr})`);
    }
  });

  it('shows interruptKind for an input-required task (--json passthrough)', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ taskId: 't', runId: 't', state: 'input-required', interruptKind: 'approval', updatedAt: 'x' }));
    const code = await runCli(['a2a', 'task', 't', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr);
    assert.equal(JSON.parse(cap.stdout).interruptKind, 'approval');
  });

  it('fails closed (exit 1) when a2a is not advertised', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'task', 't'], opts(host(async () => jsonResponse({}), { a2a: null }), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise A2A/);
  });

  it('fails closed (exit 1) when durableTasks is false', async () => {
    const cap = capture();
    const code = await runCli(['a2a', 'task', 't'], opts(host(async () => jsonResponse({}), { a2a: { supported: true, durableTasks: false } }), cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /not durable tasks/);
  });

  it('surfaces a missing durable task (404) as exit 1', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'no task' }, 404));
    const code = await runCli(['a2a', 'task', 'nope'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /no durable task nope/);
  });
});

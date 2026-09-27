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

const HE = '/v1/host/openwop-app/host-events/bindings';

describe('host-events (ADR 0208)', () => {
  it('list renders bindings; --json passes through', async () => {
    const body = { bindings: [{ bindingId: 'hb1', eventType: 'host.crm.contact.created', workflowId: 'wf1', enabled: true }] };
    let r = await run(['host-events', 'list'], () => json(body));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].path, HE);
    assert.match(r.stdout, /hb1\s+host\.crm\.contact\.created\s+wf1\s+yes/);
    r = await run(['--json', 'host-events', 'list'], () => json(body));
    assert.deepEqual(JSON.parse(r.stdout), body);
  });

  it('bind POSTs { eventType, workflowId } and refuses a non-host.* name locally', async () => {
    let r = await run(['host-events', 'bind', '--event', 'host.crm.contact.created', '--workflow', 'wf1'], () => json({ bindingId: 'hb2' }, 201));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].body], ['POST', { eventType: 'host.crm.contact.created', workflowId: 'wf1' }]);
    r = await run(['host-events', 'bind', '--event', 'run.completed', '--workflow', 'wf1'], () => json({}));
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
  });

  it('enable/disable PATCH { enabled }; unbind DELETEs with --yes', async () => {
    let r = await run(['host-events', 'disable', 'hb1'], () => json({ bindingId: 'hb1', enabled: false }));
    assert.deepEqual([r.calls[0].method, r.calls[0].path, r.calls[0].body], ['PATCH', `${HE}/hb1`, { enabled: false }]);
    r = await run(['host-events', 'enable', 'hb1'], () => json({ enabled: true }));
    assert.deepEqual(r.calls[0].body, { enabled: true });
    r = await run(['host-events', 'unbind', 'hb1', '--yes'], () => new Response(null, { status: 204 }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.calls[0].method, r.calls[0].path], ['DELETE', `${HE}/hb1`]);
  });

  it('a 403 exits 4', async () => {
    const r = await run(['host-events', 'list'], forbidden);
    assert.equal(r.code, 4);
  });
});

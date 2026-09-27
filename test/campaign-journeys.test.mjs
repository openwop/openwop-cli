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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so the mock sees the literal /v1/host/openwop-app paths (no discovery fetch).
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });

/** A fetch mock that records every call and answers from `reply(url, init)`. */
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}
const E = '/v1/host/openwop-app/campaign-journeys/enrollments';

describe('campaign-journeys command', () => {
  it('enrollments lists the ledger (optionally by journey)', async () => {
    const cap = capture();
    const r = recorder(() => json({ enrollments: [{ journeyId: 'wf.w', contactId: 'c_1', enrolledAt: '2026-01-01', runId: 'r_1' }] }));
    assert.equal(await runCli(['campaign-journeys', 'enrollments', '--journey', 'wf.w'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [`GET ${E}?journeyId=wf.w`]);
    assert.match(cap.stdout, /wf\.w\s+c_1\s+2026-01-01\s+r_1/);
  });

  it('enrollments --json prints the raw body', async () => {
    const cap = capture();
    const r = recorder(() => json({ enrollments: [] }));
    assert.equal(await runCli(['campaign-journeys', 'enrollments', '--json'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { enrollments: [] });
    assert.equal(r.calls[0].search, '');
  });

  it('reset refuses without --yes, then DELETEs with {journeyId, contactId}', async () => {
    const cap = capture();
    const r = recorder(() => json({ reset: true }));
    assert.equal(await runCli(['campaign-journeys', 'reset', '--journey', 'wf.w', '--contact', 'c_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['campaign-journeys', 'reset', '--journey', 'wf.w'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['campaign-journeys', 'reset', '--journey', 'wf.w', '--contact', 'c_1', '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.equal(r.calls[0].method, 'DELETE');
    assert.equal(r.calls[0].path, E);
    assert.deepEqual(r.calls[0].body, { journeyId: 'wf.w', contactId: 'c_1' });
    assert.match(cap.stdout, /may enroll again/);
  });

  it('a 403 is a legible message with exit 4', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden', message: 'Campaign Journeys is not enabled' }, 403));
    assert.equal(await runCli(['campaign-journeys', 'enrollments'], opts(r.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /HTTP 403(?: \S+)?: Campaign Journeys is not enabled/);
  });
});

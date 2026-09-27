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
    let body;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body, headers: init.headers ?? {}, redirect: init.redirect });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}
const lines = (r) => r.calls.map((c) => `${c.method} ${c.path}${c.search}`);

const W = '/v1/host/openwop-app/webinars/orgs/org_1/events';

describe('webinars command', () => {
  it('list renders counts from GET …/events; --json raw', async () => {
    const cap = capture();
    const r = recorder(() => json({ events: [{ eventId: 'ev_1', provider: 'zoom', title: 'Launch', counts: { registrantCount: 5, attendeeCount: 3, noShowCount: 2 }, pendingPushCount: 1 }] }));
    assert.equal(await runCli(['webinars', 'list', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.match(cap.stdout, /ev_1\s+zoom\s+Launch\s+5\s+3\s+2\s+1/);
    const cap2 = capture();
    assert.equal(await runCli(['webinars', 'list', '--org', 'org_1', '--json'], opts(r.fetchImpl, cap2)), 0);
    assert.equal(JSON.parse(cap2.stdout).events[0].eventId, 'ev_1');
    assert.deepEqual(lines(r), [`GET ${W}`, `GET ${W}`]);
  });

  it('create / bind-form / sync / push-registrants', async () => {
    const cap = capture();
    const r = recorder((u) => json(u.pathname.endsWith('push-registrants') ? { pushed: 2, failed: 0, failures: [] } : { eventId: 'ev_1', ok: true }));
    assert.equal(await runCli(['webinars', 'create', '--org', 'org_1', '--provider-event-id', '812', '--title', 'T', '--starts-at', '2026-10-01T10:00:00Z', '--connection', 'conn_1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['webinars', 'bind-form', 'ev_1', '--org', 'org_1', '--form', 'f_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['webinars', 'sync', 'ev_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli(['webinars', 'push-registrants', 'ev_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(lines(r), [`POST ${W}`, `POST ${W}/ev_1/bind-form`, `POST ${W}/ev_1/sync`, `POST ${W}/ev_1/push-registrants`]);
    assert.deepEqual(r.calls[0].body, { providerEventId: '812', title: 'T', startsAt: '2026-10-01T10:00:00Z', connectionId: 'conn_1' });
    assert.deepEqual(r.calls[1].body, { formId: 'f_1' });
    assert.match(cap.stdout, /Pushed 2 registrant\(s\); 0 failed\./);
  });

  it('push-registrants exits 1 when a registrant failed', async () => {
    const cap = capture();
    const r = recorder(() => json({ pushed: 0, failed: 1, failures: [{ email: 'a@x.test', reason: 'provider_error' }] }));
    assert.equal(await runCli(['webinars', 'push-registrants', 'ev_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 1);
    assert.match(cap.stdout, /failed: a@x\.test — provider_error/);
  });

  it('a 403 is exit 4; missing --provider-event-id / --form are usage errors', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' }, 403));
    assert.equal(await runCli(['webinars', 'create', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(await runCli(['webinars', 'bind-form', 'ev_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.equal(await runCli(['webinars', 'sync', 'ev_1', '--org', 'org_1'], opts(r.fetchImpl, cap)), 4);
    assert.match(cap.stderr, /HTTP 403/);
  });
});

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

describe('analytics summary', () => {
  it('renders the host-aggregated rollup', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/analytics\/orgs\/org_123\/summary$/);
      return jsonResponse({ summary: { total: 42, sessions: 7, byType: { pageview: 30, event: 10, conversion: 2 }, topPaths: [{ path: '/pricing', count: 12 }], utmSources: [{ source: 'google', count: 9 }] } });
    };
    const code = await runCli(['analytics', 'summary', 'org_123'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /total events: 42/);
    assert.match(cap.stdout, /sessions: 7/);
    assert.match(cap.stdout, /pageview=30\s+event=10\s+conversion=2/);
    assert.match(cap.stdout, /\/pricing/);
  });

  it('emits raw host JSON under --json', async () => {
    const cap = capture();
    const body = { summary: { total: 1, sessions: 1, byType: { pageview: 1, event: 0, conversion: 0 }, topPaths: [], utmSources: [] } };
    const code = await runCli(['--json', 'analytics', 'summary', 'org_123'], opts(async () => jsonResponse(body), cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });
});

describe('analytics events (alias usage)', () => {
  it('lists recent events as a table via the `usage` alias', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/analytics\/orgs\/org_123\/events$/);
      return jsonResponse({ events: [{ eventId: 'evt:1', type: 'pageview', path: '/home', sessionKey: 's_a', ts: '2026-06-13T00:00:00Z' }] });
    };
    const code = await runCli(['usage', 'events', 'org_123'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /pageview\s+\/home\s+s_a\s+evt:1/);
  });

  it('handles an empty event set', async () => {
    const cap = capture();
    const code = await runCli(['analytics', 'events', 'org_123'], opts(async () => jsonResponse({ events: [] }), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No analytics events/);
  });
});

describe('analytics collect (public beacon)', () => {
  it('POSTs an event WITHOUT auth and reports recorded', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/public-analytics\/org_123\/collect$/);
      // PUBLIC beacon — no bearer attached.
      assert.equal(init.headers?.authorization, undefined);
      assert.deepEqual(JSON.parse(init.body), { sessionKey: 's_abc', type: 'pageview', path: '/pricing' });
      return jsonResponse({ recorded: true, eventId: 'evt:9' }, 201);
    };
    const code = await runCli(['analytics', 'collect', 'org_123', '--session', 's_abc', '--type', 'pageview', '--path', '/pricing'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Recorded event evt:9/);
  });

  it('honestly reports a 202 consent-declined beacon', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ recorded: false, reason: 'consent' }, 202);
    const code = await runCli(['analytics', 'collect', 'org_123', '--session', 's_abc'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Not recorded — analytics consent not granted/);
  });

  it('requires --session (exit 2, no request)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['analytics', 'collect', 'org_123'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
  });

  it('rejects an unknown --type locally (exit 2)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['analytics', 'collect', 'org_123', '--session', 's', '--type', 'click'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /--type must be one of/);
  });
});

describe('analytics capability honesty', () => {
  it('fails closed legibly when analytics is not served (404)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'Not found.' }, 404);
    const code = await runCli(['analytics', 'summary', 'org_x'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /does not serve analytics for this org/);
  });
});

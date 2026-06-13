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

describe('consent command', () => {
  it('shows the tenant policy (human)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/consent\/orgs\/org_1\/policy$/);
      return jsonResponse({ policy: { tenantId: 't1', regulatedRegions: ['EU', 'UK'], defaultMode: 'opt-out' } });
    };
    const code = await runCli(['consent', 'policy', 'org_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /tenantId: t1/);
    assert.match(cap.stdout, /defaultMode: opt-out/);
    assert.match(cap.stdout, /regulatedRegions: EU, UK/);
  });

  it('shows the policy as raw JSON with --json', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ policy: { tenantId: 't1', regulatedRegions: [], defaultMode: 'opt-in' } });
    const code = await runCli(['consent', 'policy', 'org_1', '--json'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), { policy: { tenantId: 't1', regulatedRegions: [], defaultMode: 'opt-in' } });
  });

  it('sets the policy via PUT (defaultMode + regions)', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'PUT');
      assert.match(new URL(url).pathname, /\/consent\/orgs\/org_1\/policy$/);
      assert.deepEqual(JSON.parse(init.body), { defaultMode: 'opt-out', regulatedRegions: ['EU', 'UK'] });
      return jsonResponse({ policy: { tenantId: 't1', regulatedRegions: ['EU', 'UK'], defaultMode: 'opt-out' } });
    };
    const code = await runCli(
      ['consent', 'set-policy', 'org_1', '--default-mode', 'opt-out', '--regulated-region', 'EU', '--regulated-region', 'UK'],
      opts(fetchImpl, cap),
    );
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Updated consent policy: defaultMode=opt-out/);
  });

  it('rejects an invalid --default-mode (usage error, no request)', async () => {
    const cap = capture();
    let called = false;
    const fetchImpl = async () => { called = true; return jsonResponse({}); };
    const code = await runCli(['consent', 'set-policy', 'org_1', '--default-mode', 'maybe'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
  });

  it('errors when set-policy has nothing to change', async () => {
    const cap = capture();
    const code = await runCli(['consent', 'set-policy', 'org_1'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
  });

  it('lists records as a table', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/consent\/orgs\/org_1\/records$/);
      return jsonResponse({ records: [
        { subjectKey: 'visitor-abc', region: 'EU', categories: { necessary: true, analytics: true, marketing: false }, source: 'public', ts: '2026-06-11' },
      ] });
    };
    const code = await runCli(['consent', 'records', 'org_1'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /visitor-abc/);
    assert.match(cap.stdout, /analytics=yes/);
    assert.match(cap.stdout, /marketing=no/);
  });

  it('reports empty records cleanly', async () => {
    const cap = capture();
    const code = await runCli(['consent', 'records', 'org_1'], opts(async () => jsonResponse({ records: [] }), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No consent records/);
  });

  it('gets one subject record', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/consent\/orgs\/org_1\/subjects\/visitor-abc$/);
      return jsonResponse({ record: { subjectKey: 'visitor-abc', categories: { necessary: true, analytics: false, marketing: false }, source: 'public', ts: '2026-06-11' } });
    };
    const code = await runCli(['consent', 'get', 'org_1', 'visitor-abc'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /subjectKey: visitor-abc/);
    assert.match(cap.stdout, /categories: necessary=yes analytics=no marketing=no/);
  });

  it('reports a missing subject record', async () => {
    const cap = capture();
    const code = await runCli(['consent', 'get', 'org_1', 'nobody'], opts(async () => jsonResponse({ record: null }), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No consent record for subject nobody/);
  });

  it('refuses erase without --yes (no request)', async () => {
    const cap = capture();
    let called = false;
    const code = await runCli(['consent', 'erase', 'org_1', 'visitor-abc'], opts(async () => { called = true; return jsonResponse({}); }, cap));
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(cap.stderr, /Refusing to erase/);
  });

  it('erases a subject via DELETE with --yes', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'DELETE');
      assert.match(new URL(url).pathname, /\/consent\/orgs\/org_1\/subjects\/visitor-abc$/);
      return jsonResponse({ ok: true, consentRecord: true });
    };
    const code = await runCli(['consent', 'erase', 'org_1', 'visitor-abc', '--yes'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Erased subject visitor-abc \(consent record purged/);
  });

  it('reads public consent (unauthed, no Authorization header)', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.match(new URL(url).pathname, /\/public-consent\/org_1\/visitor-abc$/);
      assert.equal(init.headers.authorization, undefined);
      return jsonResponse({ recorded: false, defaultMode: 'opt-in', categories: { necessary: true, analytics: false, marketing: false } });
    };
    const code = await runCli(['consent', 'public', 'get', 'org_1', 'visitor-abc'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /recorded: no/);
    assert.match(cap.stdout, /defaultMode: opt-in/);
  });

  it('records public consent via POST', async () => {
    const cap = capture();
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/public-consent\/org_1$/);
      assert.deepEqual(JSON.parse(init.body), { subjectKey: 'visitor-abc', categories: { analytics: true, marketing: false } });
      return jsonResponse({ ok: true, categories: { necessary: true, analytics: true, marketing: false } }, 201);
    };
    const code = await runCli(
      ['consent', 'public', 'record', 'org_1', 'visitor-abc', '--category', 'analytics=true', '--category', 'marketing=false'],
      opts(fetchImpl, cap),
    );
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Recorded consent for visitor-abc: necessary=yes analytics=yes marketing=no/);
  });

  it('rejects a malformed --category', async () => {
    const cap = capture();
    const code = await runCli(['consent', 'public', 'record', 'org_1', 'v', '--category', 'analytics'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
  });

  it('fails closed with a legible message on the host 404 (consent toggle off)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ error: 'not_found', message: 'Not found.' }, 404);
    const code = await runCli(['consent', 'policy', 'org_1'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /consent unavailable.*toggle/s);
  });

  it('rejects an unknown subcommand', async () => {
    const cap = capture();
    const code = await runCli(['consent', 'bogus'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /Unknown consent command: bogus/);
  });
});

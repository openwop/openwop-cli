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

describe('toggles list', () => {
  it('renders the host-resolved assignments verbatim (status/enabled/variant)', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/host\/sample\/feature-toggles\/assignments$/);
      return jsonResponse({
        assignments: [
          { id: 'crm.triageAgent', status: 'beta', enabled: true, variant: 'B', bindings: [{ slot: 'crm.triage', ref: { kind: 'agent', name: 'feature.crm/triage-v2', version: '1.2.0' } }] },
          { id: 'billing.newUI', status: 'off', enabled: false, variant: null },
        ],
      });
    };
    const code = await runCli(['toggles', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /crm\.triageAgent\s+beta\s+yes\s+B\s+1/);
    assert.match(cap.stdout, /billing\.newUI\s+off\s+no\s+—\s+0/);
  });

  it('emits the raw host JSON under --json', async () => {
    const cap = capture();
    const body = { assignments: [{ id: 't1', status: 'on', enabled: true, variant: null }] };
    const fetchImpl = async () => jsonResponse(body);
    const code = await runCli(['--json', 'toggles', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('handles an empty assignment set', async () => {
    const cap = capture();
    const code = await runCli(['toggles', 'list'], opts(async () => jsonResponse({ assignments: [] }), cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No feature toggles resolved/);
  });
});

describe('toggles get', () => {
  it('renders one resolved assignment incl. bindings', async () => {
    const cap = capture();
    const fetchImpl = async (url) => {
      assert.match(new URL(url).pathname, /\/assignments\/crm\.triageAgent$/);
      return jsonResponse({ id: 'crm.triageAgent', status: 'beta', enabled: true, variant: 'B', bindings: [{ slot: 'crm.triage', ref: { kind: 'agent', name: 'feature.crm/triage-v2', version: '1.2.0' } }] });
    };
    const code = await runCli(['toggles', 'get', 'crm.triageAgent'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /status: beta/);
    assert.match(cap.stdout, /enabled: yes/);
    assert.match(cap.stdout, /variant: B/);
    assert.match(cap.stdout, /crm\.triage → agent:feature\.crm\/triage-v2@1\.2\.0/);
  });

  it('maps an unknown toggle 404 to a legible usage error (exit 2)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'No such feature toggle.' }, 404);
    const code = await runCli(['toggles', 'get', 'nope'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /No such feature toggle: nope/);
  });

  it('requires a toggleId (exit 2)', async () => {
    const cap = capture();
    const code = await runCli(['toggles', 'get'], opts(async () => jsonResponse({}), cap));
    assert.equal(code, 2);
    assert.match(cap.stdout, /Usage: openwop toggles get/);
  });
});

describe('toggles capability honesty', () => {
  it('fails closed legibly when the surface is not served (404 on collection)', async () => {
    const cap = capture();
    const fetchImpl = async () => jsonResponse({ message: 'not found' }, 404);
    const code = await runCli(['toggles', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /does not serve the feature-toggle surface/);
  });
});

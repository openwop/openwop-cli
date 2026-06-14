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

// triggerBridge advertised via capabilities.triggerBridge (with optional ingestion).
function wellKnown({ bridge = true, ingestion = ['webhook', 'email', 'form'], registrationEndpoint = true } = {}) {
  const capabilities = {};
  if (bridge) {
    capabilities.triggerBridge = { supported: true, sources: ['webhook', 'email', 'form'] };
    if (ingestion) capabilities.triggerBridge.ingestion = { externalSources: ingestion, registrationEndpoint };
  }
  return { protocolVersion: '1.0', capabilities };
}

function host(handler, wkOpts = {}) {
  return async (url, init) => {
    if (new URL(url).pathname === '/.well-known/openwop') return jsonResponse(wellKnown(wkOpts));
    return handler(url, init);
  };
}

describe('triggers register', () => {
  it('POSTs the registration and renders the binding', async () => {
    const cap = capture();
    const fetchImpl = host(async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(new URL(url).pathname, /\/v1\/trigger-subscriptions$/);
      const body = JSON.parse(init.body);
      assert.equal(body.source, 'webhook');
      assert.equal(body.workflowId, 'wf_intake');
      assert.equal(body.dedupEnabled, true);
      assert.deepEqual(body.verification, { mode: 'required' });
      return jsonResponse({ subscription: { subscriptionId: 'sub_1', source: 'webhook', state: 'active' }, binding: { ingestUrl: 'https://h/ingest/abc', secretFingerprint: 'fp_xyz' } });
    });
    const code = await runCli(['triggers', 'register', '--source', 'webhook', '--workflow', 'wf_intake', '--dedup', '--verification', 'required'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /Registered webhook subscription sub_1/);
    assert.match(cap.stdout, /ingestUrl: https:\/\/h\/ingest\/abc/);
    assert.match(cap.stdout, /secretFingerprint: fp_xyz/);
  });

  it('warns the one-time binding secret is not stored', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ subscription: { subscriptionId: 'sub_2', source: 'webhook', state: 'active' }, binding: { ingestUrl: 'https://h/i', secret: 'whsec_ONE_TIME' } }));
    const code = await runCli(['triggers', 'register', '--source', 'webhook', '--workflow', 'wf'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /whsec_ONE_TIME/);
    assert.match(cap.stderr, /shown ONCE/);
  });

  it('refuses a source the host does not externally-ingest (exit 1)', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({}), { ingestion: ['webhook'] });
    const code = await runCli(['triggers', 'register', '--source', 'email', '--workflow', 'wf'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not externally-ingest the 'email' source/);
  });

  it('rejects an invalid --source (exit 2) and requires --workflow (exit 2)', async () => {
    let cap = capture();
    let code = await runCli(['triggers', 'register', '--source', 'sms', '--workflow', 'wf'], opts(host(async () => jsonResponse({})), cap));
    assert.equal(code, 2);
    assert.match(cap.stderr, /--source must be one of/);
    cap = capture();
    code = await runCli(['triggers', 'register', '--source', 'webhook'], opts(host(async () => jsonResponse({})), cap));
    assert.equal(code, 2);
  });

  it('refuses register when registrationEndpoint is not advertised (exit 1)', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({}), { registrationEndpoint: false });
    const code = await runCli(['triggers', 'register', '--source', 'webhook', '--workflow', 'wf'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /registrationEndpoint is false/);
  });

  it('surfaces a host 403 (cannot bind workflow) as fail-closed exit 1', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ message: 'forbidden' }, 403));
    const code = await runCli(['triggers', 'register', '--source', 'webhook', '--workflow', 'wf_nope'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /cannot bind workflow wf_nope/);
  });
});

describe('triggers list / get', () => {
  it('renders the subscriptions table', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      assert.match(new URL(url).pathname, /\/v1\/trigger-subscriptions$/);
      return jsonResponse({ subscriptions: [
        { subscriptionId: 'sub_1', source: 'webhook', state: 'active', workflowId: 'wf_intake', dedupEnabled: true, createdAt: '2026-06-14' },
      ] });
    });
    const code = await runCli(['triggers', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /sub_1\s+webhook\s+active\s+wf_intake\s+yes/);
  });

  it('passes --state/--source query filters and reports empty', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      const u = new URL(url);
      assert.match(u.search, /state=paused/);
      assert.match(u.search, /source=webhook/);
      return jsonResponse({ subscriptions: [] });
    });
    const code = await runCli(['triggers', 'list', '--state', 'paused', '--source', 'webhook'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.match(cap.stdout, /No trigger subscriptions in state paused for source webhook/);
  });

  it('get reflects state in the exit code (active 0, dead-lettered 1)', async () => {
    const capA = capture();
    let code = await runCli(['triggers', 'get', 's'], opts(host(async () => jsonResponse({ subscriptionId: 's', source: 'webhook', state: 'active' })), capA));
    assert.equal(code, 0, capA.stderr);
    const capD = capture();
    code = await runCli(['triggers', 'get', 's'], opts(host(async () => jsonResponse({ subscriptionId: 's', state: 'dead-lettered' })), capD));
    assert.equal(code, 1);
  });

  it('get falls back to the list when the single-GET 404s', async () => {
    const cap = capture();
    const fetchImpl = host(async (url) => {
      const p = new URL(url).pathname;
      if (/\/v1\/trigger-subscriptions\/sub_9$/.test(p)) return jsonResponse({ message: 'no single GET' }, 404);
      return jsonResponse({ subscriptions: [{ subscriptionId: 'sub_9', source: 'form', state: 'paused' }] });
    });
    const code = await runCli(['triggers', 'get', 'sub_9'], opts(fetchImpl, cap));
    assert.equal(code, 3, cap.stderr); // paused → 3
    assert.match(cap.stdout, /subscriptionId: sub_9/);
  });

  it('fails closed (exit 1) when the bridge is not advertised', async () => {
    const cap = capture();
    const fetchImpl = host(async () => jsonResponse({ subscriptions: [] }), { bridge: false });
    const code = await runCli(['triggers', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 1);
    assert.match(cap.stderr, /does not advertise the trigger bridge/);
  });
});

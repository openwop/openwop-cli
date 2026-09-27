// site-config, runtime-posture, maintenance, menu-config — the small super-admin groups.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts, forbidden } from './helpers/mockHost.mjs';

describe('site-config', () => {
  it('public is sent without credentials', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { enabled: true, orgId: 'system', slug: 'home' } }));
    assert.equal(await runCli(['site-config', 'public'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, '/v1/host/openwop-app/public-site-config');
    assert.equal(calls[0].headers.authorization, undefined);
    assert.match(cap.stdout, /enabled \(org system, slug home\)/);
  });
  it('set PUTs {enabled} and --json echoes the body', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { enabled: false } }));
    assert.equal(await runCli(['--json', 'site-config', 'set', '--enabled', 'false'], opts(fetchImpl, cap)), 0);
    assert.deepEqual([calls[0].method, calls[0].body], ['PUT', { enabled: false }]);
    assert.deepEqual(JSON.parse(cap.stdout), { enabled: false });
  });
  it('get fails closed (exit 4) without super-admin', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => forbidden);
    assert.equal(await runCli(['site-config', 'get'], opts(fetchImpl, cap)), 4);
    assert.match(cap.stderr, /Site configuration requires a super-admin principal/);
  });
});

describe('runtime-posture', () => {
  it('get renders the live posture', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { available: true, project: 'p', region: 'r', service: 's', servingRevision: 'rev-1', serving: { posture: 'warm' }, pendingRevision: null, rollout: 'settled' } }));
    assert.equal(await runCli(['runtime-posture'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, '/v1/host/openwop-app/runtime-posture');
    assert.match(cap.stdout, /posture:\s+warm/);
  });
  it('request --cold posts exactly {warm:false} and prints the commands', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { from: 'warm', to: 'cold', commands: ['gcloud run services update s'], note: 'Nothing has been applied.' } }));
    assert.equal(await runCli(['runtime-posture', 'request', '--cold'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(calls[0].body, { warm: false });
    assert.match(cap.stdout, /gcloud run services update s/);
    assert.equal(await runCli(['runtime-posture', 'request'], opts(fetchImpl, cap)), 2);
  });
  it('fails closed with exit 4', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => forbidden);
    assert.equal(await runCli(['runtime-posture'], opts(fetchImpl, cap)), 4);
  });
});

describe('maintenance', () => {
  it('rekey-member-subjects posts the optional tenant', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { tenantId: 't1', scanned: 4, rekeyed: 2, skipped: 2 } }));
    assert.equal(await runCli(['maintenance', 'rekey-member-subjects', '--tenant', 't1'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual([calls[0].path, calls[0].body], ['/v1/host/openwop-app/maintenance/rekey-member-subjects', { tenantId: 't1' }]);
    assert.match(cap.stdout, /rekeyed=2/);
  });
  it('fails closed with exit 4', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => forbidden);
    assert.equal(await runCli(['maintenance', 'rekey-member-subjects'], opts(fetchImpl, cap)), 4);
  });
});

describe('menu-config', () => {
  it('get prints the bundle JSON', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => ({ body: { tenant: { items: {}, headers: [] }, user: { items: {}, headers: [] } } }));
    assert.equal(await runCli(['menu-config'], opts(fetchImpl, cap)), 0);
    assert.ok(JSON.parse(cap.stdout).tenant);
  });
  it('set me wraps a bare config into {config}', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { config: {} } }));
    assert.equal(await runCli(['menu-config', 'set', 'me', '--body', '{"items":{},"headers":[]}'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual([calls[0].method, calls[0].path, calls[0].body], ['PUT', '/v1/host/openwop-app/menu-config/me', { config: { items: {}, headers: [] } }]);
  });
  it('set tenant reads the ETag and sends it as If-Match', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => (c.method === 'GET' ? { body: {}, headers: { etag: '"v7"' } } : { body: { config: {} } }));
    assert.equal(await runCli(['menu-config', 'set', 'tenant', '--body', '{"config":{"items":{},"headers":[]}}'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[1].path, '/v1/host/openwop-app/menu-config/tenant');
    assert.equal(calls[1].headers['if-match'], '"v7"');
  });
  it('set tenant fails closed with exit 4', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost((c) => (c.method === 'GET' ? { body: {} } : forbidden));
    assert.equal(await runCli(['menu-config', 'set', 'tenant', '--body', '{}'], opts(fetchImpl, cap)), 4);
  });
});

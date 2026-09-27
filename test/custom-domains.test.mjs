import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts } from './helpers/mockHost.mjs';

const base = '/v1/host/openwop-app/custom-domains/orgs/o%2F1/domains';

describe('custom-domains', () => {
  it('requires --org', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => ({ body: {} }));
    assert.equal(await runCli(['custom-domains', 'list'], opts(fetchImpl, cap)), 2);
  });

  it('lists domains', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { domains: [{ hostname: 'pages.acme.com', status: 'pending', lastError: 'TXT missing' }] } }));
    assert.equal(await runCli(['custom-domains', 'list', '--org', 'o/1'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, base);
    assert.match(cap.stdout, /pages\.acme\.com\s+pending\s+TXT missing/);
  });

  it('add posts the hostname and prints the TXT instruction', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { domain: { hostname: 'pages.acme.com', status: 'pending', verificationToken: 'tok123' } } }));
    assert.equal(await runCli(['custom-domains', 'add', 'pages.acme.com', '--org', 'o/1'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { hostname: 'pages.acme.com' });
    assert.match(cap.stdout, /_openwop-verify\.pages\.acme\.com = tok123/);
  });

  it('verify exits 3 while not live, 0 when live; --json path', async () => {
    const cap = capture();
    let status = 'pending';
    const { calls, fetchImpl } = mockHost(() => ({ body: { domain: { hostname: 'h.io', status } } }));
    assert.equal(await runCli(['custom-domains', 'verify', 'h.io', '--org', 'o/1'], opts(fetchImpl, cap)), 3);
    assert.equal(calls[0].path, `${base}/h.io/verify`);
    status = 'live';
    const cap2 = capture();
    assert.equal(await runCli(['--json', 'custom-domains', 'verify', 'h.io', '--org', 'o/1'], opts(fetchImpl, cap2)), 0);
    assert.equal(JSON.parse(cap2.stdout).domain.status, 'live');
  });

  it('remove needs --yes; 403 → exit 4', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 403, body: { message: 'Missing required scope: workspace:write' } }));
    assert.equal(await runCli(['custom-domains', 'remove', 'h.io', '--org', 'o/1'], opts(fetchImpl, cap)), 2);
    assert.equal(calls.length, 0);
    assert.equal(await runCli(['custom-domains', 'remove', 'h.io', '--org', 'o/1', '--yes'], opts(fetchImpl, cap)), 4);
    assert.equal(calls[0].method, 'DELETE');
  });
});

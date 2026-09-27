// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts, forbidden } from './helpers/mockHost.mjs';

describe('vault', () => {
  it('lists refs across every bucket, never values', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: {
      tenantSecrets: [{ credentialRef: 'slack-bot', kind: 'raw', revealable: true }],
      hostSecrets: [{ credentialRef: 'billing:stripe-key', kind: 'raw', revealable: true }],
      connections: [{ connectionId: 'c1', provider: 'google', status: 'active' }],
      oauthClients: [{ provider: 'github', clientId: 'x', configured: true }],
      apiKeys: [{ keyId: 'dk:1', name: 'ci' }],
    } }));
    const code = await runCli(['vault', 'list'], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].path, '/v1/host/openwop-app/vault');
    assert.match(cap.stdout, /tenant\s+slack-bot\s+raw/);
    assert.match(cap.stdout, /host\s+billing:stripe-key/);
    assert.match(cap.stdout, /connection:c1\s+connection\/google\s+active/);
    assert.match(cap.stdout, /oauth-client:github/);
    assert.match(cap.stdout, /dk:1\s+developer-key\s+active/);
  });

  it('--json emits the host body verbatim', async () => {
    const cap = capture();
    const body = { tenantSecrets: [], hostSecrets: [], connections: [], oauthClients: [], apiKeys: [] };
    const { fetchImpl } = mockHost(() => ({ body }));
    assert.equal(await runCli(['--json', 'vault', 'list'], opts(fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('set reads the value from --value-file and never prints it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-vault-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'sk_live_supersecret\n');
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { credentialRef: 'billing:stripe-key', stored: true } }));
    const code = await runCli(['vault', 'set', 'billing:stripe-key', '--scope', 'host', '--value-file', file], opts(fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/v1/host/openwop-app/vault/secrets');
    assert.deepEqual(calls[0].body, { value: 'sk_live_supersecret', scope: 'host', credentialRef: 'billing:stripe-key' });
    assert.doesNotMatch(cap.stdout + cap.stderr, /supersecret/);
  });

  it('rotate URL-encodes the ref', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-vault-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'new');
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { credentialRef: 'a:b', rotated: true } }));
    assert.equal(await runCli(['vault', 'rotate', 'a:b', '--value-file', file], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, '/v1/host/openwop-app/vault/secrets/a%3Ab/rotate');
    assert.deepEqual(calls[0].body, { value: 'new' });
  });

  it('delete requires --yes and passes scope + force', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { deleted: true } }));
    assert.equal(await runCli(['vault', 'delete', 'x'], opts(fetchImpl, cap)), 2);
    assert.equal(calls.length, 0);
    assert.equal(await runCli(['vault', 'delete', 'x', '--scope', 'host', '--force', '--yes'], opts(fetchImpl, cap)), 0);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].search, '?scope=host&force=true');
  });

  it('refuses reveal locally (never prints a secret)', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { value: 'nope' } }));
    assert.equal(await runCli(['vault', 'reveal', 'x'], opts(fetchImpl, cap)), 2);
    assert.equal(calls.length, 0);
    assert.match(cap.stderr, /never prints a secret/);
  });

  it('fails closed with exit 4 and an actionable message without super-admin', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => forbidden);
    assert.equal(await runCli(['vault', 'list'], opts(fetchImpl, cap)), 4);
    assert.match(cap.stderr, /super-admin principal/);
    assert.match(cap.stderr, /OPENWOP_SUPERADMIN_TENANTS/);
  });
});

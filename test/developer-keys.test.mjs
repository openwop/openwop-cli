import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts } from './helpers/mockHost.mjs';

describe('developer-keys', () => {
  it('lists keys (public fields only)', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { keys: [{ keyId: 'dk:1', name: 'CI', scopes: ['runs:write'], createdAt: '2026-01-01' }, { keyId: 'dk:2', name: 'old', scopes: [], revokedAt: 'x' }] } }));
    assert.equal(await runCli(['developer-keys', 'list'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, '/v1/host/openwop-app/developer-keys');
    assert.match(cap.stdout, /dk:1\s+CI\s+runs:write\s+active/);
    assert.match(cap.stdout, /dk:2\s+old\s+revoked/);
  });

  it('create prints the one-time token once with a warning', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { token: 'owk_abc', key: { keyId: 'dk:9', name: 'CI' } } }));
    assert.equal(await runCli(['developer-keys', 'create', '--name', 'CI', '--scope', 'runs:write', '--expires-at', '2027-01-01T00:00:00Z'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { name: 'CI', scopes: ['runs:write'], expiresAt: '2027-01-01T00:00:00Z' });
    assert.equal(cap.stdout.match(/owk_abc/g).length, 1);
    assert.match(cap.stderr, /shown ONCE/);
  });

  it('create --json emits the host body', async () => {
    const cap = capture();
    const body = { token: 'owk_x', key: { keyId: 'dk:1' } };
    const { fetchImpl } = mockHost(() => ({ status: 201, body }));
    assert.equal(await runCli(['--json', 'developer-keys', 'create', '--name', 'n'], opts(fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('revoke needs --yes and URL-encodes the id', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 204 }));
    assert.equal(await runCli(['developer-keys', 'revoke', 'dk:1'], opts(fetchImpl, cap)), 2);
    assert.equal(await runCli(['developer-keys', 'revoke', 'dk:1', '--yes'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].path, '/v1/host/openwop-app/developer-keys/dk%3A1');
  });

  it('401 → exit 4 with a sign-in hint', async () => {
    const cap = capture();
    const { fetchImpl } = mockHost(() => ({ status: 401, body: { error: 'unauthenticated', message: 'Managing an API key requires an authenticated principal.' } }));
    assert.equal(await runCli(['developer-keys', 'list'], opts(fetchImpl, cap)), 4);
    assert.match(cap.stderr, /signed-in user/);
  });
});

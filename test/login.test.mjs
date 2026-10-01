import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts } from './helpers/mockHost.mjs';

const START = '/api/v1/host/openwop-app/cli-login/start';
const POLL = '/api/v1/host/openwop-app/cli-login/poll';
const LOGOUT = '/api/v1/host/openwop-app/cli-login/logout';
const TOKEN = 'owk_the-secret-the-host-issued';

const home = () => mkdtempSync(join(tmpdir(), 'owp-login-'));
const configOf = (dir) => JSON.parse(readFileSync(join(dir, '.openwop', 'config.json'), 'utf8'));
const env = (dir, extra = {}) => ({ OPENWOP_CONFIG_HOME: dir, OPENWOP_BASE_URL: 'https://host.example/api', ...extra });
const authOf = (call) => call.headers.authorization ?? call.headers.Authorization;

/** A host that answers `pending` `pendingPolls` times, then `final`. */
function host(final, pendingPolls = 1) {
  let polls = 0;
  return mockHost((call) => {
    if (call.path === START) return { status: 201, body: { deviceCode: 'owcl_device', userCode: 'BCDF-GHJK', expiresIn: 600, interval: 0, verificationPath: '/access?tab=api-keys' } };
    if (call.path === POLL) { polls += 1; return polls <= pendingPolls ? { body: { status: 'pending', interval: 0 } } : final; }
    return { status: 404, body: { error: 'not_found' } };
  });
}

describe('login', () => {
  it('shows the code and where to type it, waits, then saves the key — and never prints it', async () => {
    const dir = home(); const cap = capture();
    const { calls, fetchImpl } = host({ body: { status: 'approved', token: TOKEN, key: { keyId: 'dk:1', name: 'CLI: laptop', expiresAt: '2026-10-31T00:00:00Z' } } }, 2);
    assert.equal(await runCli(['login', '--label', 'laptop'], opts(fetchImpl, cap, env(dir))), 0, cap.stderr);
    assert.deepEqual(calls[0].body, { label: 'laptop' });
    assert.equal(calls.filter((c) => c.path === POLL).length, 3);
    assert.deepEqual(calls[1].body, { deviceCode: 'owcl_device' });
    assert.match(cap.stderr, /BCDF-GHJK/);
    assert.match(cap.stderr, /https:\/\/host\.example\/access\?tab=api-keys/);
    assert.doesNotMatch(cap.stderr, /owcl_device/);
    const cfg = configOf(dir);
    assert.equal(cfg.host.apiKey, TOKEN);
    assert.equal(cfg.host.baseUrl, 'https://host.example/api');
    assert.doesNotMatch(cap.stdout + cap.stderr, new RegExp(TOKEN));
    assert.match(cap.stdout, /Signed in/);
    assert.match(cap.stdout, /2026-10-31/);
  });

  it('sends NO credential to start or poll, even when a key is already configured', async () => {
    const dir = home(); const cap = capture();
    const { calls, fetchImpl } = host({ body: { status: 'approved', token: TOKEN, key: {} } });
    assert.equal(await runCli(['login'], opts(fetchImpl, cap, env(dir, { OPENWOP_API_KEY: 'owk_an-old-dead-key' }))), 0, cap.stderr);
    for (const c of calls.filter((x) => x.path === START || x.path === POLL)) assert.equal(authOf(c), undefined, `${c.path} carried a credential`);
  });

  it('--json prints one document on stdout, without the token', async () => {
    const dir = home(); const cap = capture();
    const { fetchImpl } = host({ body: { status: 'approved', token: TOKEN, key: { keyId: 'dk:1', name: 'CLI: x', expiresAt: '2026-10-31T00:00:00Z' } } });
    assert.equal(await runCli(['--json', 'login'], opts(fetchImpl, cap, env(dir))), 0, cap.stderr);
    const doc = JSON.parse(cap.stdout);
    assert.equal(doc.status, 'signed-in');
    assert.equal(doc.keyId, 'dk:1');
    assert.doesNotMatch(cap.stdout, new RegExp(TOKEN));
  });

  it('a denied sign-in exits 1 and saves nothing', async () => {
    const dir = home(); const cap = capture();
    const { fetchImpl } = host({ body: { status: 'denied' } });
    assert.equal(await runCli(['login'], opts(fetchImpl, cap, env(dir))), 1);
    assert.match(cap.stderr, /denied/);
    assert.equal(existsSync(join(dir, '.openwop', 'config.json')), false);
  });

  it('an expired sign-in (poll 404) and a failed mint both exit 1 with what to do', async () => {
    for (const [final, re] of [[{ status: 404, body: { error: 'not_found' } }, /expired or was already used/], [{ body: { status: 'failed', message: 'API keys are turned off for this workspace.' } }, /turned off/]]) {
      const dir = home(); const cap = capture();
      const { fetchImpl } = host(final);
      assert.equal(await runCli(['login'], opts(fetchImpl, cap, env(dir))), 1);
      assert.match(cap.stderr, re);
      assert.equal(existsSync(join(dir, '.openwop', 'config.json')), false);
    }
  });

  it('a host without the extension fails closed: exit 1, a legible reason, no guess', async () => {
    const dir = home(); const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 404, body: { error: 'not_found' } }));
    assert.equal(await runCli(['login'], opts(fetchImpl, cap, env(dir))), 1);
    assert.match(cap.stderr, /does not serve the CLI sign-in/);
    assert.equal(calls.filter((c) => c.path === POLL).length, 0);
  });

  it('a bad --timeout is a usage error and calls nothing', async () => {
    const cap = capture();
    const { calls, fetchImpl } = host({ body: { status: 'denied' } });
    assert.equal(await runCli(['login', '--timeout', 'soon'], opts(fetchImpl, cap, env(home()))), 2);
    assert.equal(calls.length, 0);
  });
});

describe('logout', () => {
  const signedIn = (dir) => { mkdirSync(join(dir, '.openwop'), { recursive: true }); writeFileSync(join(dir, '.openwop', 'config.json'), JSON.stringify({ host: { baseUrl: 'https://host.example/api', apiKey: TOKEN }, keep: 'me' })); };

  it('revokes the SAVED key on the host, then removes it locally and keeps the rest of the config', async () => {
    const dir = home(); signedIn(dir); const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => (c.path === LOGOUT ? { status: 204 } : { status: 404 }));
    // A different key in the environment must not be the one that gets revoked.
    assert.equal(await runCli(['logout'], opts(fetchImpl, cap, env(dir, { OPENWOP_API_KEY: 'owk_some-other-key' }))), 0, cap.stderr);
    assert.equal(calls[0].path, LOGOUT);
    assert.equal(authOf(calls[0]), `Bearer ${TOKEN}`);
    const cfg = configOf(dir);
    assert.equal(cfg.host.apiKey, undefined);
    assert.equal(cfg.host.baseUrl, 'https://host.example/api');
    assert.equal(cfg.keep, 'me');
    assert.match(cap.stdout, /Signed out/);
  });

  it('when the host no longer knows the key (401) it is still removed locally, and says so', async () => {
    const dir = home(); signedIn(dir); const cap = capture();
    const { fetchImpl } = mockHost(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    assert.equal(await runCli(['logout'], opts(fetchImpl, cap, env(dir))), 0, cap.stderr);
    assert.equal(configOf(dir).host.apiKey, undefined);
    assert.match(cap.stdout, /no longer recognised/);
  });

  it('a host with no sign-out route removes the key locally and says it was NOT revoked there', async () => {
    const dir = home(); signedIn(dir); const cap = capture();
    const { fetchImpl } = mockHost(() => ({ status: 404, body: { error: 'not_found' } }));
    assert.equal(await runCli(['--json', 'logout'], opts(fetchImpl, cap, env(dir))), 0, cap.stderr);
    const doc = JSON.parse(cap.stdout);
    assert.equal(doc.revokedOnHost, false);
    assert.match(doc.note, /NOT revoked/);
  });

  it('with nothing saved it says so and calls nothing', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 204 }));
    assert.equal(await runCli(['logout'], opts(fetchImpl, cap, env(home()))), 0);
    assert.match(cap.stdout, /Not signed in/);
    assert.equal(calls.length, 0);
  });
});

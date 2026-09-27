// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const E = '/v1/host/openwop-app/email/orgs/org_1';

describe('email — settings, provider status, webhooks, engagement', () => {
  it('settings set PUTs the sender address', async () => {
    const host = mockHost(() => json({ senderAddress: 'a@b.co', configured: true }));
    const cap = capture();
    assert.equal(await runCli(['email', 'settings', 'set', '--org', 'org_1', '--sender-address', 'a@b.co'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, `${E}/settings`);
    assert.deepEqual(host.last().body, { senderAddress: 'a@b.co' });
  });

  it('provider-status renders a table; --json is raw', async () => {
    const body = { providers: [{ provider: 'sendgrid', connected: true }], defaultProvider: null, senderAddress: null };
    const host = mockHost(() => json(body));
    let cap = capture();
    await runCli(['email', 'provider-status', '--org', 'org_1'], opts(host, cap));
    assert.match(cap.stdout, /sendgrid\s+true/);
    cap = capture();
    await runCli(['email', 'provider-status', '--org', 'org_1', '--json'], opts(host, cap));
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('webhooks add reads the verification secret from a file and never prints it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-email-'));
    const f = join(dir, 'secret.txt');
    writeFileSync(f, 's3cr3t-value\n');
    const host = mockHost(() => json({ webhookId: 'wh1', provider: 'postmark', ingestPath: '/x' }, 201));
    const cap = capture();
    assert.equal(await runCli(['email', 'webhooks', 'add', '--org', 'org_1', '--provider', 'postmark', '--verification-secret-file', f], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${E}/webhook-configs`);
    assert.deepEqual(host.last().body, { provider: 'postmark', verificationSecret: 's3cr3t-value' });
    assert.doesNotMatch(cap.stdout + cap.stderr, /s3cr3t/);
  });

  it('webhooks remove needs --yes; engagement GETs the campaign route', async () => {
    const host = mockHost(() => json({ removed: true }));
    let cap = capture();
    assert.equal(await runCli(['email', 'webhooks', 'remove', 'wh1', '--org', 'org_1'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['email', 'webhooks', 'remove', 'wh1', '--org', 'org_1', '--yes'], opts(host, cap)), 0);
    assert.equal(host.last().method, 'DELETE');
    cap = capture();
    await runCli(['email', 'campaigns', 'engagement', 'c1', '--org', 'org_1'], opts(host, cap));
    assert.equal(host.last().path, `${E}/campaigns/c1/engagement`);
  });

  it('403 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden', message: 'no' }, 403));
    const cap = capture();
    assert.equal(await runCli(['email', 'settings', '--org', 'org_1'], opts(host, cap)), 4);
    assert.match(cap.stderr, /HTTP 403 forbidden: no/);
  });
});

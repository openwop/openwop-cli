// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const B = '/v1/host/openwop-app/operations';

describe('operations', () => {
  it('slo renders the rows table; --json prints the raw body', async () => {
    const body = { rows: [{ id: 'run-latency', metric: 'p95', state: 'ok', observed: 120, comparison: 'at_most', target: 500 }], alerts: [] };
    const host = mockHost(() => json(body));
    let cap = capture();
    assert.equal(await runCli(['operations', 'slo'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${B}/slo/summary`);
    assert.match(cap.stdout, /run-latency\s+p95\s+ok\s+120\s+at_most\s+500/);
    cap = capture();
    assert.equal(await runCli(['operations', 'slo', '--json'], opts(host, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('dlq passes --tenant-id as a query param', async () => {
    const host = mockHost(() => json({ subjects: [] }));
    const cap = capture();
    assert.equal(await runCli(['operations', 'dlq', '--tenant-id', 't_1'], opts(host, cap)), 0);
    assert.equal(host.last().path, `${B}/dlq/summary`);
    assert.deepEqual(host.last().query, { tenantId: 't_1' });
    assert.match(cap.stdout, /Dead-letter queue is empty/);
  });

  it('dlq replay POSTs tenantId/subject/messageId; missing one is a usage error', async () => {
    const host = mockHost(() => json({ replayed: true }, 202));
    let cap = capture();
    assert.equal(await runCli(['operations', 'dlq', 'replay', '--tenant-id', 't', '--subject', 's.dlq', '--message-id', 'm1'], opts(host, cap)), 0, cap.stderr);
    assert.deepEqual(host.last(), { ...host.last(), method: 'POST', path: `${B}/dlq/replay`, body: { tenantId: 't', subject: 's.dlq', messageId: 'm1' } });
    cap = capture();
    assert.equal(await runCli(['operations', 'dlq', 'replay', '--tenant-id', 't'], opts(host, cap)), 2);
    assert.match(cap.stderr, /--subject is required/);
  });

  it('webhooks: no org = cross-tenant path; with an org = the org path', async () => {
    const host = mockHost(() => json({ webhooks: [{ subscriptionId: 'w1', url: 'https://x/y', counts: { pending: 1, dead: 2, delivered: 3 } }] }));
    let cap = capture();
    await runCli(['operations', 'webhooks'], opts(host, cap));
    assert.equal(host.last().path, `${B}/webhooks/summary`);
    cap = capture();
    await runCli(['operations', 'webhooks', 'org/1'], opts(host, cap));
    assert.equal(host.last().path, `${B}/orgs/org%2F1/webhooks/summary`);
    assert.match(cap.stdout, /w1\s+https:\/\/x\/y\s+1\s+2\s+3/);
  });

  it('outbox redrive + compensation act send the host field names', async () => {
    const host = mockHost(() => json({ ok: true }));
    let cap = capture();
    await runCli(['operations', 'outbox', 'redrive', 'run:1', '--reason', 'cleared'], opts(host, cap));
    assert.equal(host.last().path, `${B}/dispatch-outbox/run%3A1/redrive`);
    assert.deepEqual(host.last().body, { reason: 'cleared' });
    cap = capture();
    await runCli(['operations', 'compensation', 'act', 'r1', '--action', 'retry', '--obligation-id', 'o1', '--expected-state', 'failed'], opts(host, cap));
    assert.equal(host.last().path, `${B}/runs/r1/compensation/actions`);
    assert.deepEqual(host.last().body, { action: 'retry', obligationId: 'o1', expectedState: 'failed' });
    assert.match(cap.stdout, /OK — compensation act r1/);
  });

  it('403 (not a super-admin) → legible message + exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden', message: 'Superadmin only.' }, 403));
    const cap = capture();
    assert.equal(await runCli(['operations', 'health'], opts(host, cap)), 4);
    assert.match(cap.stderr, /HTTP 403: Superadmin only\. — forbidden \(permission denied\)/);
    assert.doesNotMatch(cap.stderr, /at .*\.js/);
  });

  it('unknown subcommand is a usage error; --help lists endpoints', async () => {
    const host = mockHost();
    let cap = capture();
    assert.equal(await runCli(['operations', 'bogus'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['operations', '--help'], opts(host, cap)), 0);
    assert.match(cap.stdout, /POST\s+\/v1\/host\/openwop-app\/operations\/dlq\/replay/);
  });
});

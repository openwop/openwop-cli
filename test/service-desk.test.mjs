// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const B = '/v1/host/openwop-app/service-desk/orgs/o1';

describe('service-desk', () => {
  it('tickets lists with a status filter', async () => {
    const host = mockHost(() => json({ tickets: [{ ticketId: 'tk1', status: 'open', priority: 'high', channel: 'widget', subject: 'Help', updatedAt: 'now' }] }));
    const cap = capture();
    assert.equal(await runCli(['service-desk', 'tickets', 'o1', '--status', 'open'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${B}/tickets`);
    assert.deepEqual(host.last().query, { status: 'open' });
    assert.match(cap.stdout, /tk1\s+open\s+high\s+widget/);
  });

  it('tickets create nests --first-message into firstMessage.body', async () => {
    const host = mockHost(() => json({ ticket: { ticketId: 'tk2' } }, 201));
    const cap = capture();
    await runCli(['service-desk', 'tickets', 'create', 'o1', '--subject', 'Down', '--priority', 'urgent', '--first-message', 'context'], opts(host, cap));
    assert.deepEqual(host.last().body, { subject: 'Down', priority: 'urgent', firstMessage: { body: 'context' } });
  });

  it('tickets message maps --text onto the body field', async () => {
    const host = mockHost(() => json({ ticket: {} }));
    const cap = capture();
    await runCli(['service-desk', 'tickets', 'message', 'o1', 'tk1', '--text', 'On it', '--direction', 'outbound'], opts(host, cap));
    assert.equal(host.last().path, `${B}/tickets/tk1/messages`);
    assert.deepEqual(host.last().body, { body: 'On it', direction: 'outbound' });
  });

  it('intake-config rotate refuses without --yes, PUTs with it', async () => {
    const host = mockHost(() => json({ config: { publicIntakeKey: 'sdk_x' } }));
    let cap = capture();
    assert.equal(await runCli(['service-desk', 'intake-config', 'rotate', 'o1'], opts(host, cap)), 2);
    assert.equal(host.calls.length, 0);
    cap = capture();
    assert.equal(await runCli(['service-desk', 'intake-config', 'rotate', 'o1', '--yes'], opts(host, cap)), 0);
    assert.equal(host.last().method, 'PUT');
  });

  it('public send/thread go out WITHOUT a bearer', async () => {
    const host = mockHost(() => json({ visitorToken: 'sdv1.a.b', ticket: {} }, 201));
    let cap = capture();
    await runCli(['service-desk', 'public', 'send', 'sdk_1', '--text', 'hi'], opts(host, cap));
    assert.equal(host.last().path, '/v1/host/openwop-app/public-service-desk/sdk_1/messages');
    assert.equal(host.last().headers.authorization, undefined);
    assert.deepEqual(host.last().body, { body: 'hi' });
    cap = capture();
    await runCli(['service-desk', 'public', 'thread', 'sdk_1', '--token', 'sdv1.a.b', '--json'], opts(host, cap));
    assert.deepEqual(host.last().query, { token: 'sdv1.a.b' });
    assert.equal(host.last().headers.authorization, undefined);
  });

  it('403 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden_scope' }, 403));
    const cap = capture();
    assert.equal(await runCli(['service-desk', 'tickets', 'status', 'o1', 'tk1', '--status', 'solved'], opts(host, cap)), 4);
    assert.match(cap.stderr, /forbidden_scope/);
  });
});

// `openwop notifications stream|push …` — the live stream + web-push subscriptions.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { H, jsonResponse, mockHost, run, sseResponse } from './fixtures/conversation-harness.mjs';

const N = `${H}/notifications`;

describe('notifications push + stream', () => {
  it('push config / list / subscribe / unsubscribe', async () => {
    const host = mockHost({
      [`GET ${N}/push/config`]: { enabled: true, vapidPublicKey: 'BPUB' },
      [`GET ${N}/push/subscriptions`]: { subscriptions: [{ subscriptionId: 's1', endpoint: 'https://push/x', createdAt: 't' }] },
      [`POST ${N}/push/subscribe`]: () => jsonResponse({ subscriptionId: 's2' }, 201),
      [`DELETE ${N}/push/subscriptions/s1`]: () => jsonResponse(null, 204),
    });
    assert.match((await run(['notifications', 'push', 'config'], host)).stdout, /VAPID public key: BPUB/);
    assert.match((await run(['notifications', 'push', 'list'], host)).stdout, /s1\s+https:\/\/push\/x/);
    assert.equal(JSON.parse((await run(['--json', 'notifications', 'push', 'list'], host)).stdout).subscriptions.length, 1);
    const sub = await run(['notifications', 'push', 'subscribe', '--endpoint', 'https://push/y', '--p256dh', 'P', '--auth', 'A', '--user-agent', 'cli'], host);
    assert.equal(sub.code, 0, sub.stderr);
    assert.deepEqual(host.calls.at(-1).body, { endpoint: 'https://push/y', keys: { p256dh: 'P', auth: 'A' }, userAgent: 'cli' });
    assert.doesNotMatch(sub.stdout, /\bA\b.*\bP\b/);
    assert.equal((await run(['notifications', 'push', 'unsubscribe', 's1'], host)).code, 0);
    assert.equal((await run(['notifications', 'push', 'subscribe', '--endpoint', 'x'], host)).code, 2);
  });

  it('stream renders notification frames and honours --max-events', async () => {
    const host = mockHost({ [`GET ${N}/stream`]: () => sseResponse([{ event: 'notification', data: { notificationId: 'n1', title: 'Run failed', priority: 'high', createdAt: 't' } }, { event: 'notification', data: { notificationId: 'n2', title: 'x' } }]) });
    const r = await run(['notifications', 'stream', '--max-events', '1'], host);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[high\] Run failed \(n1\)/);
    assert.doesNotMatch(r.stdout, /n2/);
  });

  it('unauthenticated subscribe → 401 → exit 4', async () => {
    const host = mockHost({ [`POST ${N}/push/subscribe`]: () => jsonResponse({ error: 'unauthenticated', message: 'sign in to enable push' }, 401) });
    const r = await run(['notifications', 'push', 'subscribe', '--endpoint', 'https://p', '--p256dh', 'P', '--auth', 'A'], host);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /sign in to enable push/);
  });
});

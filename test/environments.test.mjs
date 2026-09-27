import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts } from './helpers/mockHost.mjs';

const B = '/v1/host/openwop-app/environments';

describe('environments', () => {
  it('list renders the chain; --drift adds the query', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { environments: [{ name: 'dev', order: 0, protection: 'open', currentSnapshot: null }, { name: 'prod', order: 2, protection: 'protected', currentSnapshot: 'abc' }], domains: [] } }));
    assert.equal(await runCli(['environments', 'list', '--drift'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path + calls[0].search, `${B}?drift=1`);
    assert.match(cap.stdout, /prod\s+2\s+protected\s+abc/);
  });

  it('create / protect / settings set send the exact host fields', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ status: c.method === 'POST' ? 201 : 200, body: {} }));
    assert.equal(await runCli(['environments', 'create', 'qa', '--order', '1', '--protection', 'locked'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(calls[0].body, { name: 'qa', order: 1, protection: 'locked' });
    assert.equal(await runCli(['environments', 'protect', 'qa', '--protection', 'open'], opts(fetchImpl, cap)), 0);
    assert.equal(calls[1].method, 'PATCH');
    assert.equal(calls[1].path, `${B}/qa/protection`);
    assert.deepEqual(calls[1].body, { protection: 'open' });
    assert.equal(await runCli(['environments', 'settings', 'set', '--require-approval', 'true'], opts(fetchImpl, cap)), 0);
    assert.equal(calls[2].method, 'PATCH');
    assert.deepEqual(calls[2].body, { requireApprovalForPromotion: true });
    assert.equal(await runCli(['environments', 'protect', 'qa', '--protection', 'bogus'], opts(fetchImpl, cap)), 2);
  });

  it('snapshot / preview / rollback / apply bodies', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { hash: 'h1' } }));
    await runCli(['environments', 'snapshot', '--source-env', 'dev'], opts(fetchImpl, cap));
    assert.deepEqual([calls[0].path, calls[0].body], [`${B}/snapshots`, { sourceEnv: 'dev' }]);
    await runCli(['environments', 'preview', '--to', 'staging', '--snapshot', 'h1'], opts(fetchImpl, cap));
    assert.deepEqual([calls[1].path, calls[1].body], [`${B}/preview`, { toEnv: 'staging', snapshotHash: 'h1' }]);
    await runCli(['environments', 'rollback', '--env', 'prod', '--snapshot', 'h0'], opts(fetchImpl, cap));
    assert.deepEqual([calls[2].path, calls[2].body], [`${B}/rollback`, { env: 'prod', snapshotHash: 'h0' }]);
    await runCli(['environments', 'apply', '--snapshot', 'h1'], opts(fetchImpl, cap));
    assert.deepEqual([calls[3].path, calls[3].body], [`${B}/apply`, { snapshotHash: 'h1' }]);
  });

  it('promote exits 3 when the host queues it for approval (202)', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ status: 202, body: { status: 'pending_approval', approval: { approvalId: 'ap1' } } }));
    assert.equal(await runCli(['environments', 'promote', '--from', 'dev', '--to', 'staging'], opts(fetchImpl, cap)), 3);
    assert.deepEqual(calls[0].body, { fromEnv: 'dev', toEnv: 'staging' });
    assert.match(cap.stdout, /Queued for approval \(ap1\)/);
  });

  it('promotions --json + 403 → exit 4', async () => {
    const cap = capture();
    const body = { promotions: [] };
    const { fetchImpl } = mockHost(() => ({ body }));
    assert.equal(await runCli(['--json', 'environments', 'promotions'], opts(fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
    const cap2 = capture();
    const denied = mockHost(() => ({ status: 403, body: { message: 'Missing required scope: host:members:manage' } }));
    assert.equal(await runCli(['environments', 'ensure-chain'], opts(denied.fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /host:members:manage/);
  });
});

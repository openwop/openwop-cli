// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

describe('kicktodo', () => {
  it('readiness 200 → exit 0', async () => {
    const host = mockHost(() => json({ status: 'ready', blockers: [] }));
    const cap = capture();
    assert.equal(await runCli(['kicktodo', 'readiness'], opts(host, cap)), 0);
    assert.equal(host.last().path, '/v1/host/openwop-app/kicktodo/readiness');
  });

  it('readiness 503 degraded prints the body (blockers) and exits 1', async () => {
    const host = mockHost(() => json({ status: 'degraded', blockers: ['packs missing'] }, 503));
    const cap = capture();
    assert.equal(await runCli(['kicktodo', 'readiness', '--json'], opts(host, cap)), 1);
    assert.deepEqual(JSON.parse(cap.stdout).blockers, ['packs missing']);
  });

  it('author 403 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden_scope' }, 403));
    const cap = capture();
    assert.equal(await runCli(['kicktodo', 'author'], opts(host, cap)), 4);
    assert.equal(host.last().path, '/v1/host/openwop-app/kicktodo/creator/author');
  });
});

// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const S = '/v1/host/openwop-app/strategy';

describe('strategy (extended)', () => {
  it('update PATCHes only the flags given, JSON flags parsed', async () => {
    const host = mockHost(() => json({ id: 's1' }));
    const cap = capture();
    assert.equal(await runCli(['strategy', 'update', 's1', '--status', 'active', '--confidence', 'high', '--period', '{"label":"Q3"}'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PATCH');
    assert.equal(host.last().path, `${S}/s1`);
    assert.deepEqual(host.last().body, { status: 'active', confidence: 'high', period: { label: 'Q3' } });
  });

  it('delete --hard sends ?hard=true and needs --yes', async () => {
    const host = mockHost(() => json(null, 204));
    let cap = capture();
    assert.equal(await runCli(['strategy', 'delete', 's1'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['strategy', 'delete', 's1', '--hard', '--yes'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'DELETE');
    assert.deepEqual(host.last().query, { hard: 'true' });
  });

  it('context picks the per-strategy path with an id, the lookup path with a selector', async () => {
    const host = mockHost(() => json({ strategies: [] }));
    let cap = capture();
    await runCli(['strategy', 'context', 's:1'], opts(host, cap));
    assert.equal(host.last().path, `${S}/s%3A1/context`);
    cap = capture();
    await runCli(['strategy', 'context', '--project-id', 'p1'], opts(host, cap));
    assert.equal(host.last().path, `${S}/context`);
    assert.deepEqual(host.last().query, { projectId: 'p1' });
  });

  it('check-ins add posts value as a number to the key-result path', async () => {
    const host = mockHost(() => json({ checkInId: 'ci:1' }, 201));
    const cap = capture();
    await runCli(['strategy', 'check-ins', 'add', 's1', 'kr1', '--value', '42', '--note', 'ok'], opts(host, cap));
    assert.equal(host.last().path, `${S}/s1/key-results/kr1/check-ins`);
    assert.deepEqual(host.last().body, { value: 42, note: 'ok' });
  });

  it('versions table + import-objectives reads the CSV file', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { versions: [{ n: 3, title: 'T', status: 'draft', actor: 'u', createdAt: 'd' }] } : { imported: 2 }));
    let cap = capture();
    await runCli(['strategy', 'versions', 's1'], opts(host, cap));
    assert.match(cap.stdout, /3\s+T\s+draft\s+u\s+d/);
    const dir = mkdtempSync(join(tmpdir(), 'owcli-'));
    const file = join(dir, 'okr.csv');
    writeFileSync(file, 'objective,keyResult,target,unit\nGrow,ARR,10,M\n');
    cap = capture();
    await runCli(['strategy', 'import-objectives', 's1', '--csv-file', file], opts(host, cap));
    assert.deepEqual(host.last().body, { csv: 'objective,keyResult,target,unit\nGrow,ARR,10,M' });
  });

  it('cadence set keeps entries you did not pass (read-modify-write)', async () => {
    const weekly = { enabled: true, cron: '0 9 * * 1' };
    const host = mockHost((c) => json(c.method === 'GET' ? { config: { ownerUserId: 'u', weeklyCheckin: weekly, updatedAt: 'x' } } : { config: {} }));
    const cap = capture();
    await runCli(['strategy', 'cadence', 'set', '--metric-sync', '{"enabled":false}'], opts(host, cap));
    assert.equal(host.last().method, 'PUT');
    assert.deepEqual(host.last().body, { weeklyCheckin: weekly, metricSync: { enabled: false } });
  });

  it('403 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden' }, 403));
    const cap = capture();
    assert.equal(await runCli(['strategy', 'reindex-kb', '--org', 'o1'], opts(host, cap)), 4);
    assert.deepEqual(host.last().body, { orgId: 'o1' });
  });
});

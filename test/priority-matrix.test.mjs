// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const PM = '/v1/host/openwop-app/priority-matrix';
const L = `${PM}/lists/l1`;

describe('priority-matrix (extended)', () => {
  it('ideas renders the ranked table', async () => {
    const host = mockHost(() => json({ ideas: [{ rank: 1, card: { id: 'c1', title: 'Idea' }, status: { columnName: 'New' }, computedPriority: 7.5, completeness: 1 }] }));
    const cap = capture();
    assert.equal(await runCli(['priority-matrix', 'ideas', 'l1'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${L}/ideas`);
    assert.match(cap.stdout, /1\s+c1\s+Idea\s+New\s+7\.5/);
  });

  it('ideas score collects --score k=v into a numeric map (PUT)', async () => {
    const host = mockHost(() => json({ computedPriority: 3 }));
    const cap = capture();
    await runCli(['priority-matrix', 'ideas', 'score', 'l1', 'c1', '--score', 'reach=8', '--score', 'effort=3'], opts(host, cap));
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, `${L}/ideas/c1/scores`);
    assert.deepEqual(host.last().body, { scores: { reach: 8, effort: 3 } });
  });

  it('evidence remove URL-encodes the colon-bearing evidence id', async () => {
    const host = mockHost(() => json(null, 204));
    const cap = capture();
    assert.equal(await runCli(['priority-matrix', 'ideas', 'evidence', 'remove', 'l1', 'c1', 'ev:l1::c1::abc', '--yes'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${L}/ideas/c1/evidence/ev%3Al1%3A%3Ac1%3A%3Aabc`);
  });

  it('scenarios create nests selection + constraints', async () => {
    const host = mockHost(() => json({ scenarioId: 'sc1' }, 201));
    const cap = capture();
    await runCli(['priority-matrix', 'scenarios', 'create', 'l1', 's1', '--name', 'Top', '--mode', 'top-n', '--n', '5', '--max-budget', '5000'], opts(host, cap));
    assert.equal(host.last().path, `${L}/sessions/s1/scenarios`);
    assert.deepEqual(host.last().body, { name: 'Top', selection: { mode: 'top-n', n: 5 }, constraints: { maxBudget: 5000 } });
  });

  it('scenarios compare requires --a and --b as query params', async () => {
    const host = mockHost(() => json({ gainedInB: [], droppedInB: [] }));
    let cap = capture();
    assert.equal(await runCli(['priority-matrix', 'scenarios', 'compare', 'l1', 's1', '--a', 'x'], opts(host, cap)), 2);
    cap = capture();
    await runCli(['priority-matrix', 'scenarios', 'compare', 'l1', 's1', '--a', 'x', '--b', 'y'], opts(host, cap));
    assert.deepEqual(host.last().query, { a: 'x', b: 'y' });
  });

  it('portfolio maps --org/--top-n onto orgId/topN', async () => {
    const host = mockHost(() => json({ items: [] }));
    const cap = capture();
    await runCli(['priority-matrix', 'portfolio', '--org', 'o1', '--top-n', '5', '--normalize', 'percentile'], opts(host, cap));
    assert.equal(host.last().path, `${PM}/portfolio`);
    assert.deepEqual(host.last().query, { orgId: 'o1', topN: '5', normalize: 'percentile' });
  });

  it('peers credential reads the token from a file and never prints it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owcli-'));
    const file = join(dir, 'tok');
    writeFileSync(file, 'secret-token-123\n');
    const host = mockHost(() => json(null, 204));
    const cap = capture();
    assert.equal(await runCli(['priority-matrix', 'peers', 'credential', 'p1', '--token-file', file, '--scope', 'user'], opts(host, cap)), 0, cap.stderr);
    assert.deepEqual(host.last().body, { token: 'secret-token-123', scope: 'user' });
    assert.doesNotMatch(cap.stdout + cap.stderr, /secret-token-123/);
  });

  it('peers add 403 (not a super-admin) → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden' }, 403));
    const cap = capture();
    assert.equal(await runCli(['priority-matrix', 'peers', 'add', '--label', 'EU', '--peer-url', 'https://eu.example.com'], opts(host, cap)), 4);
    assert.deepEqual(host.last().body, { label: 'EU', baseUrl: 'https://eu.example.com' });
  });
});

// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const O = '/v1/host/openwop-app/job-search/orgs/o1';

describe('job-search', () => {
  it('applications renders nested deal fields', async () => {
    const host = mockHost(() => json({ applications: [{ deal: { dealId: 'deal:1', title: 'SWE', customFields: { matchScore: 8 } }, stageName: 'Applied', appliedAt: 'd' }] }));
    const cap = capture();
    assert.equal(await runCli(['job-search', 'applications', 'o1'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${O}/applications`);
    assert.match(cap.stdout, /deal:1\s+SWE\s+Applied\s+8\s+d/);
  });

  it('steering set is read-modify-write: untouched policy fields survive', async () => {
    const current = { tenantId: 't', goals: 'g', policy: { roles: ['a'], locations: ['NYC'], remote: null, minMatchScore: 5, dailyCap: 10, ratePerHour: 4, tiers: ['A'] } };
    const host = mockHost((c) => json(c.method === 'GET' ? current : { ok: true }));
    const cap = capture();
    assert.equal(await runCli(['job-search', 'steering', 'set', 'o1', '--roles', 'Staff,Principal', '--remote', '--daily-cap', '5'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.calls[0].method, 'GET');
    const put = host.last();
    assert.equal(put.method, 'PUT');
    assert.equal(put.path, `${O}/agent/steering`);
    assert.deepEqual(put.body, { goals: 'g', policy: { roles: ['Staff', 'Principal'], locations: ['NYC'], remote: true, minMatchScore: 5, dailyCap: 5, ratePerHour: 4, tiers: ['A'] } });
  });

  it('grants create coerces numbers and csv; revoke needs --yes', async () => {
    const host = mockHost(() => json({ grant: {} }, 201));
    let cap = capture();
    await runCli(['job-search', 'grants', 'create', 'o1', '--campaign-id', 'c1', '--origins', 'https://a.com,https://b.com', '--expires-at', '2026-12-31T00:00:00Z', '--max-submits', '10', '--max-prepared', '20', '--rate-per-hour', '2'], opts(host, cap));
    assert.deepEqual(host.last().body, { campaignId: 'c1', origins: ['https://a.com', 'https://b.com'], expiresAt: '2026-12-31T00:00:00Z', maxSubmits: 10, maxPrepared: 20, ratePerHour: 2 });
    cap = capture();
    assert.equal(await runCli(['job-search', 'grants', 'revoke', 'o1', 'grant:x'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['job-search', 'grants', 'revoke', 'o1', 'grant:x', '--yes'], opts(host, cap)), 0);
    assert.equal(host.last().method, 'DELETE');
    assert.equal(host.last().path, `${O}/grants/grant%3Ax`);
  });

  it('listings set-visibility sends public:false for --no-public', async () => {
    const host = mockHost(() => json({ public: false }));
    const cap = capture();
    await runCli(['job-search', 'listings', 'set-visibility', 'o1', '--no-public'], opts(host, cap));
    assert.deepEqual(host.last().body, { public: false });
  });

  it('a non-number --max-submits is a usage error before any request', async () => {
    const host = mockHost();
    const cap = capture();
    assert.equal(await runCli(['job-search', 'grants', 'create', 'o1', '--campaign-id', 'c', '--origins', 'x', '--expires-at', 'e', '--max-submits', 'ten', '--max-prepared', '1', '--rate-per-hour', '1'], opts(host, cap)), 2);
    assert.match(cap.stderr, /--max-submits must be a number/);
    assert.equal(host.calls.length, 0);
  });

  it('404 (feature off) → exit 2 with a hint; 401 → exit 4', async () => {
    let host = mockHost(() => json({ error: 'not_found' }, 404));
    let cap = capture();
    assert.equal(await runCli(['job-search', 'status'], opts(host, cap)), 2);
    assert.match(cap.stderr, /feature is not enabled/);
    host = mockHost(() => json({ error: 'unauthenticated' }, 401));
    cap = capture();
    assert.equal(await runCli(['job-search', 'exceptions'], opts(host, cap)), 4);
  });
});

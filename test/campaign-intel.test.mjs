// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}

const B = '/v1/host/openwop-app/campaign-intel';

describe('campaign-intel command', () => {
  it('the six reads hit their GET paths with orgId (+campaignId where supported)', async () => {
    const cap = capture();
    const r = recorder(() => json({ anomalies: [{ date: 'd1', platform: 'meta', metric: 'cpa', severity: 'high' }], forecasts: [] }));
    for (const sub of ['budget', 'forecast']) assert.equal(await runCli(['campaign-intel', sub, '--org', 'org_1', '--campaign', 'c1'], opts(r.fetchImpl, cap)), 0);
    for (const sub of ['anomalies', 'overview', 'attribution', 'pacing']) assert.equal(await runCli(['campaign-intel', sub, '--org', 'org_1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
      `GET ${B}/budget?orgId=org_1&campaignId=c1`, `GET ${B}/forecast?orgId=org_1&campaignId=c1`,
      `GET ${B}/anomalies?orgId=org_1`, `GET ${B}/overview?orgId=org_1`, `GET ${B}/attribution?orgId=org_1`, `GET ${B}/pacing?orgId=org_1`,
    ]);
    assert.match(cap.stdout, /d1\s+meta\s+cpa\s+high/);
  });

  it('plan-budget posts numbers, platforms and the what-if scenario', async () => {
    const cap = capture();
    const r = recorder(() => json({ plan: { allocations: [] } }));
    const code = await runCli(['campaign-intel', 'plan-budget', '--org', 'org_1', '--total-budget-minor', '500000', '--target-conversions', '200', '--horizon-days', '30', '--platform', 'meta', '--platform', 'google', '--shift-from', 'meta', '--shift-to', 'google', '--shift-pct', '10'], opts(r.fetchImpl, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal(r.calls[0].path, `${B}/plan-budget`);
    assert.deepEqual(r.calls[0].body, { orgId: 'org_1', totalBudgetMinor: 500000, targetConversions: 200, horizonDays: 30, platforms: ['meta', 'google'], scenario: { from: 'meta', to: 'google', pct: 10 } });
  });

  it('plan-budget without the required numbers is a usage error (no request)', async () => {
    const cap = capture();
    const r = recorder(() => json({}));
    assert.equal(await runCli(['campaign-intel', 'plan-budget', '--org', 'org_1'], opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
  });

  it('apply refuses a live budget change without --yes; --dry-run and --yes both send', async () => {
    const cap = capture();
    const r = recorder(() => json({ outcome: 'dry_run' }));
    const args = ['campaign-intel', 'apply', '--org', 'org_1', '--platform', 'meta', '--ad-account', 'act_1', '--campaign', 'c1', '--daily-budget-minor', '5000'];
    assert.equal(await runCli(args, opts(r.fetchImpl, cap)), 2);
    assert.equal(r.calls.length, 0);
    assert.match(cap.stderr, /without --yes/);
    assert.equal(await runCli([...args, '--dry-run'], opts(r.fetchImpl, cap)), 0);
    assert.equal(await runCli([...args, '--yes'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`POST ${B}/recommendations/apply`, `POST ${B}/recommendations/apply`]);
    assert.deepEqual(r.calls[0].body, { orgId: 'org_1', platform: 'meta', adAccountId: 'act_1', campaignId: 'c1', dailyBudgetMinor: 5000, dryRun: true });
    assert.equal(r.calls[1].body.dryRun, undefined);
    assert.match(cap.stdout, /Budget preview: dry_run/);
  });

  it('--json prints the raw body; a 403 exits 4 legibly', async () => {
    const cap = capture();
    const r = recorder(() => json({ report: [] }));
    assert.equal(await runCli(['campaign-intel', 'pacing', '--org', 'org_1', '--json'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), { report: [] });
    const cap2 = capture();
    const r2 = recorder(() => json({ error: 'forbidden_scope', message: 'Missing required scope: workspace:read' }, 403));
    assert.equal(await runCli(['campaign-intel', 'overview', '--org', 'org_1'], opts(r2.fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /HTTP 403(?: \S+)?: Missing required scope/);
  });
});

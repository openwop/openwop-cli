// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const R = '/v1/host/openwop-app/capability-firewall';

describe('capability-firewall', () => {
  it('rules GETs; --json raw', async () => {
    const body = { rules: [], unknownToolPolicy: 'treat-as-risky', mode: 'default-allow', defaultDenyVerdict: 'deny', isDefault: true };
    const host = mockHost(() => json(body));
    const cap = capture();
    assert.equal(await runCli(['capability-firewall', 'rules', '--org', 'org_1', '--json'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${R}/orgs/org_1/rules`);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('rules set is read-modify-write: --mode keeps the current rules + policy', async () => {
    const current = { rules: [{ id: 'r1', description: '', when: { anyOf: [{ egress: 'safe-fetch' }] }, verdict: 'deny', reason: 'x' }], unknownToolPolicy: 'skip', mode: 'default-allow', defaultDenyVerdict: 'deny', isDefault: false };
    const host = mockHost((c) => json(c.method === 'GET' ? current : { ...current, mode: 'shadow' }));
    const cap = capture();
    assert.equal(await runCli(['capability-firewall', 'rules', 'set', '--org', 'org_1', '--mode', 'shadow'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.calls[0].method, 'GET');
    const put = host.last();
    assert.equal(put.method, 'PUT');
    assert.deepEqual(put.body.rules, current.rules);
    assert.equal(put.body.unknownToolPolicy, 'skip');
    assert.equal(put.body.mode, 'shadow');
  });

  it('decisions sends ?limit and renders a table', async () => {
    const host = mockHost(() => json({ decisions: [{ decisionId: 'd1', timestamp: 't', decision: 'deny', toolName: 'http.fetch', ruleId: 'r1', reason: 'exfil' }] }));
    const cap = capture();
    await runCli(['capability-firewall', 'decisions', '--org', 'org_1', '--limit', '20'], opts(host, cap));
    assert.equal(host.last().query.limit, '20');
    assert.match(cap.stdout, /t\s+deny\s+http\.fetch\s+r1\s+exfil/);
  });

  it('simulate requires --next and POSTs the parsed actions', async () => {
    const host = mockHost(() => json({ decision: 'allow' }));
    let cap = capture();
    assert.equal(await runCli(['capability-firewall', 'simulate', '--org', 'org_1'], opts(host, cap)), 2);
    assert.equal(host.calls.length, 0);
    cap = capture();
    await runCli(['capability-firewall', 'simulate', '--org', 'org_1', '--next', '{"egress":"safe-fetch"}', '--seen', '[{"safetyTier":"read"}]'], opts(host, cap));
    assert.equal(host.last().path, `${R}/orgs/org_1/simulate`);
    assert.deepEqual(host.last().body, { next: { egress: 'safe-fetch' }, seen: [{ safetyTier: 'read' }] });
  });

  it('platform rules 403 → super-admin advice, exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden', message: 'superadmin required' }, 403));
    const cap = capture();
    assert.equal(await runCli(['capability-firewall', 'platform', 'rules'], opts(host, cap)), 4);
    assert.equal(host.last().path, `${R}/platform/rules`);
    assert.match(cap.stderr, /requires a super-admin principal/);
  });

  it('org rules 403 → exit 4 with the host line', async () => {
    const host = mockHost(() => json({ error: 'forbidden_scope', message: 'nope' }, 403));
    const cap = capture();
    assert.equal(await runCli(['capability-firewall', 'rules', '--org', 'org_1'], opts(host, cap)), 4);
    assert.match(cap.stderr, /HTTP 403 forbidden_scope: nope/);
  });
});

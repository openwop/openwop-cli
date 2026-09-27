// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

describe('heartbeat', () => {
  const P = '/v1/host/openwop-app/heartbeat/settings';
  it('settings set is read-modify-write over the saved config', async () => {
    const view = { config: { id: 'singleton', status: 'on', enabledUntil: null, hostDefaultIntervalMs: 60000, runBudgetPerHour: 10 }, overridden: true, effective: {} };
    const host = mockHost(() => json(view));
    const cap = capture();
    assert.equal(await runCli(['heartbeat', 'settings', 'set', '--run-budget-per-hour', '60'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.calls[0].method, 'GET');
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, P);
    assert.deepEqual(host.last().body, { status: 'on', hostDefaultIntervalMs: 60000, runBudgetPerHour: 60, enabledUntil: null });
  });
  it('--json prints the raw view', async () => {
    const host = mockHost(() => json({ config: { status: 'off' } }));
    const cap = capture();
    await runCli(['heartbeat', 'settings', '--json'], opts(host, cap));
    assert.deepEqual(JSON.parse(cap.stdout), { config: { status: 'off' } });
  });
  it('403 → super-admin advice, exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden', message: 'no' }, 403));
    const cap = capture();
    assert.equal(await runCli(['heartbeat', 'settings'], opts(host, cap)), 4);
    assert.match(cap.stderr, /Heartbeat settings requires a super-admin principal/);
    assert.match(cap.stderr, /HTTP 403 forbidden: no/);
  });
});

describe('settings', () => {
  const P = '/v1/host/openwop-app/settings/prefs';
  it('prefs set edits one privacy opt-out without dropping the others', async () => {
    const current = { personalBudget: { dailyTokenCap: 1000 }, reasoningDirective: 'advisory', privacy: { crashReportsOptOut: true }, usageToday: { day: 'd', tokens: 3 } };
    const host = mockHost((c) => json(c.method === 'GET' ? current : {}));
    const cap = capture();
    assert.equal(await runCli(['settings', 'prefs', 'set', '--analytics-opt-out'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, P);
    assert.deepEqual(host.last().body, { personalBudget: { dailyTokenCap: 1000 }, reasoningDirective: 'advisory', privacy: { crashReportsOptOut: true, analyticsOptOut: true } });
  });
  it('prefs set --daily-token-cap on a null budget builds the object', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { personalBudget: null, reasoningDirective: null, privacy: null } : {}));
    const cap = capture();
    await runCli(['settings', 'prefs', 'set', '--daily-token-cap', '5000'], opts(host, cap));
    assert.deepEqual(host.last().body.personalBudget, { dailyTokenCap: 5000 });
  });
  it('401 → exit 4', async () => {
    const host = mockHost(() => json({ error: 'unauthenticated' }, 401));
    const cap = capture();
    assert.equal(await runCli(['settings', 'prefs'], opts(host, cap)), 4);
  });
});

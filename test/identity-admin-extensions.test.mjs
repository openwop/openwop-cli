// Extensions to existing groups from the b2 identity/admin batch: orgs, users, auth,
// governance, toggles, byok, admin, brand, analytics, workspaces.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';
import { capture, mockHost, opts, forbidden } from './helpers/mockHost.mjs';

const H = '/v1/host/openwop-app';
function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'owp-b2-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('orgs extensions', () => {
  it('invites list/create/revoke', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => (c.method === 'GET'
      ? { body: { invites: [{ inviteId: 'inv1', email: 'jo@a.io', role: 'viewer', expiresAt: 'x', expired: true }] } }
      : c.method === 'POST' ? { status: 201, body: { invite: { inviteId: 'inv2', email: 'jo@a.io', role: 'editor' }, delivery: 'sent' } } : { status: 204 }));
    assert.equal(await runCli(['orgs', 'invites', 'o1', 'list'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, `${H}/orgs/o1/invites`);
    assert.match(cap.stdout, /inv1\s+jo@a\.io\s+viewer\s+expired/);
    assert.equal(await runCli(['orgs', 'invites', 'o1', 'create', '--email', 'jo@a.io', '--role', 'editor'], opts(fetchImpl, cap)), 0);
    assert.deepEqual(calls[1].body, { email: 'jo@a.io', role: 'editor' });
    assert.equal(await runCli(['orgs', 'invites', 'o1', 'revoke', 'inv2'], opts(fetchImpl, cap)), 2);
    assert.equal(await runCli(['orgs', 'invites', 'o1', 'revoke', 'inv2', '--yes'], opts(fetchImpl, cap)), 0);
    assert.deepEqual([calls[2].method, calls[2].path], ['DELETE', `${H}/orgs/o1/invites/inv2`]);
  });

  it('invitations preview/accept/decline carry the token', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ status: c.path.endsWith('/accept') ? 201 : 200, body: c.path.endsWith('/accept') ? { orgId: 'o1', memberId: 'm1', alreadyMember: false } : { orgName: 'Acme' } }));
    await runCli(['orgs', 'invitations', 'preview', '--token', 't/1'], opts(fetchImpl, cap));
    assert.equal(calls[0].path + calls[0].search, `${H}/orgs/invitations/preview?token=t%2F1`);
    await runCli(['orgs', 'invitations', 'accept', '--token', 't1'], opts(fetchImpl, cap));
    assert.deepEqual([calls[1].method, calls[1].body], ['POST', { token: 't1' }]);
    assert.match(cap.stdout, /Joined org o1 as member m1/);
    await runCli(['orgs', 'invitations', 'decline', '--token', 't1'], opts(fetchImpl, cap));
    assert.equal(calls[2].path, `${H}/orgs/invitations/decline`);
  });

  it('decide renders only {allowed}; exit 0 allowed / 1 denied; 404 fails closed', async () => {
    const cap = capture();
    let allowed = true;
    const { calls, fetchImpl } = mockHost(() => ({ body: { allowed } }));
    assert.equal(await runCli(['orgs', 'decide', '--principal', 'user:jo', '--action', 'runs:read'], opts(fetchImpl, cap)), 0);
    assert.deepEqual(calls[0].body, { action: 'runs:read', principal: 'user:jo' });
    assert.match(cap.stdout, /ALLOWED/);
    allowed = false;
    assert.equal(await runCli(['orgs', 'decide', '--action', 'runs:read'], opts(fetchImpl, cap)), 1);
    const cap2 = capture();
    const off = mockHost(() => ({ status: 404, body: { error: 'not_found' } }));
    assert.equal(await runCli(['orgs', 'decide', '--action', 'x'], opts(off.fetchImpl, cap2)), 2);
    assert.match(cap2.stderr, /does not enforce authorization/);
  });

  it('transfer-ownership, effective filters, roles include customRoles, member create w/o subject', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ body: c.path.endsWith('/roles') ? { roles: [{ roleId: 'owner' }], customRoles: [{ roleId: 'r_custom' }] } : c.path.endsWith('transfer-ownership') ? { transferredTo: 'm2', steppedDown: 'm1' } : {}, status: c.method === 'POST' && c.path.endsWith('/members') ? 201 : 200 }));
    assert.equal(await runCli(['orgs', 'members', 'o1', 'transfer-ownership', 'm2', '--step-down'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual([calls[0].path, calls[0].body], [`${H}/orgs/o1/members/m2/transfer-ownership`, { stepDown: true }]);
    assert.match(cap.stdout, /you stepped down/);
    await runCli(['orgs', 'effective', '--member', 'm2', '--org', 'o1'], opts(fetchImpl, cap));
    assert.equal(calls[1].search, '?memberId=m2&orgId=o1');
    await runCli(['orgs', 'roles', 'o1', 'list'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /r_custom/);
    assert.equal(await runCli(['orgs', 'members', 'o1', 'create', '--display-name', 'Jo'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(calls[3].body, { displayName: 'Jo' });
  });
});

describe('users extensions', () => {
  it('me security / factor-event / sign-out-everywhere / revoke-sessions / logout / oidc-bind', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ status: c.path.endsWith('factor-event') ? 202 : 200, body: c.path.endsWith('/me/security') ? { source: 'oidc', mfaSessionVerified: true } : c.path.endsWith('oidc/bind') ? { user: { userId: 'u1', principalId: 'oidc:x' }, bound: true, rekeyed: 2 } : { userId: 'u2', sessionEpoch: 3, loggedOut: true } }));
    await runCli(['users', 'me', 'security'], opts(fetchImpl, cap));
    assert.equal(calls[0].path, `${H}/users/me/security`);
    assert.match(cap.stdout, /mfaSessionVerified: yes/);
    await runCli(['users', 'me', 'factor-event', '--event', 'unbound', '--factor-count', '1'], opts(fetchImpl, cap));
    assert.deepEqual(calls[1].body, { event: 'unbound', factorCount: 1 });
    assert.equal(await runCli(['users', 'me', 'sign-out-everywhere'], opts(fetchImpl, cap)), 2);
    await runCli(['users', 'me', 'sign-out-everywhere', '--yes'], opts(fetchImpl, cap));
    assert.equal(calls[2].path, `${H}/users/me/sessions/revoke`);
    await runCli(['users', 'revoke-sessions', 'u:2', '--yes'], opts(fetchImpl, cap));
    assert.equal(calls[3].path, `${H}/users/users/u%3A2/sessions/revoke`);
    await runCli(['users', 'logout'], opts(fetchImpl, cap));
    assert.equal(calls[4].path, `${H}/users/auth/logout`);
    await runCli(['users', 'oidc-bind'], opts(fetchImpl, cap));
    assert.equal(calls[5].path, `${H}/users/auth/oidc/bind`);
    assert.match(cap.stdout, /re-keyed 2/);
  });
});

describe('auth break-glass', () => {
  it('reads the token from a file, never echoes it, reports the session', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { ok: true, tenantId: 'ops', expiresInSeconds: 600 } }));
    const file = tmpFile('tok', 'a-very-long-breakglass-token\n');
    assert.equal(await runCli(['auth', 'break-glass', '--token-file', file], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual([calls[0].path, calls[0].body], [`${H}/auth/break-glass`, { token: 'a-very-long-breakglass-token' }]);
    assert.doesNotMatch(cap.stdout + cap.stderr, /breakglass-token/);
    assert.match(cap.stdout, /tenant ops/);
  });
  it('401 → exit 4; 404 → not enabled exit 1', async () => {
    const file = tmpFile('tok', 'x'.repeat(20));
    const cap = capture();
    assert.equal(await runCli(['auth', 'break-glass', '--token-file', file], opts(mockHost(() => ({ status: 401, body: {} })).fetchImpl, cap)), 4);
    const cap2 = capture();
    assert.equal(await runCli(['auth', 'break-glass', '--token-file', file], opts(mockHost(() => ({ status: 404, body: {} })).fetchImpl, cap2)), 1);
    assert.match(cap2.stderr, /not enabled/);
  });
});

describe('governance extensions', () => {
  it('egress-rules get/set', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { mode: 'allowlist', hosts: ['api.stripe.com'] } }));
    await runCli(['governance', 'egress-rules'], opts(fetchImpl, cap));
    assert.equal(calls[0].path, `${H}/governance/egress-rules`);
    assert.match(cap.stdout, /mode:\s+allowlist/);
    await runCli(['governance', 'egress-rules', 'set', '--mode', 'allowlist', '--host', 'api.stripe.com'], opts(fetchImpl, cap));
    assert.deepEqual([calls[1].method, calls[1].body], ['PUT', { mode: 'allowlist', hosts: ['api.stripe.com'] }]);
    assert.equal(await runCli(['governance', 'egress-rules', 'set', '--mode', 'bogus'], opts(fetchImpl, cap)), 2);
  });
  it('byok-chat-budget get (provider) / set (clear → null)', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { budget: { dailyTokenCap: 0, softWarningPct: 80 }, override: null } }));
    await runCli(['governance', 'byok-chat-budget', '--provider', 'anthropic'], opts(fetchImpl, cap));
    assert.equal(calls[0].search, '?provider=anthropic');
    assert.match(cap.stdout, /uncapped/);
    await runCli(['governance', 'byok-chat-budget', 'set', '--daily-token-cap', '5000', '--soft-warning-pct', 'clear'], opts(fetchImpl, cap));
    assert.deepEqual(calls[1].body, { dailyTokenCap: 5000, softWarningPct: null });
  });
  it('policy set maps the live retention windows + requireMfa and prints host warnings', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { policy: { tenantId: 't1' }, warnings: ['retention.assistantGraphDays is ignored'] } }));
    await runCli(['governance', 'policy', 'set', '--retention-pii-days', '30', '--retention-internal-days', '90', '--require-mfa', 'true', '--body', '{"adSpend":{"approvalThresholdMinor":5000}}'], opts(fetchImpl, cap));
    assert.deepEqual(calls[0].body, { adSpend: { approvalThresholdMinor: 5000 }, retention: { confidentialPiiDays: 30, internalDays: 90 }, requireMfa: true });
    assert.match(cap.stderr, /warning: retention\.assistantGraphDays is ignored/);
  });
  it('audit --format + audit-export write the raw download', async () => {
    const cap = capture();
    const jsonl = '{"proof":true,"verified":true}\n{"seq":1}\n';
    const { calls, fetchImpl } = mockHost(() => ({ raw: jsonl, headers: { 'content-type': 'application/x-ndjson' } }));
    assert.equal(await runCli(['governance', 'audit-export'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, `${H}/governance/audit/export`);
    assert.equal(cap.stdout, jsonl);
    const cap2 = capture();
    await runCli(['governance', 'audit', '--format', 'csv'], opts(fetchImpl, cap2));
    assert.equal(calls[1].search, '?format=csv');
  });
  it('super-admin refusal → exit 4 with the actionable message', async () => {
    const cap = capture();
    assert.equal(await runCli(['governance', 'egress-rules'], opts(mockHost(() => forbidden).fetchImpl, cap)), 4);
    assert.match(cap.stderr, /Governance administration requires a super-admin principal/);
  });
});

describe('toggles admin', () => {
  it('list / features / env-governed render; --json raw', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => ({ body: c.path.endsWith('/configs') ? { configs: [{ id: 'crm', status: 'beta', variants: [{ key: 'A', weight: 100 }], overridden: true }] } : c.path.endsWith('/features') ? { features: [{ id: 'crm', dependsOn: ['orgs'], dependents: [], blockedByDependents: [], packs: [{}] }] } : { capabilities: [{ id: 'context-economy', envVar: 'OPENWOP_CONTEXT_ECONOMY', enabled: true, levers: [] }] } }));
    await runCli(['toggles', 'admin', 'list'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /crm\s+beta\s+A:100\s+yes/);
    await runCli(['toggles', 'admin', 'features'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /crm\s+orgs/);
    await runCli(['toggles', 'admin', 'env-governed'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /context-economy \(OPENWOP_CONTEXT_ECONOMY\): on/);
    assert.deepEqual(calls.map((c) => c.path), [`${H}/feature-toggles/admin/configs`, `${H}/feature-toggles/admin/features`, `${H}/feature-toggles/admin/env-governed`]);
  });
  it('set is read-modify-write (drops display/overlay fields, keeps variants)', async () => {
    const cap = capture();
    const current = { id: 'crm', status: 'off', variants: [{ key: 'A', weight: 100 }], label: 'CRM', overridden: false, defaultDrift: false };
    const { calls, fetchImpl } = mockHost((c) => ({ body: c.method === 'GET' ? current : { ...c.body } }));
    assert.equal(await runCli(['toggles', 'admin', 'set', 'crm', '--status', 'on'], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[1].method, 'PUT');
    assert.deepEqual(calls[1].body, { id: 'crm', status: 'on', variants: [{ key: 'A', weight: 100 }] });
  });
  it('reset needs --yes; refusal → exit 4', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { id: 'crm', status: 'off' } }));
    assert.equal(await runCli(['toggles', 'admin', 'reset', 'crm'], opts(fetchImpl, cap)), 2);
    assert.equal(await runCli(['toggles', 'admin', 'reset', 'crm', '--yes'], opts(fetchImpl, cap)), 0);
    assert.equal(calls[0].method, 'DELETE');
    const cap2 = capture();
    assert.equal(await runCli(['toggles', 'admin', 'list'], opts(mockHost(() => forbidden).fetchImpl, cap2)), 4);
    assert.match(cap2.stderr, /Feature-toggle administration requires a super-admin/);
  });
});

describe('byok active-config', () => {
  it('get / set / clear', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost((c) => (c.method === 'DELETE' ? { status: 204 } : { body: { config: { provider: 'anthropic', model: 'm', credentialRef: 'r' }, stored: true, valid: true } }));
    await runCli(['byok', 'active-config'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /binding: anthropic\/m via r/);
    assert.match(cap.stdout, /valid:\s+yes/);
    await runCli(['byok', 'active-config', 'set', '--provider', 'anthropic', '--model', 'm', '--ref', 'r'], opts(fetchImpl, cap));
    assert.deepEqual([calls[1].method, calls[1].body], ['PUT', { provider: 'anthropic', model: 'm', credentialRef: 'r' }]);
    assert.equal(await runCli(['byok', 'active-config', 'clear'], opts(fetchImpl, cap)), 2);
    assert.equal(await runCli(['byok', 'active-config', 'clear', '--yes'], opts(fetchImpl, cap)), 0);
    assert.equal(calls[2].method, 'DELETE');
    assert.equal(calls[2].path, `${H}/byok/active-config`);
  });
});

describe('admin run-retention', () => {
  it('status / hold / release', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { defaultRetentionDays: 30, exportEnabled: false, holds: [{ tenantId: 't1', reason: 'litigation', createdAt: 'x' }], ok: true, removed: true } }));
    await runCli(['admin', 'run-retention'], opts(fetchImpl, cap));
    assert.match(cap.stdout, /t1 — litigation/);
    await runCli(['admin', 'run-retention', 'hold', 't1', '--reason', 'litigation'], opts(fetchImpl, cap));
    assert.deepEqual([calls[1].path, calls[1].body], [`${H}/admin/run-retention/hold`, { tenantId: 't1', reason: 'litigation' }]);
    await runCli(['admin', 'run-retention', 'release', 'anon:x'], opts(fetchImpl, cap));
    assert.deepEqual([calls[2].method, calls[2].path], ['DELETE', `${H}/admin/run-retention/hold/anon%3Ax`]);
  });
  it('401 → exit 4 naming the admin token; 503 → exit 1', async () => {
    const cap = capture();
    assert.equal(await runCli(['admin', 'run-retention'], opts(mockHost(() => ({ status: 401, body: { error: 'unauthenticated' } })).fetchImpl, cap)), 4);
    assert.match(cap.stderr, /OPENWOP_ADMIN_TOKEN/);
    const cap2 = capture();
    assert.equal(await runCli(['admin', 'run-retention'], opts(mockHost(() => ({ status: 503, body: { error: 'admin_disabled' } })).fetchImpl, cap2)), 1);
  });
});

describe('brand asset / analytics rollup / workspaces migrate-anon', () => {
  it('brand asset uploads base64 with the inferred content type', async () => {
    const cap = capture();
    const png = tmpFile('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]));
    const { calls, fetchImpl } = mockHost(() => ({ status: 201, body: { url: '/media/brand/x.png' } }));
    assert.equal(await runCli(['brand', 'asset', '--slot', 'mark', '--file', png], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, `${H}/app-brand/assets`);
    assert.equal(calls[0].body.contentType, 'image/png');
    assert.equal(calls[0].body.slot, 'mark');
    assert.equal(Buffer.from(calls[0].body.contentBase64, 'base64')[1], 0x50);
    assert.match(cap.stdout, /brand set --logo '\/media\/brand\/x\.png'/);
  });
  it('analytics rollup renders unknown cost as ?', async () => {
    const cap = capture();
    const { calls, fetchImpl } = mockHost(() => ({ body: { rollup: [{ provider: 'anthropic', model: 'm', calls: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.0012 }, { provider: 'x', model: 'y', calls: 1, inputTokens: 1, outputTokens: 1 }] } }));
    await runCli(['usage', 'rollup', 'o1'], opts(fetchImpl, cap));
    assert.equal(calls[0].path, `${H}/usage/orgs/o1/rollup`);
    assert.match(cap.stdout, /anthropic\s+m\s+2\s+10\s+5\s+0\.0012/);
    assert.match(cap.stdout, /x\s+y\s+1\s+1\s+1\s+\?/);
  });
  it('workspaces migrate-anon sends the cookie header only', async () => {
    const cap = capture();
    const file = tmpFile('cookie', 'abc.def\n');
    const { calls, fetchImpl } = mockHost(() => ({ body: { migrated: true, runs: 3, workflows: 1, notifications: 0, secrets: 1 } }));
    assert.equal(await runCli(['workspaces', 'migrate-anon', '--session-file', file], opts(fetchImpl, cap)), 0, cap.stderr);
    assert.equal(calls[0].path, `${H}/migrate-tenant`);
    assert.equal(calls[0].headers.cookie, '__session=abc.def');
    assert.match(cap.stdout, /runs=3/);
    assert.doesNotMatch(cap.stdout, /abc\.def/);
  });
});

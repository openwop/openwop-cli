// Run via `npm test` (builds dist/ first). analytics / marketplace / connections / workspace extensions.
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const H = '/v1/host/openwop-app';
const tmp = () => mkdtempSync(join(tmpdir(), 'owcli-'));

describe('analytics (extended)', () => {
  it('summary/events pass --days; trend requires it', async () => {
    const host = mockHost(() => json({ summary: {}, events: [], trend: [] }));
    await runCli(['analytics', 'summary', 'o1', '--days', '30'], opts(host, capture()));
    assert.deepEqual(host.last().query, { days: '30' });
    await runCli(['analytics', 'events', 'o1', '--days', '7', '--json'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/analytics/orgs/o1/events`);
    const cap = capture();
    assert.equal(await runCli(['analytics', 'trend', 'o1'], opts(host, cap)), 2);
    await runCli(['analytics', 'trend', 'o1', '--days', '90'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/analytics/orgs/o1/trend`);
    assert.deepEqual(host.last().query, { days: '90' });
  });

  it('nav report table + nav record body', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { weeks: [], rows: [{ route: '/crm', source: 'sidebar', count: 3 }] } : { recorded: true }, c.method === 'GET' ? 200 : 202));
    const cap = capture();
    await runCli(['analytics', 'nav', 'report'], opts(host, cap));
    assert.match(cap.stdout, /\/crm\s+sidebar\s+3/);
    await runCli(['analytics', 'nav', 'record', '--route', '/crm', '--source', 'palette'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/analytics/nav`);
    assert.deepEqual(host.last().body, { route: '/crm', source: 'palette' });
  });
});

describe('marketplace (extended)', () => {
  it('pack-enablement set / certify from a manifest file / packs remove --purge', async () => {
    const host = mockHost(() => json({ passed: true, errors: [], warnings: [] }));
    await runCli(['marketplace', 'pack-enablement', 'set', 'acme.crm', '--no-enabled'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/marketplace/pack-enablement/acme.crm`);
    assert.deepEqual(host.last().body, { enabled: false });
    const file = join(tmp(), 'm.json');
    writeFileSync(file, JSON.stringify({ kind: 'connection', name: 'x' }));
    await runCli(['marketplace', 'certify', '--manifest-file', file], opts(host, capture()));
    assert.deepEqual(host.last().body, { manifest: { kind: 'connection', name: 'x' } });
    let cap = capture();
    assert.equal(await runCli(['marketplace', 'packs', 'remove', 'acme.crm', '--purge'], opts(host, cap)), 2);
    await runCli(['marketplace', 'packs', 'remove', 'acme.crm', '--purge', '--yes'], opts(host, capture()));
    assert.equal(host.last().method, 'DELETE');
    assert.deepEqual(host.last().query, { purge: 'true' });
  });

  it('packs restore as a non-superadmin → exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden' }, 403));
    const cap = capture();
    assert.equal(await runCli(['marketplace', 'packs', 'restore', 'acme.crm'], opts(host, cap)), 4);
    assert.equal(host.last().path, `${H}/marketplace/packs/acme.crm/restore`);
  });
});

describe('connections (extended)', () => {
  const advertised = (handler) => {
    const host = mockHost(handler);
    const inner = host.fetchImpl;
    host.fetchImpl = async (url, init) => (new URL(url).pathname.endsWith('/.well-known/openwop')
      ? json({ protocolVersion: '1.0', paths: { '/v1/host/openwop-app/connections': {} } })
      : inner(url, init));
    return host;
  };

  it('inbound set reads the signing secret from a file and never prints it', async () => {
    const file = join(tmp(), 'sec');
    writeFileSync(file, 'shh-signing-secret\n');
    const host = advertised(() => json({ config: { connectionId: 'conn:1', enabled: true }, ingestUrl: 'https://h/in' }, 201));
    const cap = capture();
    assert.equal(await runCli(['connections', 'inbound', 'set', 'conn:1', '--signing-secret-file', file, '--workflow-id', 'wf'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PUT');
    assert.equal(host.last().path, `${H}/connections/conn%3A1/inbound`);
    assert.deepEqual(host.last().body, { signingSecret: 'shh-signing-secret', workflowId: 'wf' });
    assert.doesNotMatch(cap.stdout + cap.stderr, /shh-signing-secret/);
  });

  it('providers lists the catalog; providers <id> reads one; secrets are redacted', async () => {
    const host = advertised((c) => json(c.path.endsWith('/providers') ? { providers: [{ id: 'slack', label: 'Slack', authFlow: 'oauth2', oauthConfigured: true }] } : { id: 'slack', clientSecret: 'nope' }));
    let cap = capture();
    await runCli(['connections', 'providers'], opts(host, cap));
    assert.match(cap.stdout, /slack\s+Slack\s+oauth2\s+true/);
    cap = capture();
    await runCli(['connections', 'providers', 'slack', '--json'], opts(host, cap));
    assert.equal(host.last().path, `${H}/providers/slack`);
    assert.equal(JSON.parse(cap.stdout).clientSecret, '[redacted]');
  });

  it('delete needs --yes; 403 → exit 4', async () => {
    const host = advertised(() => json({ error: 'forbidden_scope' }, 403));
    let cap = capture();
    assert.equal(await runCli(['connections', 'delete', 'conn:1'], opts(host, cap)), 2);
    cap = capture();
    assert.equal(await runCli(['connections', 'delete', 'conn:1', '--yes'], opts(host, cap)), 4);
  });
});

describe('workspace op (test seam)', () => {
  it('POSTs the explicit owner + op', async () => {
    const host = mockHost(() => json({ files: [] }));
    await runCli(['workspace', 'op', '--tenant', 't1', '--workspace', 'default', '--op', 'list', '--prefix', 'notes/'], opts(host, capture()));
    assert.equal(host.last().path, `${H}/workspace/op`);
    assert.deepEqual(host.last().body, { tenant: 't1', workspace: 'default', op: 'list', prefix: 'notes/' });
  });
});

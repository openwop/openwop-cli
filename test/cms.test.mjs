// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

const O = '/v1/host/openwop-app/cms/orgs/org_1';

describe('cms — scheduling, shared sections, localization, experiments, seo', () => {
  it('schedule publish POSTs {at}; clear-publish DELETEs', async () => {
    const host = mockHost(() => json({ pageId: 'p1' }));
    let cap = capture();
    assert.equal(await runCli(['cms', 'schedule', 'publish', 'p/1', '--org', 'org_1', '--at', '2026-10-01T09:00:00Z'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'POST');
    assert.equal(host.last().path, `${O}/pages/p%2F1/schedule`);
    assert.deepEqual(host.last().body, { at: '2026-10-01T09:00:00Z' });
    cap = capture();
    assert.equal(await runCli(['cms', 'schedule', 'clear-unpublish', 'p1', '--org', 'org_1'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'DELETE');
    assert.equal(host.last().path, `${O}/pages/p1/schedule-unpublish`);
  });

  it('schedule publish without --at is a usage error, no request', async () => {
    const host = mockHost();
    const cap = capture();
    assert.equal(await runCli(['cms', 'schedule', 'publish', 'p1', '--org', 'org_1'], opts(host, cap)), 2);
    assert.match(cap.stderr, /--at is required/);
    assert.equal(host.calls.length, 0);
  });

  it('shared-sections lists as a table and --json prints the raw body', async () => {
    const body = { sharedSections: [{ sharedSectionId: 'ss1', name: 'Footer', type: 'footer', updatedAt: 'd' }] };
    const host = mockHost(() => json(body));
    let cap = capture();
    assert.equal(await runCli(['cms', 'shared-sections', '--org', 'org_1'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().path, `${O}/shared-sections`);
    assert.match(cap.stdout, /ss1\s+Footer\s+footer\s+d/);
    cap = capture();
    assert.equal(await runCli(['cms', 'shared-sections', '--org', 'org_1', '--json'], opts(host, cap)), 0);
    assert.deepEqual(JSON.parse(cap.stdout), body);
  });

  it('shared-sections update PATCHes parsed JSON; delete needs --yes', async () => {
    const host = mockHost(() => json({}));
    let cap = capture();
    await runCli(['cms', 'shared-sections', 'update', 'ss1', '--org', 'org_1', '--data', '{"text":"hi"}'], opts(host, cap));
    assert.equal(host.last().method, 'PATCH');
    assert.deepEqual(host.last().body, { data: { text: 'hi' } });
    cap = capture();
    assert.equal(await runCli(['cms', 'shared-sections', 'delete', 'ss1', '--org', 'org_1'], opts(host, cap)), 2);
    assert.equal(host.calls.length, 1);
  });

  it('language-settings set sends only the given fields; locale-grants set sends a list', async () => {
    const host = mockHost(() => json({}));
    let cap = capture();
    await runCli(['cms', 'language-settings', 'set', '--org', 'org_1', '--supported-locales', 'es,fr', '--auto-translate-on-publish', 'true'], opts(host, cap));
    assert.equal(host.last().method, 'PUT');
    assert.deepEqual(host.last().body, { supportedLocales: ['es', 'fr'], autoTranslateOnPublish: true });
    cap = capture();
    await runCli(['cms', 'locale-grants', 'set', '--org', 'org_1', '--subject', 'u1', '--locales', 'es'], opts(host, cap));
    assert.equal(host.last().path, `${O}/locale-grants`);
    assert.deepEqual(host.last().body, { subject: 'u1', locales: ['es'] });
  });

  it('locales publish hits the per-locale route', async () => {
    const host = mockHost(() => json({}));
    const cap = capture();
    await runCli(['cms', 'locales', 'publish', 'p1', 'pt-BR', '--org', 'org_1'], opts(host, cap));
    assert.equal(host.last().path, `${O}/pages/p1/locales/pt-BR/publish`);
  });

  it('seo set is read-modify-write against the publishing route', async () => {
    const seo = { metaTitle: 'Old', canonicalUrl: 'https://a.example', noindex: false };
    const host = mockHost((c) => json(c.method === 'GET' ? { seo } : { seo: {} }));
    const cap = capture();
    assert.equal(await runCli(['cms', 'seo', 'set', 'p1', '--org', 'org_1', '--meta-description', 'New', '--noindex', 'true'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.calls[0].method, 'GET');
    assert.equal(host.last().path, '/v1/host/openwop-app/publishing/orgs/org_1/pages/p1/seo');
    assert.deepEqual(host.last().body, { metaTitle: 'Old', canonicalUrl: 'https://a.example', noindex: true, metaDescription: 'New' });
  });

  it('experiments create / promote / results', async () => {
    const host = mockHost(() => json({ experimentId: 'pexp:1' }));
    let cap = capture();
    await runCli(['cms', 'experiments', 'create', 'p1', '--org', 'org_1', '--name', 'Hero', '--variants', '[{"key":"a","weight":100}]'], opts(host, cap));
    assert.equal(host.last().path, `${O}/pages/p1/experiments`);
    assert.deepEqual(host.last().body, { name: 'Hero', variants: [{ key: 'a', weight: 100 }] });
    cap = capture();
    await runCli(['cms', 'experiments', 'promote', 'p1', 'pexp:1', '--org', 'org_1', '--variant-key', 'a'], opts(host, cap));
    assert.equal(host.last().path, `${O}/pages/p1/experiments/pexp%3A1/promote`);
    assert.deepEqual(host.last().body, { variantKey: 'a' });
    cap = capture();
    await runCli(['cms', 'experiments', 'results', 'p1', 'pexp:1', '--org', 'org_1'], opts(host, cap));
    assert.equal(host.last().method, 'GET');
    assert.equal(host.last().path, `${O}/pages/p1/experiments/pexp%3A1/results`);
  });

  it('the hand-written pages commands still work beside the table', async () => {
    const host = mockHost(() => json({ pages: [{ id: 'p1', title: 'T', slug: 's', status: 'draft' }] }));
    const cap = capture();
    assert.equal(await runCli(['cms', 'pages', 'list', '--org', 'org_1'], opts(host, cap)), 0);
    assert.match(cap.stdout, /p1\s+T\s+s\s+draft/);
  });

  it('403 → legible HTTP line and exit 4', async () => {
    const host = mockHost(() => json({ error: 'forbidden_scope', message: 'Admins only.' }, 403));
    const cap = capture();
    assert.equal(await runCli(['cms', 'locale-grants', '--org', 'org_1'], opts(host, cap)), 4);
    assert.match(cap.stderr, /HTTP 403 forbidden_scope: Admins only\./);
  });
});

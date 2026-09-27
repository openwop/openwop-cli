// Run via `npm test` (builds dist/ first).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCli } from '../dist/cli.js';
import { capture, json, mockHost, opts } from './_routekit-helpers.mjs';

describe('kb — retrieval, media ingest, reindex controls', () => {
  const C = '/v1/host/openwop-app/kb/orgs/org_1/collections/kc_1';
  it('collections retrieval PATCHes only the given fields', async () => {
    const host = mockHost(() => json({ collection: {} }));
    const cap = capture();
    assert.equal(await runCli(['kb', 'collections', 'retrieval', 'kc_1', '--org', 'org_1', '--mode', 'hybrid', '--rerank', '{"kind":"local"}'], opts(host, cap)), 0, cap.stderr);
    assert.equal(host.last().method, 'PATCH');
    assert.equal(host.last().path, `${C}/retrieval`);
    assert.deepEqual(host.last().body, { mode: 'hybrid', rerank: { kind: 'local' } });
  });
  it('reindex drain sends maxChunks as a number; cancel POSTs {}', async () => {
    const host = mockHost(() => json({ status: 'running' }));
    let cap = capture();
    await runCli(['kb', 'collections', 'reindex', 'drain', 'kc_1', '--org', 'org_1', '--max-chunks', '512'], opts(host, cap));
    assert.equal(host.last().path, `${C}/reindex/drain`);
    assert.deepEqual(host.last().body, { maxChunks: 512 });
    cap = capture();
    await runCli(['kb', 'collections', 'reindex', 'cancel', 'kc_1', '--org', 'org_1'], opts(host, cap));
    assert.equal(host.last().path, `${C}/reindex/cancel`);
  });
  it('ingest-media requires --media-collection-id', async () => {
    const host = mockHost();
    const cap = capture();
    assert.equal(await runCli(['kb', 'collections', 'ingest-media', 'kc_1', '--org', 'org_1'], opts(host, cap)), 2);
    assert.equal(host.calls.length, 0);
  });
  it('404 (no reindex job) → exit 2', async () => {
    const host = mockHost(() => json({ error: 'not_found', message: 'No reindex job for this collection.' }, 404));
    const cap = capture();
    assert.equal(await runCli(['kb', 'collections', 'reindex', 'cancel', 'kc_1', '--org', 'org_1'], opts(host, cap)), 2);
    assert.match(cap.stderr, /HTTP 404 not_found: No reindex job/);
  });
});

describe('forms — templates', () => {
  it('templates lists; from-template POSTs templateId + title', async () => {
    const host = mockHost((c) => json(c.method === 'GET' ? { templates: [{ templateId: 't1', label: 'Contact', title: 'Contact us', packName: 'p', packVersion: '1.0.0' }] } : { formId: 'f1' }, c.method === 'GET' ? 200 : 201));
    let cap = capture();
    await runCli(['forms', 'templates', '--org', 'org_1'], opts(host, cap));
    assert.equal(host.last().path, '/v1/host/openwop-app/forms/orgs/org_1/form-templates');
    assert.match(cap.stdout, /t1\s+Contact\s+Contact us\s+p\s+1\.0\.0/);
    cap = capture();
    await runCli(['forms', 'from-template', '--org', 'org_1', '--template-id', 't1', '--title', 'Hi'], opts(host, cap));
    assert.equal(host.last().path, '/v1/host/openwop-app/forms/orgs/org_1/forms/from-template');
    assert.deepEqual(host.last().body, { templateId: 't1', title: 'Hi' });
  });
});

describe('chat-widget — tool catalog', () => {
  it('tool-catalog GETs the org catalog; --json is raw', async () => {
    const host = mockHost(() => json({ tools: ['openwop:schema.lookup'] }));
    const cap = capture();
    assert.equal(await runCli(['chat-widget', 'tool-catalog', '--org', 'org_1', '--json'], opts(host, cap)), 0);
    assert.equal(host.last().path, '/v1/host/openwop-app/chat-widget/orgs/org_1/tool-catalog');
    assert.deepEqual(JSON.parse(cap.stdout), { tools: ['openwop:schema.lookup'] });
  });
});

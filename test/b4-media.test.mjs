import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';

function capture() { let o = '', e = ''; return { io: { stdout: { write: (s) => { o += s; } }, stderr: { write: (s) => { e += s; } } }, get stdout() { return o; }, get stderr() { return e; } }; }
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const dir = mkdtempSync(join(tmpdir(), 'owp-media-'));
const ctx = (cap, f) => ({ io: cap.io, fetchImpl: f, cwd: dir, repoRoot: dir, env: { OPENWOP_CONFIG_HOME: '/nonexistent-owp-test', OPENWOP_API_KEY: 'k' } });

/** Mock that records non-discovery calls and answers with `reply(call)`. */
function recorder(reply) {
  const calls = [];
  const f = async (u, i = {}) => {
    const url = new URL(u);
    if (url.pathname.includes('.well-known')) return json({}, 404);
    const call = { method: i.method ?? 'GET', path: url.pathname, search: url.search, body: i.body ? JSON.parse(i.body) : undefined, headers: i.headers ?? {} };
    calls.push(call);
    return reply(call);
  };
  return { calls, f };
}
const B = '/v1/host/openwop-app/media/orgs/o1';

describe('media library assets', () => {
  it('list GETs /assets with filters and renders a table', async () => {
    const cap = capture();
    const r = recorder(() => json({ assets: [{ assetId: 'a1', name: 'logo.png', contentType: 'image/png', sizeBytes: 10, tags: ['brand'] }] }));
    const code = await runCli(['media', 'assets', 'list', '--org', 'o1', '--tag', 'brand', '--q', 'logo'], ctx(cap, r.f));
    assert.equal(code, 0);
    assert.equal(r.calls[0].method, 'GET');
    assert.ok(r.calls[0].path.endsWith(`${B}/assets`));
    assert.equal(r.calls[0].search, '?q=logo&tag=brand');
    assert.match(cap.stdout, /a1\s+logo\.png\s+image\/png\s+10\s+brand/);
  });

  it('list --json prints the raw body', async () => {
    const cap = capture();
    const r = recorder(() => json({ assets: [] }));
    await runCli(['--json', 'media', 'assets', 'list', '--org', 'o1'], ctx(cap, r.f));
    assert.deepEqual(JSON.parse(cap.stdout), { assets: [] });
  });

  it('create reads a local file and POSTs base64 JSON', async () => {
    const file = join(dir, 'pic.png');
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const cap = capture();
    const r = recorder(() => json({ assetId: 'a9', name: 'pic.png' }, 201));
    const code = await runCli(['media', 'assets', 'create', 'pic.png', '--org', 'o1', '--tags', 'x,y', '--collection', 'c1'], ctx(cap, r.f));
    assert.equal(code, 0);
    assert.equal(r.calls[0].method, 'POST');
    assert.ok(r.calls[0].path.endsWith(`${B}/assets`));
    assert.deepEqual(r.calls[0].body, { name: 'pic.png', collectionId: 'c1', tags: ['x', 'y'], contentBase64: 'AQID', contentType: 'image/png' });
    assert.match(cap.stdout, /Created asset a9/);
  });

  it('bulk POSTs items[] from several files', async () => {
    writeFileSync(join(dir, 'a.jpg'), 'A'); writeFileSync(join(dir, 'b.webp'), 'B');
    const cap = capture();
    const r = recorder(() => json({ results: [{ name: 'a.jpg', status: 'created', asset: { assetId: 'x' } }] }, 207));
    await runCli(['media', 'assets', 'bulk', 'a.jpg', 'b.webp', '--org', 'o1'], ctx(cap, r.f));
    assert.ok(r.calls[0].path.endsWith(`${B}/assets/bulk`));
    assert.deepEqual(r.calls[0].body.items.map((i) => [i.name, i.contentType]), [['a.jpg', 'image/jpeg'], ['b.webp', 'image/webp']]);
    assert.match(cap.stdout, /a\.jpg\s+created\s+x/);
  });

  it('update PATCHes fields; --no-collection sends null', async () => {
    const cap = capture();
    const r = recorder(() => json({ assetId: 'a1' }));
    await runCli(['media', 'assets', 'update', 'a/1', '--org', 'o1', '--alt-text', 'A logo', '--no-collection'], ctx(cap, r.f));
    assert.equal(r.calls[0].method, 'PATCH');
    assert.ok(r.calls[0].path.endsWith(`${B}/assets/a%2F1`));
    assert.deepEqual(r.calls[0].body, { altText: 'A logo', collectionId: null });
  });

  it('delete refuses without --yes, DELETEs with it', async () => {
    let cap = capture();
    const r = recorder(() => new Response(null, { status: 204 }));
    assert.equal(await runCli(['media', 'assets', 'delete', 'a1', '--org', 'o1'], ctx(cap, r.f)), 2);
    assert.equal(r.calls.length, 0);
    cap = capture();
    assert.equal(await runCli(['media', 'assets', 'delete', 'a1', '--org', 'o1', '--yes'], ctx(cap, r.f)), 0);
    assert.equal(r.calls[0].method, 'DELETE');
  });

  it('usage/use/alt-text/autotag hit their subpaths', async () => {
    const r = recorder((c) => json(c.path.endsWith('/usage') ? { usage: [] } : { proposal: { tags: ['t'] }, usageCount: 1 }));
    for (const sub of ['usage', 'use', 'alt-text', 'autotag']) await runCli(['media', 'assets', sub, 'a1', '--org', 'o1'], ctx(capture(), r.f));
    assert.deepEqual(r.calls.map((c) => [c.method, c.path.split('/a1')[1]]), [['GET', '/usage'], ['POST', '/use'], ['POST', '/alt-text'], ['POST', '/autotag']]);
  });

  it('select POSTs criteria', async () => {
    const r = recorder(() => json({ assets: [] }));
    await runCli(['media', 'assets', 'select', '--org', 'o1', '--product', 'p', '--persona-ids', 'a,b', '--limit', '3'], ctx(capture(), r.f));
    assert.ok(r.calls[0].path.endsWith(`${B}/assets/select`));
    assert.deepEqual(r.calls[0].body, { product: 'p', personaIds: ['a', 'b'], limit: 3 });
  });

  it('generate / ai-edit / ai-upscale POST the image-gen bodies', async () => {
    const r = recorder(() => json({ assets: [{ assetId: 'g1', name: 'g.png' }] }, 201));
    await runCli(['media', 'assets', 'generate', '--org', 'o1', '--prompt', 'a cat', '--provider', 'openai', '--n', '2'], ctx(capture(), r.f));
    await runCli(['media', 'assets', 'ai-edit', 'a1', '--org', 'o1', '--op', 'background-remove'], ctx(capture(), r.f));
    await runCli(['media', 'assets', 'ai-upscale', 'a1', '--org', 'o1', '--scale', '4'], ctx(capture(), r.f));
    assert.ok(r.calls[0].path.endsWith(`${B}/assets/generate`));
    assert.deepEqual(r.calls[0].body, { prompt: 'a cat', provider: 'openai', n: 2 });
    assert.ok(r.calls[1].path.endsWith(`${B}/assets/a1/ai-edit`));
    assert.deepEqual(r.calls[1].body, { op: 'background-remove' });
    assert.ok(r.calls[2].path.endsWith(`${B}/assets/a1/ai-upscale`));
    assert.deepEqual(r.calls[2].body, { scale: 4 });
  });

  it('403 → legible message + exit 4', async () => {
    const cap = capture();
    const r = recorder(() => json({ error: 'forbidden', message: 'workspace:read required' }, 403));
    const code = await runCli(['media', 'assets', 'list', '--org', 'o1'], ctx(cap, r.f));
    assert.equal(code, 4);
    assert.match(cap.stderr, /HTTP 403: workspace:read required/);
  });

  it('requires --org', async () => {
    const cap = capture();
    assert.equal(await runCli(['media', 'assets', 'list'], ctx(cap, recorder(() => json({})).f)), 2);
    assert.match(cap.stderr, /--org/);
  });
});

describe('media collections + image-providers', () => {
  it('collections list/create/delete', async () => {
    const r = recorder((c) => json(c.method === 'GET' ? { collections: [{ collectionId: 'c1', name: 'Brand' }] } : { collectionId: 'c2' }));
    const cap = capture();
    await runCli(['media', 'collections', 'list', '--org', 'o1'], ctx(cap, r.f));
    assert.match(cap.stdout, /c1\s+Brand/);
    await runCli(['media', 'collections', 'create', 'Hero', 'shots', '--org', 'o1'], ctx(capture(), r.f));
    await runCli(['media', 'collections', 'delete', 'c1', '--org', 'o1', '--yes'], ctx(capture(), r.f));
    assert.deepEqual(r.calls.map((c) => [c.method, c.path.split('/o1')[1]]), [['GET', '/collections'], ['POST', '/collections'], ['DELETE', '/collections/c1']]);
    assert.deepEqual(r.calls[1].body, { name: 'Hero shots' });
  });

  it('image-providers GETs and renders', async () => {
    const cap = capture();
    const r = recorder(() => json({ providers: [{ provider: 'openai', credentialRefs: ['openai:k'], ops: ['generate'] }] }));
    await runCli(['media', 'image-providers', '--org', 'o1'], ctx(cap, r.f));
    assert.ok(r.calls[0].path.endsWith(`${B}/image-providers`));
    assert.match(cap.stdout, /openai\s+openai:k\s+generate/);
  });
});

describe('media capability-token assets', () => {
  it('upload POSTs base64 JSON with name; put sends ttlSeconds', async () => {
    writeFileSync(join(dir, 'doc.pdf'), 'PDF');
    const r = recorder(() => json({ token: 't1', url: '/v1/host/openwop-app/assets/t1', bytes: 3 }, 201));
    const cap = capture();
    await runCli(['media', 'upload', 'doc.pdf'], ctx(cap, r.f));
    await runCli(['media', 'put', 'doc.pdf', '--ttl-seconds', '60', '--content-type', 'text/plain'], ctx(capture(), r.f));
    assert.ok(r.calls[0].path.endsWith('/v1/host/openwop-app/media/upload'));
    assert.deepEqual(r.calls[0].body, { contentBase64: Buffer.from('PDF').toString('base64'), contentType: 'application/pdf', name: 'doc.pdf' });
    assert.match(cap.stdout, /token\s+t1/);
    assert.ok(r.calls[1].path.endsWith('/v1/host/openwop-app/media/put'));
    assert.deepEqual(r.calls[1].body, { contentBase64: Buffer.from('PDF').toString('base64'), contentType: 'text/plain', ttlSeconds: 60 });
  });

  it('upload with an unknown extension and no --content-type is a usage error', async () => {
    writeFileSync(join(dir, 'blob.xyz'), 'z');
    const cap = capture();
    assert.equal(await runCli(['media', 'upload', 'blob.xyz'], ctx(cap, recorder(() => json({})).f)), 2);
    assert.match(cap.stderr, /content type/);
  });

  it('fetch GETs /assets/:token and writes the bytes', async () => {
    const r = recorder(() => new Response(Buffer.from([9, 8, 7]), { status: 200, headers: { 'content-type': 'image/png' } }));
    const cap = capture();
    const code = await runCli(['media', 'fetch', 'tok/1', '--output', 'out.png'], ctx(cap, r.f));
    assert.equal(code, 0);
    assert.ok(r.calls[0].path.endsWith('/v1/host/openwop-app/assets/tok%2F1'));
    assert.deepEqual([...readFileSync(join(dir, 'out.png'))], [9, 8, 7]);
    assert.match(cap.stdout, /Wrote 3 bytes/);
  });

  it('fetch of an expired token exits 2 with a legible message', async () => {
    const cap = capture();
    const code = await runCli(['media', 'fetch', 'gone', '--output', 'x.bin'], ctx(cap, recorder(() => json({ error: 'not_found', message: 'asset not found or expired' }, 404)).f));
    assert.equal(code, 2);
    assert.match(cap.stderr, /asset not found or expired/);
  });
});

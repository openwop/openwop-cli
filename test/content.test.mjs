// Run via `npm test` (builds dist/ first) — imports the esbuild bundle at ../dist/cli.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

function json(body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fake v1 host: `/.well-known/openwop` advertises protocol 1.x (so paths are
 * sent exactly as written); every other request is recorded and answered by
 * `handler(method, path, body, url)`.
 */
function fakeHost(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/.well-known/openwop') return json({ protocolVersions: ['1.1'] });
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers ?? {} });
    return handler(method, u.pathname, body, u);
  };
  return { fetchImpl, calls };
}

async function run(argv, handler, env = {}) {
  const cap = capture();
  const { fetchImpl, calls } = fakeHost(handler);
  const code = await runCli(argv, { io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', ...env } });
  return { code, stdout: cap.stdout, stderr: cap.stderr, calls };
}

const forbidden = () => json({ error: 'forbidden', message: 'Missing required scope' }, 403);

describe('content (RFC 0103, normative /v1/content/*)', () => {
  it('page delivers a published page with Accept-Language from --locale', async () => {
    const r = await run(['content', 'page', 'pricing', '--locale', 'es'], () => json({
      version: '1', locale: 'es', slug: 'pricing', page: { pageId: 'p1', slug: 'pricing', name: 'Pricing' },
      sections: [{ sectionId: 'hero', sectionType: 'hero', data: { title: 'Precios' } }],
    }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'GET');
    assert.equal(r.calls[0].path, '/v1/content/pages/pricing');
    assert.equal(r.calls[0].headers['accept-language'], 'es');
    assert.match(r.stdout, /locale: es/);
    assert.match(r.stdout, /hero \[hero\] \{"title":"Precios"\}/);
  });

  it('pages lists the tenant pages (and --json passes the body through)', async () => {
    const pages = [{ pageId: 'p1', slug: 'pricing', name: 'Pricing', status: 'draft', sectionOrder: ['hero'] }];
    let r = await run(['content', 'pages'], () => json(pages));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /p1\s+pricing\s+Pricing\s+draft\s+1/);
    r = await run(['--json', 'content', 'pages'], () => json(pages));
    assert.deepEqual(JSON.parse(r.stdout), pages);
  });

  it('create POSTs slug/name/sectionOrder and --publish sets status', async () => {
    const r = await run(['content', 'create', '--slug', 'pricing', '--name', 'Pricing', '--section-order', 'hero,faq', '--publish'],
      (m, p, body) => json({ pageId: 'p9', slug: body.slug, status: 'published' }, 201));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].path, '/v1/content/pages');
    assert.deepEqual(r.calls[0].body, { slug: 'pricing', name: 'Pricing', sectionOrder: ['hero', 'faq'], status: 'published' });
    assert.match(r.stdout, /Created page p9/);
  });

  it('section PUTs { locale, data }', async () => {
    const r = await run(['content', 'section', 'p1', 'hero', '--locale', 'es', '--data-json', '{"title":"Hola"}'],
      () => json({ sectionId: 'hero' }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'PUT');
    assert.equal(r.calls[0].path, '/v1/content/pages/p1/sections/hero');
    assert.deepEqual(r.calls[0].body, { locale: 'es', data: { title: 'Hola' } });
  });

  it('delete needs --yes, then DELETEs by pageId', async () => {
    let r = await run(['content', 'delete', 'p1'], () => json(undefined, 204));
    assert.equal(r.code, 2);
    assert.equal(r.calls.length, 0);
    r = await run(['content', 'delete', 'p1', '--yes'], () => new Response(null, { status: 204 }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'DELETE');
    assert.equal(r.calls[0].path, '/v1/content/pages/p1');
  });

  it('settings renders the language settings', async () => {
    const r = await run(['content', 'settings'], () => json({ baseLocale: 'en', supportedLocales: ['es', 'fr'], autoTranslateOnPublish: false }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /baseLocale: en/);
    assert.match(r.stdout, /supportedLocales: es, fr/);
  });

  it('a 501 (content unsupported) fails closed with exit 1', async () => {
    const r = await run(['content', 'pages'], () => json({ error: 'capability_not_provided', message: 'content unsupported' }, 501));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /content pages: content unsupported/);
  });

  it('a 403 exits 4 with a legible message', async () => {
    const r = await run(['content', 'settings'], forbidden);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /403/);
  });
});

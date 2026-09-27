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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Pin protocol major 1 so the mock sees the literal /v1/host/openwop-app paths (no discovery fetch).
const opts = (fetchImpl, cap) => ({ io: cap.io, fetchImpl, cwd: process.cwd(), repoRoot: process.cwd(), env: { OPENWOP_API_KEY: 'k', OPENWOP_PROTOCOL_MAJOR: '1' } });

/** A fetch mock that records every call and answers from `reply(url, init)`. */
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    let body;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method: init.method ?? 'GET', path: u.pathname, search: u.search, body, headers: init.headers ?? {}, redirect: init.redirect });
    return reply(u, init);
  };
  return { calls, fetchImpl };
}
const lines = (r) => r.calls.map((c) => `${c.method} ${c.path}${c.search}`);
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const P = '/v1/host/openwop-app/public/org_1';
const text = (body, type) => new Response(body, { status: 200, headers: { 'content-type': type } });

describe('public command', () => {
  it('pages / page / blog / podcasts read JSON anonymously', async () => {
    const cap = capture();
    const r = recorder((u) => {
      if (u.pathname.endsWith('/pages')) return json({ pages: [{ slug: 'about', title: 'About' }] });
      if (u.pathname.endsWith('/docs')) return json({ docs: [{ slug: 'intro', title: 'Intro' }] });
      if (u.pathname.endsWith('/blog')) return json({ posts: [{ slug: 'p1', title: 'Hello', author: 'ann' }] });
      if (u.pathname.endsWith('/podcasts')) return json({ shows: [{ slug: 'show', title: 'Show', episodeCount: 3 }] });
      return json({ slug: 'about', title: 'About' });
    });
    for (const argv of [['pages', 'org_1'], ['page', 'org_1', 'about', '--vk', 'v1'], ['blog', 'org_1', '--tag', 't', '--author', 'ann'], ['podcasts', 'org_1']]) {
      assert.equal(await runCli(['public', ...argv], opts(r.fetchImpl, cap)), 0, cap.stderr);
    }
    assert.deepEqual(lines(r), [`GET ${P}/pages`, `GET ${P}/pages/about?vk=v1`, `GET ${P}/blog?tag=t&author=ann`, `GET ${P}/podcasts`]);
    assert.ok(r.calls.every((c) => !c.headers.authorization), 'no bearer on the public surface');
    assert.match(cap.stdout, /about\s+About/);
    assert.match(cap.stdout, /p1\s+Hello/);
    assert.match(cap.stdout, /show\s+Show\s+3/);
  });

  it('text surfaces print verbatim; --json wraps {status, contentType, body}', async () => {
    const cap = capture();
    const r = recorder(() => text('<rss/>', 'application/rss+xml'));
    const cmds = [['feed', 'org_1'], ['blog-feed', 'org_1'], ['sitemap', 'org_1'], ['robots', 'org_1'], ['llms', 'org_1'],
      ['prerender', 'org_1', 'about'], ['blog-prerender', 'org_1'], ['page', 'org_1', 'about', '--markdown'],
      ['podcast-feed', 'org_1', 'show'], ['podcast-prerender', 'org_1', 'show'], ['podcast-prerender', 'org_1', 'show', 'ep-1']];
    for (const argv of cmds) assert.equal(await runCli(['public', ...argv], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.deepEqual(lines(r), [
      `GET ${P}/feed.rss`, `GET ${P}/blog/feed.xml`, `GET ${P}/sitemap.xml`, `GET ${P}/robots.txt`, `GET ${P}/llms.txt`,
      `GET ${P}/prerender/about`, `GET ${P}/blog/prerender`, `GET ${P}/pages/about.md`,
      `GET ${P}/podcasts/show/feed.xml`, `GET ${P}/podcasts/show/prerender`, `GET ${P}/podcasts/show/prerender/ep-1`,
    ]);
    assert.equal(cap.stdout.split('<rss/>').length - 1, cmds.length);
    const cap2 = capture();
    assert.equal(await runCli(['public', 'sitemap', 'org_1', '--json'], opts(r.fetchImpl, cap2)), 0);
    assert.deepEqual(JSON.parse(cap2.stdout), { status: 200, contentType: 'application/rss+xml', body: '<rss/>' });
  });

  it('podcast / episode detail reads', async () => {
    const cap = capture();
    const r = recorder((u) => json(u.pathname.endsWith('/show')
      ? { show: { slug: 'show', title: 'Show', feedUrl: 'https://x/feed.xml' }, episodes: [{ episodeId: 'e1', slug: 'ep-1', title: 'One' }] }
      : { episode: { episodeId: 'e1' } }));
    assert.equal(await runCli(['public', 'podcast', 'org_1', 'show'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['public', 'episode', 'org_1', 'show', 'ep-1'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(lines(r), [`GET ${P}/podcasts/show`, `GET ${P}/podcasts/show/ep-1`]);
    assert.match(cap.stdout, /feed: https:\/\/x\/feed\.xml/);
    assert.match(cap.stdout, /e1\s+ep-1\s+One/);
  });

  it('audio probes with a one-byte range, and --out downloads the bytes', async () => {
    const cap = capture();
    const r = recorder((_u, init) => (init.headers?.range
      ? new Response('I', { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/12345', 'accept-ranges': 'bytes' } })
      : new Response('ID3audio', { status: 200, headers: { 'content-type': 'audio/mpeg' } })));
    assert.equal(await runCli(['public', 'audio', 'org_1', 'e/1'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(r.calls[0].path, `${P}/podcasts/episodes/e%2F1/audio`);
    assert.equal(r.calls[0].headers.range, 'bytes=0-0');
    assert.match(cap.stdout, /contentType: audio\/mpeg/);
    assert.match(cap.stdout, /size: 12345 bytes/);
    const dir = mkdtempSync(join(tmpdir(), 'owp-audio-'));
    const file = join(dir, 'ep.mp3');
    assert.equal(await runCli(['public', 'audio', 'org_1', 'e1', '--out', file], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'ID3audio');
    assert.equal(r.calls[1].headers.range, undefined);
  });

  it('pricing + bundle-pricing hit the org-less public catalog', async () => {
    const cap = capture();
    const r = recorder((u) => json(u.pathname.endsWith('/pricing') && !u.pathname.endsWith('bundle-pricing')
      ? { tiers: [{ id: 'free', name: 'Free', features: ['a', 'b'] }] } : { bundles: [] }));
    assert.equal(await runCli(['public', 'pricing'], opts(r.fetchImpl, cap)), 0, cap.stderr);
    assert.equal(await runCli(['public', 'bundle-pricing'], opts(r.fetchImpl, cap)), 0);
    assert.deepEqual(lines(r), ['GET /v1/host/openwop-app/public/pricing', 'GET /v1/host/openwop-app/public/bundle-pricing']);
    assert.match(cap.stdout, /free\s+Free\s+2/);
    assert.match(cap.stdout, /No feature bundles are for sale/);
  });

  it('a 404 on a text surface is a legible exit 2; a 403 is exit 4; bad arity is a usage error', async () => {
    const cap = capture();
    const r404 = recorder(() => json({ error: 'not_found', message: 'Prerendering is disabled on this host.' }, 404));
    assert.equal(await runCli(['public', 'prerender', 'org_1', 'about'], opts(r404.fetchImpl, cap)), 2);
    assert.match(cap.stderr, /HTTP 404(?: \S+)?: Prerendering is disabled/);
    const r403 = recorder(() => json({ error: 'forbidden', message: 'Forbidden' }, 403));
    assert.equal(await runCli(['public', 'pages', 'org_1'], opts(r403.fetchImpl, cap)), 4);
    assert.equal(await runCli(['public', 'page', 'org_1'], opts(r403.fetchImpl, cap)), 2);
    assert.equal(await runCli(['public', 'podcast-prerender', 'org_1'], opts(r403.fetchImpl, cap)), 2);
    assert.equal(r403.calls.length, 1);
  });
});

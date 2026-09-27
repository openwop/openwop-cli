import type { Ctx } from '../context.js';
/**
 * `openwop public ...` — the anonymous published surface an org's visitors,
 * crawlers and podcast apps read. Every command is unauthenticated (no bearer
 * is sent), exactly as a browser/crawler sees it.
 *
 *   Pages / SEO / feeds  — ADR 0012 (publishing + SEO), ADR 0027 (front page + blog)
 *   Docs + llms.txt      — ADR 0392
 *   Podcasts             — ADR 0390 (public distribution: JSON, iTunes RSS, prerender, audio)
 *   Pricing              — the billing marketing catalog + ADR 0419 bundle pricing
 *
 * Paths: /v1/host/openwop-app/public/{orgId}/... and /v1/host/openwop-app/public/{pricing,bundle-pricing}.
 */
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { requestJson } from '../api.js';
import { writeLine, writeJson } from '../io.js';
import {
  APP, enc, dispatchTable, listOut, detail, qs, requestRaw, writeText, rawJson, type Cmd,
} from './marketingShared.js';

const org = (o: string) => `${APP}/public/${enc(o)}`;

export const PUBLIC_HELP = `Usage:
  openwop public pages <orgId> [--json]
  openwop public page <orgId> <slug> [--vk <visitorKey>] [--markdown] [--json]
  openwop public blog <orgId> [--tag <t>] [--category <c>] [--author <a>] [--json]
  openwop public blog-feed <orgId> [--json]
  openwop public feed <orgId> [--json]
  openwop public sitemap <orgId> [--json]
  openwop public robots <orgId> [--json]
  openwop public llms <orgId> [--json]
  openwop public prerender <orgId> <slug> [--json]
  openwop public blog-prerender <orgId> [--json]
  openwop public podcasts <orgId> [--json]
  openwop public podcast <orgId> <showSlug> [--json]
  openwop public podcast-feed <orgId> <showSlug> [--json]
  openwop public episode <orgId> <showSlug> <episodeSlug> [--json]
  openwop public podcast-prerender <orgId> <showSlug> [<episodeSlug>] [--json]
  openwop public audio <orgId> <episodeId> [--out <file>] [--json]
  openwop public pricing [--json]
  openwop public bundle-pricing [--json]

The anonymous published surface of the demo host — what visitors, crawlers and
podcast apps read. Every command is UNAUTHENTICATED (no bearer is attached), so
it shows exactly what the public sees. Paths:
  GET /v1/host/openwop-app/public/{orgId}/pages[/{slug}|/{slug}.md]   published pages (ADR 0012)
  GET …/public/{orgId}/{sitemap.xml,robots.txt,feed.rss}              SEO + site feed
  GET …/public/{orgId}/blog[/feed.xml|/prerender]                     blog index + RSS (ADR 0027)
  GET …/public/{orgId}/prerender/{slug}                               crawler HTML for one page
  GET …/public/{orgId}/llms.txt                                       published docs index (ADR 0392;
                                                                      the docs list is \`openwop docs public\`)
  GET …/public/{orgId}/podcasts[/{show}[/feed.xml|/prerender[/{ep}]|/{ep}]]  podcasts (ADR 0390)
  GET …/public/{orgId}/podcasts/episodes/{episodeId}/audio           episode audio
  GET /v1/host/openwop-app/public/{pricing,bundle-pricing}           pricing (ADR 0419)

Text surfaces (XML, RSS, Markdown, robots, llms.txt, prerendered HTML) print
verbatim; --json wraps them as {status, contentType, body}. 'page --markdown'
reads the page's Markdown rendering. 'audio' without --out probes the file
(a one-byte ranged read) and reports its type and total size; with --out it
downloads the whole episode.

Other public legs live with their feature group:
  openwop analytics collect <orgId> …        the public analytics beacon
  openwop funnels public view|step|next …    a published funnel
  openwop discovery public search <orgId>    storefront product search
  openwop campaign-connectors public …       consented pixels + conversions relay
  openwop email public open|click|unsubscribe|preferences|event …
  openwop forms public get|submit <formId>
  openwop chat-widget public config|message|embed

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown org/slug, or the
surface is disabled); 1 server error or a failed download.

Examples:
  openwop public pages org_1
  openwop public page org_1 about --markdown
  openwop public sitemap org_1
  openwop public podcast-feed org_1 my-show > feed.xml
  openwop public audio org_1 ep_1 --out episode.mp3
  openwop public pricing --json
`;

async function rawText(ctx: Ctx, path: string): Promise<number> {
  const res = await requestRaw(ctx, path, { auth: false });
  if (ctx.json) { writeJson(ctx.io.stdout, rawJson(res)); return 0; }
  writeText(ctx, res.text());
  return 0;
}

async function jsonGet(ctx: Ctx, path: string): Promise<any> {
  return (await requestJson(ctx, path, { auth: false })).body;
}

const TABLE: Record<string, Cmd> = {
  pages: {
    usage: 'pages <orgId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, await jsonGet(ctx, `${org(a.positionals[0])}/pages`), 'pages',
      ['slug', 'title', ['navOrder', (p) => p.navOrder ?? p.order]], 'No published pages.'),
  },
  page: {
    usage: 'page <orgId> <slug> [--vk <visitorKey>] [--markdown] [--json]', args: 2, value: ['--vk'], bool: ['--markdown'],
    run: async (ctx, a) => {
      const [o, slug] = a.positionals;
      if (a.options.markdown) return rawText(ctx, `${org(o)}/pages/${enc(slug)}.md`);
      return detail(ctx, await jsonGet(ctx, `${org(o)}/pages/${enc(slug)}${qs({ vk: a.options.vk })}`));
    },
  },
  blog: {
    usage: 'blog <orgId> [--tag <t>] [--category <c>] [--author <a>] [--json]', args: 1, value: ['--tag', '--category', '--author'],
    run: async (ctx, a) => listOut(ctx,
      await jsonGet(ctx, `${org(a.positionals[0])}/blog${qs({ tag: a.options.tag, category: a.options.category, author: a.options.author })}`),
      'posts', ['slug', 'title', 'publishedAt', 'author'], 'No published blog posts.'),
  },
  'blog-feed': { usage: 'blog-feed <orgId> [--json]', args: 1, run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/blog/feed.xml`) },
  feed: { usage: 'feed <orgId> [--json]', args: 1, run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/feed.rss`) },
  sitemap: { usage: 'sitemap <orgId> [--json]', args: 1, run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/sitemap.xml`) },
  robots: { usage: 'robots <orgId> [--json]', args: 1, run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/robots.txt`) },
  llms: { usage: 'llms <orgId> [--json]', args: 1, run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/llms.txt`) },
  prerender: {
    usage: 'prerender <orgId> <slug> [--json]', args: 2,
    run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/prerender/${enc(a.positionals[1])}`),
  },
  'blog-prerender': { usage: 'blog-prerender <orgId> [--json]', args: 1, run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/blog/prerender`) },
  podcasts: {
    usage: 'podcasts <orgId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, await jsonGet(ctx, `${org(a.positionals[0])}/podcasts`), 'shows',
      ['slug', 'title', 'episodeCount', 'pageUrl'], 'No published podcast shows.'),
  },
  podcast: {
    usage: 'podcast <orgId> <showSlug> [--json]', args: 2,
    run: async (ctx, a) => {
      const body = await jsonGet(ctx, `${org(a.positionals[0])}/podcasts/${enc(a.positionals[1])}`);
      if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
      const s = body?.show ?? {};
      writeLine(ctx.io.stdout, `show: ${s.title ?? ''} (${s.slug ?? a.positionals[1]})`);
      if (s.feedUrl) writeLine(ctx.io.stdout, `feed: ${s.feedUrl}`);
      if (s.pageUrl) writeLine(ctx.io.stdout, `page: ${s.pageUrl}`);
      return listOut(ctx, body, 'episodes', ['episodeId', 'slug', 'title', 'publishedAt'], 'No published episodes.');
    },
  },
  'podcast-feed': {
    usage: 'podcast-feed <orgId> <showSlug> [--json]', args: 2,
    run: (ctx, a) => rawText(ctx, `${org(a.positionals[0])}/podcasts/${enc(a.positionals[1])}/feed.xml`),
  },
  episode: {
    usage: 'episode <orgId> <showSlug> <episodeSlug> [--json]', args: 3,
    run: async (ctx, a) => {
      const [o, show, ep] = a.positionals;
      return detail(ctx, await jsonGet(ctx, `${org(o)}/podcasts/${enc(show)}/${enc(ep)}`));
    },
  },
  'podcast-prerender': {
    usage: 'podcast-prerender <orgId> <showSlug> [<episodeSlug>] [--json]',
    run: async (ctx, a) => {
      const [o, show, ep] = a.positionals;
      if (!o || !show || a.positionals.length > 3) {
        ctx.io.stderr.write('Usage: openwop public podcast-prerender <orgId> <showSlug> [<episodeSlug>] [--json]\n');
        return 2;
      }
      return rawText(ctx, `${org(o)}/podcasts/${enc(show)}/prerender${ep ? `/${enc(ep)}` : ''}`);
    },
  },
  audio: {
    usage: 'audio <orgId> <episodeId> [--out <file>] [--json]', args: 2, value: ['--out'],
    run: async (ctx, a) => {
      const [o, ep] = a.positionals;
      const path = `${org(o)}/podcasts/episodes/${enc(ep)}/audio`;
      if (a.options.out) {
        const res = await requestRaw(ctx, path, { auth: false });
        const file = resolvePath(ctx.cwd, String(a.options.out));
        writeFileSync(file, res.bytes);
        const info = { status: res.status, contentType: res.contentType, bytes: res.bytes.length, file };
        if (ctx.json) { writeJson(ctx.io.stdout, info); return 0; }
        writeLine(ctx.io.stdout, `Saved ${res.bytes.length} bytes (${res.contentType || 'unknown type'}) to ${file}.`);
        return 0;
      }
      const res = await requestRaw(ctx, path, { auth: false, headers: { range: 'bytes=0-0' } });
      const range = res.headers.get('content-range') ?? '';
      const total = /\/(\d+)$/.exec(range)?.[1] ?? res.headers.get('content-length') ?? '';
      const info = { status: res.status, contentType: res.contentType, size: total ? Number(total) : null, acceptRanges: res.headers.get('accept-ranges') ?? null };
      if (ctx.json) { writeJson(ctx.io.stdout, info); return 0; }
      writeLine(ctx.io.stdout, `contentType: ${info.contentType || '(none)'}`);
      writeLine(ctx.io.stdout, `size: ${info.size ?? 'unknown'} bytes`);
      writeLine(ctx.io.stdout, `ranges: ${info.acceptRanges ?? 'no'}`);
      return 0;
    },
  },
  pricing: {
    usage: 'pricing [--json]', args: 0,
    run: async (ctx) => listOut(ctx, await jsonGet(ctx, `${APP}/public/pricing`), 'tiers',
      ['id', 'name', ['price', (t) => t.price ?? t.priceMonthly ?? t.displayPrice], ['features', (t) => t.features]], 'No pricing tiers.'),
  },
  'bundle-pricing': {
    usage: 'bundle-pricing [--json]', args: 0,
    run: async (ctx) => listOut(ctx, await jsonGet(ctx, `${APP}/public/bundle-pricing`), 'bundles',
      ['bundleId', 'name', ['price', (b) => b.price ?? b.amount ?? b.displayPrice], 'currency', 'interval'], 'No feature bundles are for sale on this host.'),
  },
};

export async function runPublic(ctx: Ctx, argv: string[]) {
  return dispatchTable(ctx, 'public', PUBLIC_HELP, TABLE, argv, '--help');
}

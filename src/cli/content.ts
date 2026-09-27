import type { Ctx } from '../context.js';
/**
 * `openwop content ...` — the NORMATIVE localized-content surface
 * (RFC 0103, `localized-content.md`; `api/openapi.yaml` tag `content`).
 *
 *   GET    /v1/content/pages/{slug}                        getContentPage     (public delivery, published only, Accept-Language negotiated)
 *   GET    /v1/content/pages                               listContentPages   (content:read)
 *   POST   /v1/content/pages                               createContentPage  (content:write)
 *   DELETE /v1/content/pages/{pageId}                      deleteContentPage  (content:write)
 *   PUT    /v1/content/pages/{pageId}/sections/{sectionId} putContentSection  (content:write)
 *   GET    /v1/content/settings                            getContentSettings (content:read)
 *
 * Every path is a manifest operation, so under protocol v2 it rides the
 * unversioned `/content/*` name automatically (src/protocol.ts). A host that
 * does not advertise `capabilities.content.supported` answers 501 — rendered as
 * a capability-honest exit 1. This is distinct from `openwop cms`, which drives
 * the reference host's org-scoped authoring workflow (host-extension).
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { failClosedOn404 } from './requestHelpers.js';
import { readBodyOption, parseJsonFlag } from './contentHelpers.js';

export const CONTENT_HELP = `Usage:
  openwop content page <slug> [--locale <bcp47>] [--json]
  openwop content pages [--json]
  openwop content create --slug <slug> [--name <n>] [--page-id <id>] [--section-order a,b] [--publish] [--json]
  openwop content create (--body '{...}' | --body-file <f>) [--json]
  openwop content delete <pageId> [--yes]
  openwop content section <pageId> <sectionId> --locale <bcp47> (--data-json '{...}' | --body-file <f>) [--json]
  openwop content settings [--json]

Localized content (RFC 0103) — the protocol's content surface, not the reference
host's authoring workflow (for that, use \`openwop cms\`).

  page      GET    /v1/content/pages/{slug}  Public delivery of a PUBLISHED page for
            the negotiated locale; --locale sets Accept-Language. Anonymous-capable.
  pages     GET    /v1/content/pages         Your tenant's pages, draft + published.
  create    POST   /v1/content/pages         { slug, name?, pageId?, sectionOrder?, status? }
            --publish sends status:"published" (admin tier; refused while the
            org gates publishing on review — create a draft instead).
  delete    DELETE /v1/content/pages/{pageId}  Removes the page, its sections and
            every locale overlay. Takes the pageId, not the slug.
  section   PUT    /v1/content/pages/{pageId}/sections/{sectionId}  { locale, data }
            The base locale upserts the section's data; any other locale upserts
            that locale's overlay.
  settings  GET    /v1/content/settings      { baseLocale, supportedLocales, autoTranslateOnPublish }

Under protocol v2 these ride /content/* (no /v1 prefix) automatically. A host
that does not support content answers 501; an unknown slug/page is 404 (both exit 1).
Scopes: content:read for reads, content:write for writes (exit 4 without them).

Examples:
  openwop content page pricing --locale es
  openwop content pages --json
  openwop content create --slug pricing --name "Pricing"
  openwop content section page_1 hero --locale es --data-json '{"title":"Precios"}'
  openwop content delete page_1 --yes
`;

const SUBS = ['page', 'pages', 'create', 'delete', 'section', 'settings'];

export async function runContent(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, CONTENT_HELP); return sub ? 0 : 2; }
  if (!SUBS.includes(sub)) throw new CliError(`Unknown content command: ${sub}\nRun \`openwop content --help\` for usage.`);
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes', '--publish'],
    value: ['--locale', '--slug', '--name', '--page-id', '--section-order', '--body', '--body-file', '--data-json'],
  });
  if (options.help) { write(ctx.io.stdout, CONTENT_HELP); return 0; }
  try {
    return await dispatch(ctx, sub, options, positionals);
  } catch (err) {
    failClosedOn404(err, `content ${sub}`);
  }
}

async function dispatch(ctx: Ctx, sub: string, options: Record<string, any>, positionals: string[]): Promise<number> {
  switch (sub) {
    case 'page': {
      if (positionals.length !== 1) throw new CliError('Usage: openwop content page <slug> [--locale <bcp47>] [--json]', 2);
      const res = await requestJson(ctx, `/v1/content/pages/${encodeURIComponent(positionals[0])}`, {
        ...(options.locale ? { headers: { 'accept-language': String(options.locale) } } : {}),
      });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const p = res.body ?? {};
      writeLine(ctx.io.stdout, `page: ${p.page?.name ?? ''} (${p.slug ?? positionals[0]}, ${p.page?.pageId ?? ''})`);
      writeLine(ctx.io.stdout, `locale: ${p.locale ?? res.headers.get('content-language') ?? ''}`);
      const sections = Array.isArray(p.sections) ? p.sections : [];
      writeLine(ctx.io.stdout, `sections (${sections.length}):`);
      for (const s of sections) writeLine(ctx.io.stdout, `  ${s.sectionId} [${s.sectionType ?? ''}] ${JSON.stringify(s.data ?? {})}`);
      return 0;
    }
    case 'pages': {
      const res = await requestJson(ctx, '/v1/content/pages');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const pages = Array.isArray(res.body) ? res.body : Array.isArray(res.body?.pages) ? res.body.pages : [];
      if (pages.length === 0) { writeLine(ctx.io.stdout, 'No content pages in this tenant.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(pages.map((p: any) => ({
        pageId: p.pageId ?? '', slug: p.slug ?? '', name: p.name ?? '', status: p.status ?? '',
        sections: Array.isArray(p.sectionOrder) ? String(p.sectionOrder.length) : '',
      })), ['pageId', 'slug', 'name', 'status', 'sections']));
      return 0;
    }
    case 'create': {
      let body = readBodyOption(ctx, options);
      if (body === undefined) {
        if (!options.slug) throw new CliError('create needs --slug <slug> (or a full --body / --body-file).', 2);
        body = { slug: options.slug };
        if (options.name) body.name = options.name;
        if (options.pageId) body.pageId = options.pageId;
        if (options.sectionOrder) body.sectionOrder = String(options.sectionOrder).split(',').map((x) => x.trim()).filter(Boolean);
      }
      if (options.publish) body.status = 'published';
      const res = await requestJson(ctx, '/v1/content/pages', { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Created page ${res.body?.pageId ?? ''} (${res.body?.slug ?? body.slug}, ${res.body?.status ?? 'draft'}).`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 1) throw new CliError('Usage: openwop content delete <pageId> [--yes]', 2);
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete page ${positionals[0]} (with its sections and locale overlays) without --yes.`); return 2; }
      await requestJson(ctx, `/v1/content/pages/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted page ${positionals[0]}.`);
      return 0;
    }
    case 'section': {
      if (positionals.length !== 2) throw new CliError("Usage: openwop content section <pageId> <sectionId> --locale <bcp47> (--data-json '{...}' | --body-file <f>) [--json]", 2);
      if (!options.locale) throw new CliError('section needs --locale <bcp47>.', 2);
      const data = options.dataJson !== undefined ? parseJsonFlag('--data-json', options.dataJson) : readBodyOption(ctx, options);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError('section needs --data-json (or --body-file) holding a JSON object.', 2);
      const res = await requestJson(ctx, `/v1/content/pages/${encodeURIComponent(positionals[0])}/sections/${encodeURIComponent(positionals[1])}`, {
        method: 'PUT',
        body: { locale: options.locale, data },
      });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Updated section ${res.body?.sectionId ?? positionals[1]} of page ${positionals[0]} for locale ${options.locale}.`);
      return 0;
    }
    case 'settings': {
      const res = await requestJson(ctx, '/v1/content/settings');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const s = res.body ?? {};
      writeLine(ctx.io.stdout, `baseLocale: ${s.baseLocale ?? ''}`);
      writeLine(ctx.io.stdout, `supportedLocales: ${Array.isArray(s.supportedLocales) ? s.supportedLocales.join(', ') || '(none)' : ''}`);
      writeLine(ctx.io.stdout, `autoTranslateOnPublish: ${s.autoTranslateOnPublish ? 'yes' : 'no'}`);
      return 0;
    }
  }
  return 2;
}

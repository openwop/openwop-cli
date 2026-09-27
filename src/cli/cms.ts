import type { Ctx } from '../context.js';
/** `openwop cms ...` — CMS pages + authoring lifecycle (feature: cms, ADR 0027). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { dispatchSpecs, specsUsage, type CommandSpec } from './resourceCommands.js';

const pages = (org: string) => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(org)}/pages`;
const LIFECYCLE = ['submit', 'approve', 'reject', 'publish', 'unpublish', 'archive'];

const O = '/v1/host/openwop-app/cms/orgs/:org';
const P = `${O}/pages/:pageId`;
const X = `${P}/experiments`;
const SEO = '/v1/host/openwop-app/publishing/orgs/:org/pages/:pageId/seo';

/**
 * The rest of the CMS authoring surface (ADR 0204 scheduling + shared sections,
 * ADR 0205 translator grants + per-locale publish, ADR 0064 localization, the
 * page A/B experiments, and the publishing SEO head) — served from a spec table.
 */
export const CMS_EXT_SPECS: CommandSpec[] = [
  { cmd: ['pages', 'review'], method: 'GET', route: `${P}/review`, summary: 'The latest approval review on a page (outcome, reason, reviewer, time).' },
  { cmd: ['pages', 'restore'], method: 'POST', route: `${P}/restore/:versionId`, summary: 'Restore a past version into the draft (admin).' },
  { cmd: ['schedule', 'publish'], method: 'POST', route: `${P}/schedule`, body: ['at!'], summary: 'Schedule a publish at an ISO time (admin; 409 while the approval gate is on).' },
  { cmd: ['schedule', 'clear-publish'], method: 'DELETE', route: `${P}/schedule`, summary: 'Cancel a scheduled publish.' },
  { cmd: ['schedule', 'unpublish'], method: 'POST', route: `${P}/schedule-unpublish`, body: ['at!'], summary: 'Schedule an unpublish (embargo end) at an ISO time.' },
  { cmd: ['schedule', 'clear-unpublish'], method: 'DELETE', route: `${P}/schedule-unpublish`, summary: 'Cancel a scheduled unpublish.' },
  { cmd: ['shared-sections'], method: 'GET', route: `${O}/shared-sections`, summary: 'Reusable shared sections pages inherit by reference.',
    list: { key: 'sharedSections', columns: ['sharedSectionId', 'name', 'type', 'updatedAt'], empty: 'No shared sections.' } },
  { cmd: ['shared-sections', 'create'], method: 'POST', route: `${O}/shared-sections`, body: ['name!', 'type', 'data:json', 'localizations:json'], summary: 'Create a shared section.' },
  { cmd: ['shared-sections', 'update'], method: 'PATCH', route: `${O}/shared-sections/:sharedSectionId`, body: ['name', 'data:json', 'localizations:json'],
    summary: 'Edit a shared section (409 names the live pages blocking a content edit while the approval gate is on).' },
  { cmd: ['shared-sections', 'delete'], method: 'DELETE', route: `${O}/shared-sections/:sharedSectionId`, confirm: true, summary: 'Delete a shared section (409 while pages still use it).' },
  { cmd: ['shared-sections', 'pages'], method: 'GET', route: `${O}/shared-sections/:sharedSectionId/pages`, summary: 'The pages that use a shared section (what an edit would change).',
    list: { key: 'pages', columns: ['pageId', 'title', 'status'], empty: 'No pages use it.' } },
  { cmd: ['language-settings'], method: 'GET', route: `${O}/language-settings`, summary: 'The base locale + authored locales.' },
  { cmd: ['language-settings', 'set'], method: 'PUT', route: `${O}/language-settings`, body: ['baseLocale', 'supportedLocales:list', 'autoTranslateOnPublish:bool'],
    summary: 'Update the language settings (admin; needs cms-localization on). Only the fields you pass change.' },
  { cmd: ['locale-grants'], method: 'GET', route: `${O}/locale-grants`, summary: 'Translator locale grants (admin).',
    list: { key: 'grants', columns: ['subject', 'locales', 'updatedAt'], empty: 'No locale grants.' } },
  { cmd: ['locale-grants', 'mine'], method: 'GET', route: `${O}/locale-grants/mine`, summary: 'Your own translator grant (null = not narrowed).' },
  { cmd: ['locale-grants', 'set'], method: 'PUT', route: `${O}/locale-grants`, body: ['subject!', 'locales:list!'],
    summary: 'Grant a member translator locales (an empty --locales "" removes the grant).' },
  { cmd: ['locales', 'publish'], method: 'POST', route: `${P}/locales/:locale/publish`, summary: 'Put one translation locale live (admin).' },
  { cmd: ['locales', 'unpublish'], method: 'POST', route: `${P}/locales/:locale/unpublish`, summary: 'Withhold one translation locale (admin).' },
  { cmd: ['translate-section'], method: 'POST', route: `${O}/translate-section`, body: ['sectionType!', 'targetLocale!', 'data:json'],
    summary: 'AI-draft a section into a locale (returns a draft overlay; nothing is saved; 503 when translation is unavailable).' },
  { cmd: ['seo'], method: 'GET', route: SEO, summary: 'A page\'s SEO head (title, description, social card, canonical URL, noindex).' },
  { cmd: ['seo', 'set'], method: 'PUT', route: SEO, rmw: SEO, rmwKey: 'seo',
    body: ['metaTitle', 'metaDescription', 'ogTitle', 'ogDescription', 'ogImageToken', 'canonicalUrl', 'noindex:bool'],
    summary: 'Edit the SEO head. Read-modify-write: the host replaces the whole head, so unset fields keep their current value.' },
  { cmd: ['experiments'], method: 'GET', route: X, summary: 'A page\'s A/B experiments.',
    list: { key: 'experiments', columns: ['experimentId', 'name', 'status', 'updatedAt'], empty: 'No experiments.' } },
  { cmd: ['experiments', 'get'], method: 'GET', route: `${X}/:experimentId`, summary: 'One experiment.' },
  { cmd: ['experiments', 'create'], method: 'POST', route: X, body: ['name!', 'variants:json'], summary: 'Create an experiment (variant weights must sum to 100).' },
  { cmd: ['experiments', 'update'], method: 'PATCH', route: `${X}/:experimentId`, body: ['name', 'variants:json'], summary: 'Edit an experiment.' },
  { cmd: ['experiments', 'delete'], method: 'DELETE', route: `${X}/:experimentId`, confirm: true, summary: 'Delete an experiment.' },
  { cmd: ['experiments', 'start'], method: 'POST', route: `${X}/:experimentId/start`, summary: 'Start serving the variants (admin).' },
  { cmd: ['experiments', 'stop'], method: 'POST', route: `${X}/:experimentId/stop`, summary: 'Stop the experiment (admin).' },
  { cmd: ['experiments', 'promote'], method: 'POST', route: `${X}/:experimentId/promote`, body: ['variantKey!'], summary: 'Promote the winning variant into the page (admin).' },
  { cmd: ['experiments', 'results'], method: 'GET', route: `${X}/:experimentId/results`, summary: 'Per-variant views + conversions.' },
];

export const CMS_HELP = `Usage:
  openwop cms pages list --org <orgId> [--json]
  openwop cms pages get <pageId> --org <orgId> [--json]
  openwop cms pages by-slug <slug> --org <orgId> [--json]
  openwop cms pages create --org <orgId> --title <t> [--slug <s>] [--json]
  openwop cms pages update <pageId> --org <orgId> [--title <t>] [--slug <s>] [--json]
  openwop cms pages delete <pageId> --org <orgId> [--yes]
  openwop cms pages versions <pageId> --org <orgId> [--json]
  openwop cms <submit|approve|reject|publish|unpublish|archive> <pageId> --org <orgId> [--json]

${specsUsage('cms', CMS_EXT_SPECS)}

CMS pages + the authoring lifecycle (host-extension, org-scoped, ADR 0027). A page
moves draft → submit → approve → publish; \`versions\` lists its history. Every command
needs --org. The host is the authority; the CLI mirrors + relays. \`seo\` hits the
publishing surface (/v1/host/openwop-app/publishing/…). Writes also accept
--body <json> / --body-file <path> (flags override keys in it).

Exit codes: 0 ok · 2 usage error / request rejected (404, 409, 422) · 4 not signed in
or not permitted (401/403) · 1 server error (incl. 503 translation unavailable).

Examples:
  openwop cms schedule publish page_1 --org org_1 --at 2026-10-01T09:00:00Z
  openwop cms shared-sections --org org_1
  openwop cms language-settings set --org org_1 --supported-locales es,fr
  openwop cms experiments create page_1 --org org_1 --name Hero --variants '[{"key":"a","weight":50},{"key":"b","weight":50}]'
  openwop cms seo set page_1 --org org_1 --meta-title "Pricing" --noindex false
`;


export async function runCms(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'pages';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CMS_HELP); return 0; }
  const ext = await dispatchSpecs(ctx, 'cms', CMS_EXT_SPECS, argv);
  if (ext !== undefined) return ext;
  if (sub === 'pages') return cmsPages(ctx, argv.slice(1));
  if (LIFECYCLE.includes(sub)) return cmsLifecycle(ctx, sub, argv.slice(1));
  throw new CliError(`Unknown cms command: ${sub}\nRun \`openwop cms --help\` for usage.`);
}

async function cmsPages(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'by-slug', 'create', 'update', 'delete', 'versions'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--title', '--slug'] });
  if (options.help) { write(ctx.io.stdout, CMS_HELP); return 0; }
  const org = requireOrg(options.org);
  const url = pages(org);
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, url);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.pages) ? res.body.pages : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No pages.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((p: any) => ({ id: p.id ?? p.pageId ?? '', title: p.title ?? '', slug: p.slug ?? '', status: p.status ?? '' })), ['id', 'title', 'slug', 'status']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop cms pages get <pageId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'by-slug': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop cms pages by-slug <slug> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${url}/by-slug/${encodeURIComponent(positionals[0])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      if (!options.title) { write(ctx.io.stderr, 'cms pages create needs --title.\n'); return 2; }
      const body: Record<string, string> = { title: String(options.title) };
      if (options.slug) body.slug = String(options.slug);
      const res = await requestJson(ctx, url, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created page ${res.body?.id ?? ''} (${String(options.title)}).`);
      return 0;
    }
    case 'update': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop cms pages update <pageId> --org <orgId> [--title t] [--slug s]\n'); return 2; }
      const patch: Record<string, string> = {};
      if (options.title) patch.title = String(options.title);
      if (options.slug) patch.slug = String(options.slug);
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated page ${positionals[0]}.`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop cms pages delete <pageId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete page ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted page ${positionals[0]}.`); return 0;
    }
    case 'versions': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop cms pages versions <pageId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}/versions`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    default: throw new CliError(`Unknown cms pages command: ${sub}`);
  }
}

async function cmsLifecycle(ctx: Ctx, action: string, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--org'] });
  const org = requireOrg(options.org);
  if (positionals.length !== 1) { write(ctx.io.stderr, `Usage: openwop cms ${action} <pageId> --org <orgId> [--json]\n`); return 2; }
  const res = await requestJson(ctx, `${pages(org)}/${encodeURIComponent(positionals[0])}/${action}`, { method: 'POST', body: {} });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Page ${positionals[0]} → ${action}.`);
  return 0;
}

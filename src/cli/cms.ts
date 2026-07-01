import type { Ctx } from '../context.js';
/** `openwop cms ...` — CMS pages + authoring lifecycle (feature: cms, ADR 0027). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const pages = (org: string) => `/v1/host/sample/cms/orgs/${encodeURIComponent(org)}/pages`;
const LIFECYCLE = ['submit', 'approve', 'reject', 'publish', 'unpublish', 'archive'];

export const CMS_HELP = `Usage:
  openwop cms pages list --org <orgId> [--json]
  openwop cms pages get <pageId> --org <orgId> [--json]
  openwop cms pages by-slug <slug> --org <orgId> [--json]
  openwop cms pages create --org <orgId> --title <t> [--slug <s>] [--json]
  openwop cms pages update <pageId> --org <orgId> [--title <t>] [--slug <s>] [--json]
  openwop cms pages delete <pageId> --org <orgId> [--yes]
  openwop cms pages versions <pageId> --org <orgId> [--json]
  openwop cms <submit|approve|reject|publish|unpublish|archive> <pageId> --org <orgId> [--json]

CMS pages + the authoring lifecycle (host-extension, org-scoped, ADR 0027). A page
moves draft → submit → approve → publish; \`versions\` lists its history. Every command
needs --org. The host is the authority; the CLI mirrors + relays.
`;


export async function runCms(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'pages';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CMS_HELP); return 0; }
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

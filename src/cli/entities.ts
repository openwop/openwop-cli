import type { Ctx } from '../context.js';
/**
 * `openwop entities ...` — headless content modeling (feature: entities).
 *
 * Custom entity TYPES (a field schema, draft → published), the entity RECORDS
 * under a type, TAXONOMIES + their terms, type-to-type RELATIONSHIPS, the
 * editor's locale context, and the anonymous opt-in PUBLIC read surface.
 * Sources: openwop-app ADR 0386 (entities headless content modeling), ADR 0406
 * (entities localization), ADR 0407 (entity content-delivery bridge — the
 * `public-entities` sibling prefix). All paths are host-extension routes under
 * `/v1/host/openwop-app/entities` and `/v1/host/openwop-app/public-entities`.
 * The host is the authority for RBAC, the publish gate and validation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeJson, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { csv, enc, mergeBody, parseJsonFlag, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/entities';
const PUBLIC_BASE = '/v1/host/openwop-app/public-entities';

export const ENTITIES_HELP = `Usage:
  openwop entities locale-context [--json]
  openwop entities types list [--project <id>] [--json]
  openwop entities types get <type> [--project <id>] [--json]
  openwop entities types create --name <n> [--display-name <d>] [--description <t>] [--fields <json>] [--body <json>|--body-file <path>] [--json]
  openwop entities types update <type> [--display-name <d>] [--description <t>|--clear-description] [--fields <json>]
                                [--status draft|published] [--public-read <json>] [--body <json>|--body-file <path>] [--json]
  openwop entities types delete <type> --yes
  openwop entities types query <type> [--filters <json>] [--sort-key <k>] [--sort-dir asc|desc] [--term-id <id>] [--limit <n>] [--cursor <c>] [--json]
  openwop entities types export <type> [--output <file.ndjson>]
  openwop entities types import <type> --file <file.ndjson|file.json> [--json]
  openwop entities list <type> [--limit <n>] [--cursor <c>] [--json]
  openwop entities get <type> <entityId> [--json]
  openwop entities create <type> --values <json> [--entity-id <id>] [--term-ids a,b] [--status <s>] [--localizations <json>] [--body <json>|--body-file <path>] [--json]
  openwop entities update <type> <entityId> [--values <json>] [--term-ids a,b] [--status <s>] [--localizations <json>] [--body <json>|--body-file <path>] [--json]
  openwop entities delete <type> <entityId> --yes
  openwop entities taxonomies list [--json]
  openwop entities taxonomies create --name <n> [--display-name <d>] [--json]
  openwop entities taxonomies delete <taxonomy> --yes
  openwop entities terms list <taxonomy> [--json]
  openwop entities terms create <taxonomy> --slug <s> [--label <l>] [--parent-id <id>] [--json]
  openwop entities terms update <taxonomy> <slug> [--label <l>] [--parent-id <id>|--clear-parent] [--json]
  openwop entities terms reorder <taxonomy> --slugs a,b,c [--json]
  openwop entities terms delete <taxonomy> <slug> --yes
  openwop entities relationships list [--json]
  openwop entities relationships create --from <type> --to <type> [--cardinality <c>] [--on-delete <p>] [--json]
  openwop entities relationships delete <fromType> <toType> --yes
  openwop entities public list <tenantId> <type> [--filters <json>] [--sort-key <k>] [--sort-dir asc|desc] [--term-id <id>]
                               [--limit <n>] [--cursor <c>] [--locale <l>] [--json]
  openwop entities public get <tenantId> <type> <entityId> [--locale <l>] [--json]

Headless content modeling (host-extension, ADR 0386/0406/0407). Hits
/v1/host/openwop-app/entities/* with your credentials; \`public\` hits the
anonymous /v1/host/openwop-app/public-entities/* surface WITHOUT auth (a type
must be published + opted into public read, otherwise the server answers one
uniform 404). Every command accepts --project <id> to scope to a project.
\`types export\` writes NDJSON (one entity per line) to --output or stdout;
\`types import\` sends NDJSON (a JSON array file is converted line-per-row).
The server validates field values closed-world; the CLI only relays.

Exit codes: 0 ok · 2 usage error or 4xx (e.g. 404 not found / validation) ·
4 auth/permission denied (401/403) · 1 server error.

Examples:
  openwop entities types create --name recipe --fields '[{"key":"title","type":"text","required":true}]'
  openwop entities types update recipe --status published
  openwop entities create recipe --values '{"title":"Pancakes"}'
  openwop entities types query recipe --filters '[{"field":"title","op":"contains","value":"cake"}]'
  openwop entities types export recipe --output recipes.ndjson
  openwop entities public list tenant-1 recipe --locale fr --json
`;

const VALUE_FLAGS = [
  '--project', '--body', '--body-file', '--name', '--display-name', '--description', '--fields', '--status',
  '--public-read', '--filters', '--sort-key', '--sort-dir', '--term-id', '--limit', '--cursor', '--output', '--file',
  '--values', '--entity-id', '--term-ids', '--localizations', '--slug', '--label', '--parent-id', '--slugs',
  '--from', '--to', '--cardinality', '--on-delete', '--locale',
];
const BOOL_FLAGS = ['--help', '--yes', '--clear-description', '--clear-parent'];

function usage(ctx: Ctx, line: string): number {
  write(ctx.io.stderr, `Usage: openwop entities ${line}\n`);
  return 2;
}

function need<T>(value: T | undefined, ctx: Ctx, line: string): T {
  if (value === undefined || value === '') throw new CliError(`Usage: openwop entities ${line}`, 2);
  return value;
}

function confirm(options: Record<string, any>, what: string): void {
  if (!options.yes) throw new CliError(`Refusing to delete ${what} without --yes.`, 2);
}

function numberOpt(flag: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`, 2);
  return n;
}

export async function runEntities(ctx: Ctx, argv: string[]): Promise<number> {
  const family = argv[0];
  if (!family || family === '--help' || family === '-h' || family === 'help') {
    write(ctx.io.stdout, ENTITIES_HELP);
    return family ? 0 : 2;
  }
  const hasSub = ['types', 'taxonomies', 'terms', 'relationships', 'public'].includes(family);
  const sub = hasSub ? (argv[1] ?? 'list') : family;
  const rest = argv.slice(hasSub ? 2 : 1);
  const { options, positionals } = parseOptions(rest, { bool: BOOL_FLAGS, value: VALUE_FLAGS });
  if (options.help) { write(ctx.io.stdout, ENTITIES_HELP); return 0; }
  const project = options.project !== undefined ? String(options.project) : undefined;
  const q = (path: string, extra: Record<string, unknown> = {}) => withQuery(path, { projectId: project, ...extra });

  switch (family) {
    case 'locale-context': {
      const res = await requestJson(ctx, q(`${BASE}/locale-context`));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const b = res.body ?? {};
      writeLine(ctx.io.stdout, b.enabled
        ? `Localization enabled — base ${b.baseLocale ?? ''}; supported: ${(b.supportedLocales ?? []).join(', ')}`
        : 'Localization disabled.');
      return 0;
    }
    case 'types': return types(ctx, sub, positionals, options, project, q);
    case 'list': case 'get': case 'create': case 'update': case 'delete':
      return records(ctx, sub, positionals, options, project, q);
    case 'taxonomies': return taxonomies(ctx, sub, positionals, options, project, q);
    case 'terms': return terms(ctx, sub, positionals, options, project, q);
    case 'relationships': return relationships(ctx, sub, positionals, options, project, q);
    case 'public': return publicReads(ctx, sub, positionals, options, project);
    default: throw new CliError(`Unknown entities command: ${family}\nRun \`openwop entities --help\` for usage.`);
  }
}

type Q = (path: string, extra?: Record<string, unknown>) => string;

async function types(ctx: Ctx, sub: string, pos: string[], o: Record<string, any>, project: string | undefined, q: Q): Promise<number> {
  const name = pos[0];
  const typePath = (n: string) => `${BASE}/types/${enc(n)}`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, q(`${BASE}/types`));
      return renderList(ctx, res.body, pickArray(res.body, 'types'), ['name', 'displayName', 'status', 'fields'], 'No entity types.',
        (t) => ({ name: t.name ?? '', displayName: t.displayName ?? '', status: t.status ?? '', fields: Array.isArray(t.fields) ? t.fields.length : '' }));
    }
    case 'get': {
      if (!name) return usage(ctx, 'types get <type>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, q(typePath(name)))).body);
      return 0;
    }
    case 'create': {
      const body = mergeBody(ctx, o, {
        name: o.name !== undefined ? String(o.name) : undefined,
        displayName: o.displayName !== undefined ? String(o.displayName) : undefined,
        description: o.description !== undefined ? String(o.description) : undefined,
        fields: o.fields !== undefined ? parseJsonFlag('--fields', o.fields) : undefined,
        projectId: project,
      });
      if (!body.name) return usage(ctx, 'types create --name <n> [--fields <json>]');
      const res = await requestJson(ctx, `${BASE}/types`, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created entity type ${res.body?.name ?? body.name}.`);
    }
    case 'update': {
      if (!name) return usage(ctx, 'types update <type> [--display-name d] [--status s] ...');
      const body = mergeBody(ctx, o, {
        displayName: o.displayName !== undefined ? String(o.displayName) : undefined,
        description: o.clearDescription ? null : (o.description !== undefined ? String(o.description) : undefined),
        fields: o.fields !== undefined ? parseJsonFlag('--fields', o.fields) : undefined,
        status: o.status !== undefined ? String(o.status) : undefined,
        publicRead: o.publicRead !== undefined ? parseJsonFlag('--public-read', o.publicRead) : undefined,
      });
      if (Object.keys(body).length === 0) throw new CliError('types update needs at least one field to change.', 2);
      const res = await requestJson(ctx, q(typePath(name)), { method: 'PATCH', body });
      return renderDone(ctx, res.body, `Updated entity type ${name}.`);
    }
    case 'delete': {
      if (!name) return usage(ctx, 'types delete <type> --yes');
      confirm(o, `entity type ${name}`);
      await requestJson(ctx, q(typePath(name)), { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted entity type ${name}.`);
      return 0;
    }
    case 'query': {
      if (!name) return usage(ctx, 'types query <type> [--filters <json>] ...');
      const sort = o.sortKey !== undefined ? { key: String(o.sortKey), ...(o.sortDir ? { dir: String(o.sortDir) } : {}) } : undefined;
      const body = mergeBody(ctx, o, {
        filters: o.filters !== undefined ? parseJsonFlag('--filters', o.filters) : undefined,
        sort,
        termId: o.termId !== undefined ? String(o.termId) : undefined,
        limit: numberOpt('--limit', o.limit),
        cursor: o.cursor !== undefined ? String(o.cursor) : undefined,
      });
      const res = await requestJson(ctx, q(`${typePath(name)}/query`), { method: 'POST', body });
      return renderEntityPage(ctx, res.body);
    }
    case 'export': {
      if (!name) return usage(ctx, 'types export <type> [--output <file>]');
      const res = await requestJson(ctx, q(`${typePath(name)}/export`), { headers: { accept: 'application/x-ndjson' } });
      const text = ndjsonText(res.body);
      if (o.output) {
        writeFileSync(resolvePath(ctx.cwd, String(o.output)), text);
        const count = text.split('\n').filter(Boolean).length;
        writeLine(ctx.io.stdout, `Exported ${count} ${name} entit${count === 1 ? 'y' : 'ies'} to ${String(o.output)}.`);
      } else {
        write(ctx.io.stdout, text);
      }
      return 0;
    }
    case 'import': {
      if (!name || !o.file) return usage(ctx, 'types import <type> --file <file.ndjson|file.json>');
      let raw: string;
      try { raw = readFileSync(resolvePath(ctx.cwd, String(o.file)), 'utf8'); } catch (err) {
        throw new CliError(`Cannot read --file ${String(o.file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const body: Record<string, unknown> = { ndjson: toNdjson(raw) };
      if (project) body.projectId = project;
      const res = await requestJson(ctx, q(`${typePath(name)}/import`), { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const r = res.body ?? {};
      writeLine(ctx.io.stdout, `Imported into ${name}: ${JSON.stringify(r)}`);
      return 0;
    }
    default: throw new CliError(`Unknown entities types command: ${sub}`);
  }
}

async function records(ctx: Ctx, sub: string, pos: string[], o: Record<string, any>, _project: string | undefined, q: Q): Promise<number> {
  const [type, id] = pos;
  if (!type) return usage(ctx, `${sub} <type>${sub === 'list' || sub === 'create' ? '' : ' <entityId>'}`);
  const coll = `${BASE}/types/${enc(type)}/entities`;
  const recordBody = () => mergeBody(ctx, o, {
    values: o.values !== undefined ? parseJsonFlag('--values', o.values) : undefined,
    termIds: csv(o.termIds),
    status: o.status !== undefined ? String(o.status) : undefined,
    localizations: o.localizations !== undefined ? parseJsonFlag('--localizations', o.localizations) : undefined,
  });
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, q(coll, { limit: numberOpt('--limit', o.limit), cursor: o.cursor }));
      return renderEntityPage(ctx, res.body);
    }
    case 'get': {
      need(id, ctx, 'get <type> <entityId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, q(`${coll}/${enc(id)}`))).body);
      return 0;
    }
    case 'create': {
      const body = recordBody();
      if (o.entityId !== undefined) body.entityId = String(o.entityId);
      if (body.values === undefined) return usage(ctx, 'create <type> --values <json>');
      const res = await requestJson(ctx, q(coll), { method: 'POST', body });
      return renderDone(ctx, res.body, `Created ${type} entity ${res.body?.entityId ?? res.body?.id ?? ''}.`);
    }
    case 'update': {
      need(id, ctx, 'update <type> <entityId> [--values <json>]');
      const body = recordBody();
      if (Object.keys(body).length === 0) throw new CliError('entities update needs --values, --term-ids, --status, --localizations or --body.', 2);
      const res = await requestJson(ctx, q(`${coll}/${enc(id)}`), { method: 'PATCH', body });
      return renderDone(ctx, res.body, `Updated ${type} entity ${id}.`);
    }
    case 'delete': {
      need(id, ctx, 'delete <type> <entityId> --yes');
      confirm(o, `${type} entity ${id}`);
      await requestJson(ctx, q(`${coll}/${enc(id)}`), { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted ${type} entity ${id}.`);
      return 0;
    }
    default: throw new CliError(`Unknown entities command: ${sub}`);
  }
}

async function taxonomies(ctx: Ctx, sub: string, pos: string[], o: Record<string, any>, project: string | undefined, q: Q): Promise<number> {
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, q(`${BASE}/taxonomies`));
      return renderList(ctx, res.body, pickArray(res.body, 'taxonomies'), ['name', 'displayName'], 'No taxonomies.');
    }
    case 'create': {
      const body = mergeBody(ctx, o, {
        name: o.name !== undefined ? String(o.name) : undefined,
        displayName: o.displayName !== undefined ? String(o.displayName) : undefined,
        projectId: project,
      });
      if (!body.name) return usage(ctx, 'taxonomies create --name <n> [--display-name d]');
      const res = await requestJson(ctx, `${BASE}/taxonomies`, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created taxonomy ${res.body?.name ?? body.name}.`);
    }
    case 'delete': {
      const name = pos[0];
      if (!name) return usage(ctx, 'taxonomies delete <taxonomy> --yes');
      confirm(o, `taxonomy ${name}`);
      await requestJson(ctx, q(`${BASE}/taxonomies/${enc(name)}`), { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted taxonomy ${name}.`);
      return 0;
    }
    default: throw new CliError(`Unknown entities taxonomies command: ${sub}`);
  }
}

async function terms(ctx: Ctx, sub: string, pos: string[], o: Record<string, any>, project: string | undefined, q: Q): Promise<number> {
  const [tax, slug] = pos;
  if (!tax) return usage(ctx, `terms ${sub} <taxonomy>`);
  const coll = `${BASE}/taxonomies/${enc(tax)}/terms`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, q(coll));
      return renderList(ctx, res.body, pickArray(res.body, 'terms'), ['slug', 'label', 'parentId', 'id'], 'No terms.');
    }
    case 'create': {
      const body = mergeBody(ctx, o, {
        slug: o.slug !== undefined ? String(o.slug) : undefined,
        label: o.label !== undefined ? String(o.label) : undefined,
        parentId: o.parentId !== undefined ? String(o.parentId) : undefined,
        projectId: project,
      });
      if (!body.slug) return usage(ctx, 'terms create <taxonomy> --slug <s> [--label l] [--parent-id id]');
      const res = await requestJson(ctx, coll, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created term ${res.body?.slug ?? body.slug} in ${tax}.`);
    }
    case 'update': {
      need(slug, ctx, 'terms update <taxonomy> <slug> [--label l] [--parent-id id|--clear-parent]');
      const body = mergeBody(ctx, o, {
        label: o.label !== undefined ? String(o.label) : undefined,
        parentId: o.clearParent ? null : (o.parentId !== undefined ? String(o.parentId) : undefined),
      });
      if (Object.keys(body).length === 0) throw new CliError('terms update needs --label, --parent-id or --clear-parent.', 2);
      const res = await requestJson(ctx, q(`${coll}/${enc(slug)}`), { method: 'PATCH', body });
      return renderDone(ctx, res.body, `Updated term ${slug} in ${tax}.`);
    }
    case 'reorder': {
      const orderedSlugs = csv(o.slugs);
      if (!orderedSlugs || orderedSlugs.length === 0) return usage(ctx, 'terms reorder <taxonomy> --slugs a,b,c');
      const res = await requestJson(ctx, q(`${coll}/reorder`), { method: 'PATCH', body: { orderedSlugs } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Reordered ${pickArray(res.body, 'terms').length} term(s) in ${tax}.`);
      return 0;
    }
    case 'delete': {
      need(slug, ctx, 'terms delete <taxonomy> <slug> --yes');
      confirm(o, `term ${slug}`);
      await requestJson(ctx, q(`${coll}/${enc(slug)}`), { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted term ${slug} from ${tax}.`);
      return 0;
    }
    default: throw new CliError(`Unknown entities terms command: ${sub}`);
  }
}

async function relationships(ctx: Ctx, sub: string, pos: string[], o: Record<string, any>, project: string | undefined, q: Q): Promise<number> {
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, q(`${BASE}/relationships`));
      return renderList(ctx, res.body, pickArray(res.body, 'relationships'), ['fromTypeName', 'toTypeName', 'cardinality', 'onDelete'], 'No relationships.');
    }
    case 'create': {
      const body = mergeBody(ctx, o, {
        fromTypeName: o.from !== undefined ? String(o.from) : undefined,
        toTypeName: o.to !== undefined ? String(o.to) : undefined,
        cardinality: o.cardinality !== undefined ? String(o.cardinality) : undefined,
        onDelete: o.onDelete !== undefined ? String(o.onDelete) : undefined,
        projectId: project,
      });
      if (!body.fromTypeName || !body.toTypeName) return usage(ctx, 'relationships create --from <type> --to <type>');
      const res = await requestJson(ctx, `${BASE}/relationships`, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created relationship ${body.fromTypeName} → ${body.toTypeName}.`);
    }
    case 'delete': {
      const [from, to] = pos;
      if (!from || !to) return usage(ctx, 'relationships delete <fromType> <toType> --yes');
      confirm(o, `relationship ${from} → ${to}`);
      await requestJson(ctx, q(`${BASE}/relationships/${enc(from)}/${enc(to)}`), { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted relationship ${from} → ${to}.`);
      return 0;
    }
    default: throw new CliError(`Unknown entities relationships command: ${sub}`);
  }
}

async function publicReads(ctx: Ctx, sub: string, pos: string[], o: Record<string, any>, project: string | undefined): Promise<number> {
  const [tenant, type, id] = pos;
  if (!tenant || !type) return usage(ctx, `public ${sub} <tenantId> <type>${sub === 'get' ? ' <entityId>' : ''}`);
  const coll = `${PUBLIC_BASE}/${enc(tenant)}/types/${enc(type)}/entities`;
  switch (sub) {
    case 'list': {
      if (o.filters !== undefined) parseJsonFlag('--filters', o.filters); // fail early on bad JSON
      const path = withQuery(coll, {
        projectId: project, filters: o.filters, sortKey: o.sortKey, sortDir: o.sortDir, termId: o.termId,
        limit: numberOpt('--limit', o.limit), cursor: o.cursor, locale: o.locale,
      });
      const res = await requestJson(ctx, path, { auth: false });
      return renderEntityPage(ctx, res.body);
    }
    case 'get': {
      if (!id) return usage(ctx, 'public get <tenantId> <type> <entityId>');
      const res = await requestJson(ctx, withQuery(`${coll}/${enc(id)}`, { projectId: project, locale: o.locale }), { auth: false });
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    default: throw new CliError(`Unknown entities public command: ${sub}`);
  }
}

function renderEntityPage(ctx: Ctx, body: any): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  const items = pickArray(body, 'entities', 'items');
  const code = renderList(ctx, body, items, ['entityId', 'status', 'values'], 'No entities.', (e) => ({
    entityId: e.entityId ?? e.id ?? '',
    status: e.status ?? '',
    values: truncate(JSON.stringify(e.values ?? {}), 60),
  }));
  const next = body?.nextCursor ?? body?.cursor;
  if (items.length > 0 && typeof next === 'string' && next) writeLine(ctx.io.stdout, `next cursor: ${next}`);
  return code;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The export route streams NDJSON; requestJson hands back `{raw}` for multi-line
 *  bodies, a parsed object for a single row, or null for an empty type. */
function ndjsonText(body: any): string {
  if (body === null || body === undefined) return '';
  if (typeof body?.raw === 'string') return body.raw.endsWith('\n') ? body.raw : `${body.raw}\n`;
  return `${JSON.stringify(body)}\n`;
}

/** Accept NDJSON as-is; convert a JSON array file into one row per line. */
function toNdjson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try { arr = JSON.parse(trimmed); } catch { throw new CliError('--file looks like a JSON array but does not parse'); }
    if (!Array.isArray(arr)) throw new CliError('--file must be NDJSON or a JSON array');
    return arr.map((row) => JSON.stringify(row)).join('\n');
  }
  return trimmed;
}

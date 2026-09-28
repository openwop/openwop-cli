import type { Ctx } from '../context.js';
/** `openwop catalog ...` — list the host node catalog + installed packs. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { writeFileSync } from 'node:fs';

export const CATALOG_HELP = `Usage:
  openwop catalog nodes [--search text] [--limit n] [--json]
  openwop catalog packs [list] [--json]
  openwop catalog packs search [query] [--json]
  openwop catalog packs get <packName> [--json]
  openwop catalog packs export [--out <file>] [--json]
  openwop catalog tools [<toolId>] [--json]

\`packs\` reads the packs INSTALLED ON THE HOST (--base-url), not the pack
registry (\`openwop packs\` operates packs.openwop.dev):
  list    GET /v1/packs              — installed packs, their node types and agents
  search  GET /v1/packs/-/search?q=  — node type ids containing <query>
  get     GET /v1/packs/{packName}   — one pack's node types (reverse-DNS name)
  export  GET /v1/packs/export       — the installed agent manifests (RFC 0003
          round-trip), re-installable elsewhere; --out writes them to a file.
These four are v1 operations: protocol v2 names no installed-packs operation
(spec/v2/path-manifest.json, api/v2/openapi.yaml), so they are sent as the v1
paths whichever major the host speaks. To read the published catalog, use
\`openwop packs\`, which resolves the registry's v2 tree.

\`tools\` reads the portable tool catalog (RFC 0078 §B) — GET /v1/tools, or
GET /v1/tools/<toolId> for one descriptor. This is the tools an agent/workflow
may call, distinct from the node catalog + installed packs.
`;

export async function runCatalog(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'nodes';
  const args = argv.slice(sub === 'nodes' || sub === 'packs' || sub === 'tools' ? 1 : 0);
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, CATALOG_HELP);
    return 0;
  }
  switch (sub) {
    case 'nodes':
      return runCatalogNodes(ctx, args);
    case 'packs':
      return runCatalogPacks(ctx, args);
    case 'tools':
      return runCatalogTools(ctx, args);
    default:
      throw new CliError(`Unknown catalog command: ${sub}`);
  }
}

/** GET /v1/tools (+ /v1/tools/{toolId}) — the portable tool catalog (RFC 0078 §B). */
async function runCatalogTools(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, CATALOG_HELP); return 0; }
  const path = positionals.length === 1 ? `/v1/tools/${encodeURIComponent(positionals[0])}` : '/v1/tools';
  const res = await requestJson(ctx, path);
  if (ctx.json || positionals.length === 1) { writeJson(ctx.io.stdout, res.body); return 0; }
  const tools = Array.isArray(res.body?.tools) ? res.body.tools : Array.isArray(res.body) ? res.body : [];
  if (tools.length === 0) { writeLine(ctx.io.stdout, 'No tools advertised.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    tools.map((t: any) => ({ toolId: t.toolId ?? t.id ?? '', title: t.title ?? t.name ?? '', effect: t.dataEffect ?? t.effect ?? '' })),
    ['toolId', 'title', 'effect'],
  ));
  return 0;
}

async function runCatalogNodes(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--limit', '--search'],
  });
  if (options.help) {
    write(ctx.io.stdout, CATALOG_HELP);
    return 0;
  }
  const res = await requestJson(ctx, '/v1/host/openwop-app/node-catalog');
  let nodes = Array.isArray(res.body.nodes) ? res.body.nodes : [];
  if (options.search) {
    const q = String(options.search).toLowerCase();
    nodes = nodes.filter((n: any) => String(n.typeId ?? '').toLowerCase().includes(q) || String(n.label ?? '').toLowerCase().includes(q));
  }
  const limit = Number(options.limit ?? 30);
  if (ctx.json) {
    writeJson(ctx.io.stdout, { nodes });
    return 0;
  }
  const rows = nodes.slice(0, limit).map((n: any) => ({
    typeId: n.typeId,
    source: n.source,
    category: n.category,
    runnable: Array.isArray(n.missingHostSurfaces) && n.missingHostSurfaces.length > 0 ? 'no' : 'yes',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['typeId', 'source', 'category', 'runnable']));
  if (nodes.length > rows.length) writeLine(ctx.io.stdout, `... ${nodes.length - rows.length} more. Use --limit ${nodes.length} or --json.`);
  return 0;
}

async function runCatalogPacks(ctx: Ctx, argv: string[] = []) {
  const verb = argv[0];
  if (verb === 'search' || verb === 'get' || verb === 'export') return runCatalogPacksVerb(ctx, verb, argv.slice(1));
  const { options } = parseOptions(verb === 'list' ? argv.slice(1) : argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, CATALOG_HELP);
    return 0;
  }
  const res = await requestJson(ctx, '/v1/packs', { auth: false });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const rows = (res.body.packs ?? []).map((p: any) => ({ name: p.name, nodes: Array.isArray(p.nodes) ? p.nodes.length : 0 }));
  writeLine(ctx.io.stdout, formatTable(rows, ['name', 'nodes']));
  return 0;
}

/** GET /v1/packs/-/search · /v1/packs/{name} · /v1/packs/export — the host's installed-pack reads. */
async function runCatalogPacksVerb(ctx: Ctx, verb: 'search' | 'get' | 'export', argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--out'] });
  if (options.help) { write(ctx.io.stdout, CATALOG_HELP); return 0; }
  if (verb === 'search') {
    const q = positionals[0] ?? '';
    const res = await requestJson(ctx, `/v1/packs/-/search${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const results = Array.isArray(res.body?.results) ? res.body.results : [];
    if (results.length === 0) { writeLine(ctx.io.stdout, q ? `No installed node types match "${q}".` : 'No installed node types.'); return 0; }
    writeLine(ctx.io.stdout, formatTable(results.map((r: any) => ({ typeId: r.typeId ?? '', version: r.version ?? '' })), ['typeId', 'version']));
    writeLine(ctx.io.stdout, `${res.body?.total ?? results.length} match(es).`);
    return 0;
  }
  if (verb === 'get') {
    if (positionals.length !== 1) throw new CliError('Usage: openwop catalog packs get <packName> [--json]', 2);
    const res = await requestJson(ctx, `/v1/packs/${encodeURIComponent(positionals[0])}`);
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const nodes = Array.isArray(res.body?.nodes) ? res.body.nodes : [];
    writeLine(ctx.io.stdout, `pack: ${res.body?.name ?? positionals[0]}`);
    writeLine(ctx.io.stdout, `nodes (${nodes.length}):`);
    for (const n of nodes) writeLine(ctx.io.stdout, `  ${n}`);
    return 0;
  }
  const res = await requestJson(ctx, '/v1/packs/export');
  if (options.out) {
    writeFileSync(String(options.out), `${JSON.stringify(res.body, null, 2)}\n`);
    if (!ctx.json) writeLine(ctx.io.stdout, `Wrote ${res.body?.total ?? 0} agent manifest(s) to ${options.out}.`);
    else writeJson(ctx.io.stdout, { out: options.out, total: res.body?.total ?? 0 });
    return 0;
  }
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const manifests = Array.isArray(res.body?.manifests) ? res.body.manifests : [];
  if (manifests.length === 0) { writeLine(ctx.io.stdout, 'No pack-installed agents to export.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(manifests.map((m: any) => ({
    agentId: m.agentId ?? m.sourceManifestId ?? '', pack: m.packName ?? '', version: m.packVersion ?? '',
  })), ['agentId', 'pack', 'version']));
  return 0;
}

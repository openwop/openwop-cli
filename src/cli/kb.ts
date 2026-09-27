import type { Ctx } from '../context.js';
/** `openwop kb ...` — knowledge base: collections, documents, search, RAG (feature: kb). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { dispatchSpecs, specsUsage, type CommandSpec } from './resourceCommands.js';

const KC = '/v1/host/openwop-app/kb/orgs/:org/collections/:collectionId';

/** Collection retrieval config (ADR 0351), media-collection ingest, and the reindex job controls. */
export const KB_EXT_SPECS: CommandSpec[] = [
  { cmd: ['collections', 'retrieval'], method: 'PATCH', route: `${KC}/retrieval`, body: ['mode', 'embedder', 'enrichment', 'rerank:json'],
    summary: 'Set retrieval: --mode dense|hybrid|hybrid+rerank, --embedder local|provider, --enrichment off|heading-path, --rerank \'{"kind":"local"}\' (only the fields you pass change).' },
  { cmd: ['collections', 'ingest-media'], method: 'POST', route: `${KC}/ingest-media-collection`, body: ['mediaCollectionId!'],
    summary: 'Ingest every document in a media collection into this knowledge collection.' },
  { cmd: ['collections', 'reindex', 'drain'], method: 'POST', route: `${KC}/reindex/drain`, body: ['maxChunks:number'],
    summary: 'Advance the running reindex job by up to --max-chunks (host caps at 4096) (org admin).' },
  { cmd: ['collections', 'reindex', 'cancel'], method: 'POST', route: `${KC}/reindex/cancel`, summary: 'Cancel the running reindex job (org admin).' },
];

const base = (org: string) => `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(org)}`;
const cols = (org: string) => `${base(org)}/collections`;

export const KB_HELP = `Usage:
  openwop kb collections list --org <orgId> [--json]
  openwop kb collections get <collectionId> --org <orgId> [--json]
  openwop kb collections create --org <orgId> --name <n> [--json]
  openwop kb collections delete <collectionId> --org <orgId> [--yes]
  openwop kb docs list <collectionId> --org <orgId> [--json]
  openwop kb docs get <collectionId> <documentId> --org <orgId> [--json]
  openwop kb docs add <collectionId> --org <orgId> --title <t> --text <text> [--json]
  openwop kb docs delete <collectionId> <documentId> --org <orgId> [--yes]
  openwop kb search <collectionId> --org <orgId> --query <q> [--top-k <n>] [--json]
  openwop kb rag <collectionId> --org <orgId> --query <q> [--top-k <n>] [--json]

Knowledge base (host-extension, org-scoped). Collections hold documents; \`search\` runs
retrieval and \`rag\` a retrieve-then-generate query. Every command needs --org. The host
is the authority; the CLI mirrors + relays.

${specsUsage('kb', KB_EXT_SPECS)}

Exit codes: 0 ok · 2 usage error / request rejected (404 = no reindex job) · 4 not
signed in or not permitted · 1 server error.

Examples:
  openwop kb collections retrieval kc_1 --org org_1 --mode hybrid --embedder local
  openwop kb collections reindex drain kc_1 --org org_1 --max-chunks 512
`;


export async function runKb(ctx: Ctx, argv: string[]) {
  const group = argv[0] ?? 'collections';
  if (group === '--help' || group === '-h') { write(ctx.io.stdout, KB_HELP); return 0; }
  const rest = argv.slice(1);
  const ext = await dispatchSpecs(ctx, 'kb', KB_EXT_SPECS, argv);
  if (ext !== undefined) return ext;
  switch (group) {
    case 'collections': return kbCollections(ctx, rest);
    case 'docs': return kbDocs(ctx, rest);
    case 'search': return kbSearch(ctx, rest, 'search');
    case 'rag': return kbSearch(ctx, rest, 'rag');
    default: throw new CliError(`Unknown kb command: ${group}. Use collections|docs|search|rag.`);
  }
}

async function kbCollections(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'create', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name'] });
  if (options.help) { write(ctx.io.stdout, KB_HELP); return 0; }
  const org = requireOrg(options.org);
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, cols(org));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.collections) ? res.body.collections : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No collections.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((c: any) => ({ id: c.id ?? c.collectionId ?? '', name: c.name ?? '', docs: c.documentCount ?? '' })), ['id', 'name', 'docs']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop kb collections get <collectionId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${cols(org)}/${encodeURIComponent(positionals[0])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      if (!options.name) { write(ctx.io.stderr, 'kb collections create needs --name.\n'); return 2; }
      const res = await requestJson(ctx, cols(org), { method: 'POST', body: { name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created collection ${res.body?.id ?? res.body?.collectionId ?? ''} (${String(options.name)}).`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop kb collections delete <collectionId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete collection ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `${cols(org)}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted collection ${positionals[0]}.`); return 0;
    }
    default: throw new CliError(`Unknown kb collections command: ${sub}`);
  }
}

async function kbDocs(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'add', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--title', '--text'] });
  if (options.help) { write(ctx.io.stdout, KB_HELP); return 0; }
  const org = requireOrg(options.org);
  const collectionId = positionals[0];
  if (!collectionId) { write(ctx.io.stderr, 'kb docs commands need a <collectionId>.\n'); return 2; }
  const docsUrl = `${cols(org)}/${encodeURIComponent(collectionId)}/documents`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, docsUrl);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.documents) ? res.body.documents : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No documents.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((d: any) => ({ id: d.id ?? d.documentId ?? '', title: d.title ?? '' })), ['id', 'title']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 2) { write(ctx.io.stderr, 'Usage: openwop kb docs get <collectionId> <documentId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${docsUrl}/${encodeURIComponent(positionals[1])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'add': {
      if (!options.title || !options.text) { write(ctx.io.stderr, 'kb docs add needs --title and --text.\n'); return 2; }
      const res = await requestJson(ctx, docsUrl, { method: 'POST', body: { title: String(options.title), text: String(options.text) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Added document ${res.body?.id ?? ''} to ${collectionId}.`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 2) { write(ctx.io.stderr, 'Usage: openwop kb docs delete <collectionId> <documentId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete document ${positionals[1]} without --yes.`, 2);
      await requestJson(ctx, `${docsUrl}/${encodeURIComponent(positionals[1])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted document ${positionals[1]}.`); return 0;
    }
    default: throw new CliError(`Unknown kb docs command: ${sub}`);
  }
}

async function kbSearch(ctx: Ctx, argv: string[], kind: 'search' | 'rag') {
  const { options, positionals } = parseOptions(argv, { value: ['--org', '--query', '--top-k'] });
  const org = requireOrg(options.org);
  if (positionals.length !== 1 || !options.query) { write(ctx.io.stderr, `Usage: openwop kb ${kind} <collectionId> --org <orgId> --query <q> [--top-k <n>] [--json]\n`); return 2; }
  const body: Record<string, unknown> = { query: String(options.query) };
  if (options.topK !== undefined) body.topK = Number(options.topK);
  const res = await requestJson(ctx, `${cols(org)}/${encodeURIComponent(positionals[0])}/${kind}`, { method: 'POST', body });
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

import type { Ctx } from '../context.js';
/** `openwop kb ...` — knowledge base: collections, documents, search, RAG (feature: kb). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const base = (org: string) => `/v1/host/sample/kb/orgs/${encodeURIComponent(org)}`;
const cols = (org: string) => `${base(org)}/collections`;

export const KB_HELP = `Usage:
  openwop kb collections list --org <orgId> [--json]
  openwop kb collections get <collectionId> --org <orgId> [--json]
  openwop kb collections create --org <orgId> --name <n> [--json]
  openwop kb collections delete <collectionId> --org <orgId> [--yes]
  openwop kb docs list <collectionId> --org <orgId> [--json]
  openwop kb docs get <collectionId> <documentId> --org <orgId> [--json]
  openwop kb docs add <collectionId> --org <orgId> --title <t> --content <text> [--json]
  openwop kb docs delete <collectionId> <documentId> --org <orgId> [--yes]
  openwop kb search <collectionId> --org <orgId> --query <q> [--top-k <n>] [--json]
  openwop kb rag <collectionId> --org <orgId> --query <q> [--top-k <n>] [--json]

Knowledge base (host-extension, org-scoped). Collections hold documents; \`search\` runs
retrieval and \`rag\` a retrieve-then-generate query. Every command needs --org. The host
is the authority; the CLI mirrors + relays.
`;

function requireOrg(org: unknown): string {
  if (!org) throw new CliError('This command is org-scoped — pass --org <orgId>.', 2);
  return String(org);
}

export async function runKb(ctx: Ctx, argv: string[]) {
  const group = argv[0] ?? 'collections';
  if (group === '--help' || group === '-h') { write(ctx.io.stdout, KB_HELP); return 0; }
  const rest = argv.slice(1);
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
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--title', '--content'] });
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
      if (!options.title || !options.content) { write(ctx.io.stderr, 'kb docs add needs --title and --content.\n'); return 2; }
      const res = await requestJson(ctx, docsUrl, { method: 'POST', body: { title: String(options.title), content: String(options.content) } });
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

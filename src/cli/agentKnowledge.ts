import type { Ctx } from '../context.js';
/**
 * `openwop agent-knowledge ...` — per-agent knowledge + memory curation
 * (openwop-app ADR 0038 per-agent knowledge memory; ADR 0041 memory tab).
 *
 * Host-extension surface (non-normative) under
 * /v1/host/openwop-app/agents/{agentId}/knowledge. Every route is gated by the
 * HOST, in order: the agent must be yours (a missing or cross-tenant agent is
 * a uniform 404), then RBAC (workspace:read for view/retrieve/notes,
 * workspace:write for writes), then the agent's own profile policy on the write
 * class (knowledge.bind / knowledge.ingest / knowledge.note — a `never` entry is
 * a 403). Org-scoped writes (create collection, ingest, delete a document)
 * also need workspace:write in the --org you name. The CLI relays; the host
 * decides.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const base = (agentId: string) => `/v1/host/openwop-app/agents/${encodeURIComponent(agentId)}/knowledge`;

export const AGENT_KNOWLEDGE_HELP = `Usage:
  openwop agent-knowledge show <agentId> [--json]
  openwop agent-knowledge retrieve <agentId> --query <text> [--json]
  openwop agent-knowledge bind <agentId> <collectionId> [--json]
  openwop agent-knowledge unbind <agentId> <collectionId>
  openwop agent-knowledge create-collection <agentId> --org <orgId> --name <n> [--description <t>] [--json]
  openwop agent-knowledge ingest <agentId> <collectionId> --org <orgId> --title <t> (--text <t> | --media-token <tok>) [--json]
  openwop agent-knowledge import <agentId> <collectionId> --org <orgId> --provider <p> --ref <ref> [--json]
  openwop agent-knowledge delete-document <agentId> <collectionId> <documentId> --org <orgId> [--yes]
  openwop agent-knowledge notes <agentId> [--json]
  openwop agent-knowledge add-note <agentId> --content <text> [--json]
  openwop agent-knowledge delete-note <agentId> <noteId> [--yes]
  openwop agent-knowledge memory-writable <agentId> (--on | --off) [--json]

Per-agent knowledge curation (host-extension, ADR 0038). Every command hits
/v1/host/openwop-app/agents/{agentId}/knowledge[...]:

  show               GET    .../knowledge                       — bindings, collections, notes summary
  retrieve           POST   .../knowledge/retrieve              — read-only cited retrieval { query }
  bind               POST   .../knowledge/bindings              — bind a KB collection { collectionId }
  unbind             DELETE .../knowledge/bindings/{collectionId}
  create-collection  POST   .../knowledge/collections           — { orgId, name, description? } (bound to the agent)
  ingest             POST   .../knowledge/collections/{id}/documents                 — { orgId, title, text | mediaToken }
  import             POST   .../knowledge/collections/{id}/documents/from-connection — { orgId, provider, ref }
                     (fetched through YOUR connected account; 409 when the connection is missing)
  delete-document    DELETE .../knowledge/collections/{id}/documents/{documentId}    — { orgId }
  notes              GET    .../knowledge/notes                 — curated notes + recall-only count
  add-note           POST   .../knowledge/notes                 — { content }
  delete-note        DELETE .../knowledge/notes/{noteId}
  memory-writable    PUT    .../knowledge/memory-writable       — { writable }

The host is the authority: a missing or foreign agent is 404, a missing scope is
403 (exit 4), and the agent's profile policy may deny a write class (403).

Examples:
  openwop agent-knowledge show my-agent
  openwop agent-knowledge retrieve my-agent --query "refund policy"
  openwop agent-knowledge create-collection my-agent --org org_1 --name "Support docs"
  openwop agent-knowledge ingest my-agent col_1 --org org_1 --title "FAQ" --text "Q: ... A: ..."
  openwop agent-knowledge add-note my-agent --content "Prefers concise answers"
  openwop agent-knowledge memory-writable my-agent --off
`;

const SUBS = ['show', 'retrieve', 'bind', 'unbind', 'create-collection', 'ingest', 'import', 'delete-document', 'notes', 'add-note', 'delete-note', 'memory-writable'];

export async function runAgentKnowledge(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_KNOWLEDGE_HELP); return sub ? 0 : 2; }
  if (!SUBS.includes(sub)) throw new CliError(`Unknown agent-knowledge command: ${sub}\nRun \`openwop agent-knowledge --help\` for usage.`);
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes', '--on', '--off'],
    value: ['--query', '--org', '--name', '--description', '--title', '--text', '--media-token', '--provider', '--ref', '--content'],
  });
  if (options.help) { write(ctx.io.stdout, AGENT_KNOWLEDGE_HELP); return 0; }
  const need = (n: number, usage: string) => {
    if (positionals.length !== n) throw new CliError(`Usage: openwop agent-knowledge ${sub} ${usage}`, 2);
  };
  const out = (body: unknown, human: string) => {
    if (ctx.json) writeJson(ctx.io.stdout, body);
    else writeLine(ctx.io.stdout, human);
    return 0;
  };

  switch (sub) {
    case 'show': {
      need(1, '<agentId> [--json]');
      const res = await requestJson(ctx, base(positionals[0]));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      renderKnowledge(ctx, positionals[0], res.body);
      return 0;
    }
    case 'retrieve': {
      need(1, '<agentId> --query <text> [--json]');
      if (!options.query) throw new CliError('retrieve needs --query <text>.', 2);
      const res = await requestJson(ctx, `${base(positionals[0])}/retrieve`, { method: 'POST', body: { query: options.query } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const hits = Array.isArray(res.body?.chunks) ? res.body.chunks : [];
      if (hits.length === 0) { writeLine(ctx.io.stdout, 'No matching knowledge for that query.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(hits.map((h: any) => ({
        kind: h.kind ?? '',
        title: h.title ?? '',
        trust: h.contentTrust ?? '',
        content: String(h.content ?? '').replace(/\s+/g, ' ').slice(0, 70),
      })), ['kind', 'title', 'trust', 'content']));
      return 0;
    }
    case 'bind': {
      need(2, '<agentId> <collectionId> [--json]');
      const res = await requestJson(ctx, `${base(positionals[0])}/bindings`, { method: 'POST', body: { collectionId: positionals[1] } });
      return out(res.body, `Bound collection ${positionals[1]} to agent ${positionals[0]}.`);
    }
    case 'unbind': {
      need(2, '<agentId> <collectionId>');
      await requestJson(ctx, `${base(positionals[0])}/bindings/${encodeURIComponent(positionals[1])}`, { method: 'DELETE' });
      return out({ unbound: positionals[1] }, `Unbound collection ${positionals[1]} from agent ${positionals[0]}.`);
    }
    case 'create-collection': {
      need(1, '<agentId> --org <orgId> --name <n> [--description <t>] [--json]');
      const orgId = requireOrg(options.org);
      if (!options.name) throw new CliError('create-collection needs --name <n>.', 2);
      const body: Record<string, unknown> = { orgId, name: options.name };
      if (options.description) body.description = options.description;
      const res = await requestJson(ctx, `${base(positionals[0])}/collections`, { method: 'POST', body });
      return out(res.body, `Created collection ${res.body?.collectionId ?? res.body?.id ?? ''} (${options.name}) bound to agent ${positionals[0]}.`);
    }
    case 'ingest': {
      need(2, '<agentId> <collectionId> --org <orgId> --title <t> (--text <t> | --media-token <tok>) [--json]');
      const orgId = requireOrg(options.org);
      if (!options.title) throw new CliError('ingest needs --title <t>.', 2);
      if (!options.text && !options.mediaToken) throw new CliError('ingest needs --text <t> or --media-token <tok>.', 2);
      const body: Record<string, unknown> = { orgId, title: options.title };
      if (options.text) body.text = options.text;
      if (options.mediaToken) body.mediaToken = options.mediaToken;
      const res = await requestJson(ctx, `${base(positionals[0])}/collections/${encodeURIComponent(positionals[1])}/documents`, { method: 'POST', body });
      return out(res.body, `Ingested "${options.title}" into collection ${positionals[1]}${res.body?.documentId ? ` (document ${res.body.documentId})` : ''}.`);
    }
    case 'import': {
      need(2, '<agentId> <collectionId> --org <orgId> --provider <p> --ref <ref> [--json]');
      const orgId = requireOrg(options.org);
      if (!options.provider || !options.ref) throw new CliError('import needs --provider <p> and --ref <ref>.', 2);
      const res = await requestJson(ctx, `${base(positionals[0])}/collections/${encodeURIComponent(positionals[1])}/documents/from-connection`, {
        method: 'POST',
        body: { orgId, provider: options.provider, ref: options.ref },
      });
      return out(res.body, `Imported ${options.ref} from ${options.provider} into collection ${positionals[1]}${res.body?.documentId ? ` (document ${res.body.documentId})` : ''}.`);
    }
    case 'delete-document': {
      need(3, '<agentId> <collectionId> <documentId> --org <orgId> [--yes]');
      const orgId = requireOrg(options.org);
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete document ${positionals[2]} without --yes.`); return 2; }
      await requestJson(ctx, `${base(positionals[0])}/collections/${encodeURIComponent(positionals[1])}/documents/${encodeURIComponent(positionals[2])}`, {
        method: 'DELETE',
        body: { orgId },
      });
      return out({ deleted: positionals[2] }, `Deleted document ${positionals[2]} from collection ${positionals[1]}.`);
    }
    case 'notes': {
      need(1, '<agentId> [--json]');
      const res = await requestJson(ctx, `${base(positionals[0])}/notes`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const notes = Array.isArray(res.body?.notes) ? res.body.notes : [];
      if (notes.length === 0) writeLine(ctx.io.stdout, 'No curated notes.');
      else writeLine(ctx.io.stdout, formatTable(notes.map((n: any) => ({
        noteId: n.noteId ?? n.id ?? '',
        createdAt: n.createdAt ?? '',
        content: String(n.content ?? n.text ?? '').replace(/\s+/g, ' ').slice(0, 70),
      })), ['noteId', 'createdAt', 'content']));
      if (typeof res.body?.recallOnlyCount === 'number') writeLine(ctx.io.stdout, `Recall-only memories (not removable here): ${res.body.recallOnlyCount}`);
      return 0;
    }
    case 'add-note': {
      need(1, '<agentId> --content <text> [--json]');
      if (!options.content) throw new CliError('add-note needs --content <text>.', 2);
      const res = await requestJson(ctx, `${base(positionals[0])}/notes`, { method: 'POST', body: { content: options.content } });
      return out(res.body, `Added a note to agent ${positionals[0]}.`);
    }
    case 'delete-note': {
      need(2, '<agentId> <noteId> [--yes]');
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete note ${positionals[1]} without --yes.`); return 2; }
      await requestJson(ctx, `${base(positionals[0])}/notes/${encodeURIComponent(positionals[1])}`, { method: 'DELETE' });
      return out({ deleted: positionals[1] }, `Deleted note ${positionals[1]}.`);
    }
    case 'memory-writable': {
      need(1, '<agentId> (--on | --off) [--json]');
      if (Boolean(options.on) === Boolean(options.off)) throw new CliError('memory-writable needs exactly one of --on / --off.', 2);
      const writable = Boolean(options.on);
      const res = await requestJson(ctx, `${base(positionals[0])}/memory-writable`, { method: 'PUT', body: { writable } });
      return out(res.body, `Agent ${positionals[0]} memory is now ${writable ? 'writable' : 'read-only'}.`);
    }
  }
  return 2;
}

function renderKnowledge(ctx: Ctx, agentId: string, k: any): void {
  writeLine(ctx.io.stdout, `agent: ${agentId}`);
  if (typeof k?.knowledgeEnabled === 'boolean') writeLine(ctx.io.stdout, `knowledgeEnabled: ${k.knowledgeEnabled ? 'yes' : 'no'}`);
  if (typeof k?.memoryWritable === 'boolean') writeLine(ctx.io.stdout, `memoryWritable: ${k.memoryWritable ? 'yes' : 'no'}`);
  const cols = Array.isArray(k?.collections) ? k.collections : [];
  writeLine(ctx.io.stdout, `collections (${cols.length}):`);
  if (cols.length) {
    writeLine(ctx.io.stdout, formatTable(cols.map((c: any) => ({
      collectionId: c.collectionId ?? c.id ?? '',
      name: c.name ?? '',
      orgId: c.orgId ?? '',
      documents: String(c.documentCount ?? (Array.isArray(c.documents) ? c.documents.length : '')),
      chunks: String(c.chunkCount ?? ''),
    })), ['collectionId', 'name', 'orgId', 'documents', 'chunks']));
  }
  if (typeof k?.noteCount === 'number') writeLine(ctx.io.stdout, `notes: ${k.noteCount}`);
}

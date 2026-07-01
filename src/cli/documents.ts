import type { Ctx } from '../context.js';
/** `openwop documents ...` — document generation + templates (feature: documents). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const base = (org: string) => `/v1/host/sample/documents/orgs/${encodeURIComponent(org)}`;

export const DOCUMENTS_HELP = `Usage:
  openwop documents list --org <orgId> [--json]
  openwop documents get <documentId> --org <orgId> [--json]
  openwop documents create --org <orgId> --title <t> --kind <k> [--format <f>] [--json]
  openwop documents update <documentId> --org <orgId> [--title <t>] [--json]
  openwop documents delete <documentId> --org <orgId> [--yes]
  openwop documents versions <documentId> --org <orgId> [--json]
  openwop documents render <documentId> --org <orgId> [--json]
  openwop documents templates list --org <orgId> [--json]
  openwop documents templates get <templateId> --org <orgId> [--json]
  openwop documents templates create --org <orgId> --name <n> --kind <k> [--output-format <f>] [--json]
  openwop documents templates delete <templateId> --org <orgId> [--yes]

Document generation + templates (host-extension, org-scoped). A document has a
title/kind/format and versioned content; \`render\` produces its output; templates
drive assembly. Every command needs --org. The host is the authority; the CLI relays.
`;

function requireOrg(org: unknown): string {
  if (!org) throw new CliError('This command is org-scoped — pass --org <orgId>.', 2);
  return String(org);
}

export async function runDocuments(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  if (sub === 'templates') return docTemplates(ctx, argv.slice(1));
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete', 'versions', 'render'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--title', '--kind', '--format'] });
  if (options.help) { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const org = requireOrg(options.org);
  const docs = `${base(org)}/documents`;
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, docs);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.documents) ? res.body.documents : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No documents.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((d: any) => ({ id: d.id ?? '', title: d.title ?? '', kind: d.kind ?? '', format: d.format ?? '' })), ['id', 'title', 'kind', 'format']));
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop documents get <documentId> --org <orgId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${docs}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.title || !options.kind) { write(ctx.io.stderr, 'documents create needs --title and --kind.\n'); return 2; }
      const body: Record<string, string> = { title: String(options.title), kind: String(options.kind) };
      if (options.format) body.format = String(options.format);
      const res = await requestJson(ctx, docs, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created document ${res.body?.id ?? ''} (${String(options.title)}).`);
      return 0;
    }
    case 'update': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop documents update <documentId> --org <orgId> [--title t]\n'); return 2; }
      const patch: Record<string, string> = {}; if (options.title) patch.title = String(options.title);
      const res = await requestJson(ctx, `${docs}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated document ${id}.`);
      return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop documents delete <documentId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete document ${id} without --yes.`, 2);
      await requestJson(ctx, `${docs}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted document ${id}.`); return 0;
    }
    case 'versions': { if (!id) { write(ctx.io.stderr, 'Usage: openwop documents versions <documentId> --org <orgId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${docs}/${encodeURIComponent(id)}/versions`)).body); return 0; }
    case 'render': { if (!id) { write(ctx.io.stderr, 'Usage: openwop documents render <documentId> --org <orgId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${docs}/${encodeURIComponent(id)}/render`, { method: 'POST', body: {} })).body); return 0; }
    default: throw new CliError(`Unknown documents command: ${sub}`);
  }
}

async function docTemplates(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'create', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name', '--kind', '--output-format'] });
  if (options.help) { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const org = requireOrg(options.org);
  const url = `${base(org)}/templates`;
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, url);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.templates) ? res.body.templates : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No templates.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((t: any) => ({ id: t.id ?? '', name: t.name ?? '', kind: t.kind ?? '' })), ['id', 'name', 'kind']));
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop documents templates get <templateId> --org <orgId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${url}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.name || !options.kind) { write(ctx.io.stderr, 'documents templates create needs --name and --kind.\n'); return 2; }
      const body: Record<string, string> = { name: String(options.name), kind: String(options.kind) };
      if (options.outputFormat) body.outputFormat = String(options.outputFormat);
      const res = await requestJson(ctx, url, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created template ${res.body?.id ?? ''} (${String(options.name)}).`);
      return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop documents templates delete <templateId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete template ${id} without --yes.`, 2);
      await requestJson(ctx, `${url}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted template ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown documents templates command: ${sub}`);
  }
}

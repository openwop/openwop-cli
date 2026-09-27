import type { Ctx } from '../context.js';
/**
 * `openwop documents ...` — documents, versions, templates, canvas sources and the
 * artifact workbench (feature: documents).
 *
 * Host-extension, non-normative. Sources:
 *   - ADR 0053 (documents + templates), ADR 0057 (rendering), ADR 0056/0319
 *     (canvas → document), ADR 0350 (per-document URLs → `locate`).
 *   - ADR 0069 + ADR 0083 (the artifact workbench: a read-only projection over
 *     documents, media and run-output artifacts — `documents artifacts ...`).
 * Paths: `/v1/host/openwop-app/documents/orgs/<orgId>/...`,
 *        `/v1/host/openwop-app/documents/locate/<documentId>`,
 *        `/v1/host/openwop-app/artifacts/<artifactId>...`.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { enc, mergeBody, parseJsonFlag, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

const base = (org: string) => `/v1/host/openwop-app/documents/orgs/${enc(org)}`;
const ARTIFACTS = '/v1/host/openwop-app/artifacts';

export const DOCUMENTS_HELP = `Usage:
  openwop documents list --org <orgId> [--kind <k>] [--status <s>] [--owner-kind agent|user|project --owner-id <id>] [--json]
  openwop documents get <documentId> --org <orgId> [--json]
  openwop documents locate <documentId> [--json]
  openwop documents create --org <orgId> --title <t> --kind <k> [--format <f>] [--template <templateId>]
                           [--owner-kind <k> --owner-id <id>] [--body <json> | --body-file <path>] [--json]
  openwop documents from-canvas <canvasId> --org <orgId> [--json]
  openwop documents update <documentId> --org <orgId> [--title <t>] [--status <s>] [--promoted-canvas <canvasId>]
                           [--owner-kind <k> --owner-id <id>] [--body <json> | --body-file <path>] [--json]
  openwop documents delete <documentId> --org <orgId> --yes
  openwop documents versions <documentId> --org <orgId> [--json]
  openwop documents version <documentId> <versionId> --org <orgId> [--json]
  openwop documents add-version <documentId> --org <orgId> (--content <text> | --content-file <path>)
                           [--rendered-media-token <t>] [--idempotency-key <k>] [--json]
  openwop documents render <documentId> --org <orgId> [--format pdf|slides|sheet|docx|epub|odt|latex] [--json]
  openwop documents promote-html <documentId> --org <orgId> [--output <path>] [--json]
  openwop documents ingest-to-kb <documentId> --org <orgId> --collection <collectionId> [--json]
  openwop documents artifact-types --org <orgId> [--json]
  openwop documents canvas-sources --org <orgId> [--q <text>] [--json]
  openwop documents delete-canvas <canvasId> --org <orgId> --yes
  openwop documents templates list --org <orgId> [--kind <k>] [--json]
  openwop documents templates get <templateId> --org <orgId> [--json]
  openwop documents templates catalog --org <orgId> [--kind <k>] [--json]
  openwop documents templates from-catalog <catalogId> --org <orgId> [--json]
  openwop documents templates create --org <orgId> --name <n> --kind <k> [--output-format <f>] [--prompt-body <text>]
                           [--artifact-type <id>] [--body <json> | --body-file <path>] [--json]
  openwop documents templates update <templateId> --org <orgId> [--name <n>] [--prompt-body <text>]
                           [--artifact-type <id>] [--parameters <json>] [--output-schema <json>]
                           [--body <json> | --body-file <path>] [--json]
  openwop documents templates assemble <templateId> --org <orgId> [--params <json>] [--json]
  openwop documents templates delete <templateId> --org <orgId> --yes
  openwop documents artifacts list [--limit <n>] [--cursor <c>] [--json]
  openwop documents artifacts get <artifactId> [--json]
  openwop documents artifacts revisions <artifactId> [--json]
  openwop documents artifacts revision <artifactId> <revisionId> [--json]
  openwop documents artifacts diff <artifactId> --from <revisionId> --to <revisionId> [--json]

Document generation + templates (host-extension, ADR 0053). Org-scoped commands hit
/v1/host/openwop-app/documents/orgs/<orgId>/... and need --org (read = workspace:read,
write = workspace:write; promoting a document to approved/final needs
host:members:manage). \`locate\` resolves a document id to its owning org
(/v1/host/openwop-app/documents/locate/<documentId>). \`templates assemble\` returns the
augmented prompt + output schema for a template (no model call). \`templates update\`
sends only the fields you pass (a partial PUT). \`artifacts\` reads the type-neutral
artifact workbench (/v1/host/openwop-app/artifacts/..., ADR 0083) across documents,
media and run outputs — a hidden artifact reads as not found. The host is the
authority; the CLI relays.

Exit codes: 0 ok; 2 usage error or a 4xx (e.g. not found / validation); 4 auth or
permission denied; 1 server error.

Examples:
  openwop documents list --org org_1 --kind report
  openwop documents create --org org_1 --title "Q3 plan" --kind plan --format markdown
  openwop documents add-version doc_1 --org org_1 --content-file plan.md
  openwop documents render doc_1 --org org_1 --format docx
  openwop documents templates assemble tpl_1 --org org_1 --params '{"topic":"pricing"}'
  openwop documents artifacts diff art_1 --from rev_1 --to rev_2 --json
`;

const DOC_SUBS = ['list', 'get', 'locate', 'create', 'from-canvas', 'update', 'delete', 'versions', 'version', 'add-version', 'render', 'promote-html', 'ingest-to-kb', 'artifact-types', 'canvas-sources', 'delete-canvas'];

function usage(ctx: Ctx, line: string): number {
  write(ctx.io.stderr, `Usage: openwop documents ${line}\n`);
  return 2;
}

function ownerSubject(options: Record<string, any>): { kind: string; id: string } | undefined {
  if (!options.ownerKind && !options.ownerId) return undefined;
  if (!options.ownerKind || !options.ownerId) throw new CliError('--owner-kind and --owner-id must be passed together.', 2);
  return { kind: String(options.ownerKind), id: String(options.ownerId) };
}

export async function runDocuments(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  if (sub === 'templates') return docTemplates(ctx, argv.slice(1));
  if (sub === 'artifacts') return docArtifacts(ctx, argv.slice(1));
  if (!DOC_SUBS.includes(sub)) throw new CliError(`Unknown documents command: ${sub}\nRun \`openwop documents --help\` for usage.`);
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--org', '--title', '--kind', '--format', '--status', '--owner-kind', '--owner-id', '--template',
      '--promoted-canvas', '--content', '--content-file', '--rendered-media-token', '--idempotency-key',
      '--collection', '--q', '--output', '--body', '--body-file'],
  });
  if (options.help) { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const id = positionals[0];

  if (sub === 'locate') {
    if (!id) return usage(ctx, 'locate <documentId>');
    const res = await requestJson(ctx, `/v1/host/openwop-app/documents/locate/${enc(id)}`);
    return renderDone(ctx, res.body, `Document ${id} belongs to org ${res.body?.orgId ?? ''}.`);
  }

  const org = requireOrg(options.org);
  const docs = `${base(org)}/documents`;
  switch (sub) {
    case 'list': {
      const owner = ownerSubject(options);
      const res = await requestJson(ctx, withQuery(docs, { kind: options.kind, status: options.status, ownerKind: owner?.kind, ownerId: owner?.id }));
      return renderList(ctx, res.body, pickArray(res.body, 'documents'), ['id', 'title', 'kind', 'format', 'status'], 'No documents.',
        (d) => ({ id: d.documentId ?? d.id ?? '', title: d.title ?? '', kind: d.kind ?? '', format: d.format ?? '', status: d.status ?? '' }));
    }
    case 'get': {
      if (!id) return usage(ctx, 'get <documentId> --org <orgId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${docs}/${enc(id)}`)).body); return 0;
    }
    case 'create': {
      const body = mergeBody(ctx, options, {
        title: options.title, kind: options.kind, format: options.format,
        templateId: options.template, ownerSubject: ownerSubject(options),
      });
      if (!body.title || !body.kind) { write(ctx.io.stderr, 'documents create needs --title and --kind.\n'); return 2; }
      const res = await requestJson(ctx, docs, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created document ${res.body?.documentId ?? res.body?.id ?? ''} (${String(body.title)}).`);
    }
    case 'from-canvas': {
      if (!id) return usage(ctx, 'from-canvas <canvasId> --org <orgId>');
      const res = await requestJson(ctx, `${docs}/from-canvas`, { method: 'POST', body: { canvasId: id } });
      const docId = res.body?.document?.documentId ?? res.body?.documentId ?? '';
      return renderDone(ctx, res.body, `${res.body?.created === false ? 'Reused' : 'Created'} document ${docId} from canvas ${id}.`);
    }
    case 'update': {
      if (!id) return usage(ctx, 'update <documentId> --org <orgId> [--title t] [--status s]');
      const patch = mergeBody(ctx, options, {
        title: options.title, status: options.status,
        promotedCanvasId: options.promotedCanvas, ownerSubject: ownerSubject(options),
      });
      if (Object.keys(patch).length === 0) { write(ctx.io.stderr, 'documents update needs at least one field (--title, --status, --promoted-canvas, --owner-kind/--owner-id, or --body).\n'); return 2; }
      const res = await requestJson(ctx, `${docs}/${enc(id)}`, { method: 'PATCH', body: patch });
      return renderDone(ctx, res.body, `Updated document ${id}.`);
    }
    case 'delete': {
      if (!id) return usage(ctx, 'delete <documentId> --org <orgId> --yes');
      if (!options.yes) throw new CliError(`Refusing to delete document ${id} without --yes.`, 2);
      await requestJson(ctx, `${docs}/${enc(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted document ${id}.`); return 0;
    }
    case 'versions': {
      if (!id) return usage(ctx, 'versions <documentId> --org <orgId>');
      const res = await requestJson(ctx, `${docs}/${enc(id)}/versions`);
      return renderList(ctx, res.body, pickArray(res.body, 'versions'), ['versionId', 'createdAt', 'producedBy'], 'No versions.',
        (v) => ({ versionId: v.versionId ?? v.id ?? '', createdAt: v.createdAt ?? '', producedBy: v.producedBy ? `${v.producedBy.kind ?? ''}:${v.producedBy.id ?? ''}` : '' }));
    }
    case 'version': {
      const versionId = positionals[1];
      if (!id || !versionId) return usage(ctx, 'version <documentId> <versionId> --org <orgId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${docs}/${enc(id)}/versions/${enc(versionId)}`)).body); return 0;
    }
    case 'add-version': {
      if (!id) return usage(ctx, 'add-version <documentId> --org <orgId> (--content <text> | --content-file <path>)');
      let content: string | undefined = options.content !== undefined ? String(options.content) : undefined;
      if (options.contentFile) {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        try { content = readFileSync(resolve(ctx.cwd, String(options.contentFile)), 'utf8'); } catch (err) {
          throw new CliError(`Cannot read --content-file ${String(options.contentFile)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (content === undefined) { write(ctx.io.stderr, 'documents add-version needs --content or --content-file.\n'); return 2; }
      const body: Record<string, string> = { content };
      if (options.renderedMediaToken) body.renderedMediaToken = String(options.renderedMediaToken);
      if (options.idempotencyKey) body.idempotencyKey = String(options.idempotencyKey);
      const res = await requestJson(ctx, `${docs}/${enc(id)}/versions`, { method: 'POST', body });
      return renderDone(ctx, res.body, `Added version ${res.body?.versionId ?? ''} to document ${id}.`);
    }
    case 'render': {
      if (!id) return usage(ctx, 'render <documentId> --org <orgId> [--format pdf]');
      const body = options.format ? { format: String(options.format) } : {};
      const res = await requestJson(ctx, `${docs}/${enc(id)}/render`, { method: 'POST', body });
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'promote-html': {
      if (!id) return usage(ctx, 'promote-html <documentId> --org <orgId> [--output path]');
      const res = await requestJson(ctx, `${docs}/${enc(id)}/promote-html`, { method: 'POST', body: {} });
      if (options.output) {
        const { writeFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        writeFileSync(resolve(ctx.cwd, String(options.output)), String(res.body?.html ?? ''));
      }
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      if (options.output) writeLine(ctx.io.stdout, `Wrote HTML for "${res.body?.title ?? id}" to ${String(options.output)}.`);
      else writeLine(ctx.io.stdout, String(res.body?.html ?? ''));
      return 0;
    }
    case 'ingest-to-kb': {
      if (!id || !options.collection) return usage(ctx, 'ingest-to-kb <documentId> --org <orgId> --collection <collectionId>');
      const res = await requestJson(ctx, `${docs}/${enc(id)}/ingest-to-kb`, { method: 'POST', body: { collectionId: String(options.collection) } });
      return renderDone(ctx, res.body, `Ingested document ${id} into knowledge-base collection ${String(options.collection)}.`);
    }
    case 'artifact-types': {
      const res = await requestJson(ctx, `${base(org)}/artifact-types`);
      return renderList(ctx, res.body, pickArray(res.body, 'artifactTypes'), ['id', 'label'], 'No artifact types.',
        (t) => ({ id: t.id ?? t.typeId ?? '', label: t.label ?? t.name ?? '' }));
    }
    case 'canvas-sources': {
      const res = await requestJson(ctx, withQuery(`${base(org)}/canvas-sources`, { q: options.q }));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const rows = pickArray(res.body, 'canvases');
      renderList(ctx, res.body, rows, ['canvasId', 'name', 'canvasTypeId'], 'No canvases.',
        (c) => ({ canvasId: c.canvasId ?? c.id ?? '', name: c.name ?? '', canvasTypeId: c.canvasTypeId ?? '' }));
      if (rows.length > 0 && typeof res.body?.total === 'number' && res.body.total > rows.length) writeLine(ctx.io.stdout, `(${rows.length} of ${res.body.total} shown)`);
      return 0;
    }
    case 'delete-canvas': {
      if (!id) return usage(ctx, 'delete-canvas <canvasId> --org <orgId> --yes');
      if (!options.yes) throw new CliError(`Refusing to delete canvas ${id} without --yes.`, 2);
      await requestJson(ctx, `${base(org)}/canvases/${enc(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted canvas ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown documents command: ${sub}`);
  }
}

async function docTemplates(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const known = ['list', 'get', 'catalog', 'from-catalog', 'create', 'update', 'assemble', 'delete'];
  if (!known.includes(sub)) throw new CliError(`Unknown documents templates command: ${sub}\nRun \`openwop documents --help\` for usage.`);
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--org', '--name', '--kind', '--output-format', '--prompt-body', '--prompt-ref', '--artifact-type',
      '--parameters', '--output-schema', '--params', '--body', '--body-file'],
  });
  if (options.help) { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const org = requireOrg(options.org);
  const url = `${base(org)}/templates`;
  const id = positionals[0];
  const richFields = () => ({
    promptBody: options.promptBody,
    parameters: options.parameters !== undefined ? parseJsonFlag('--parameters', options.parameters) : undefined,
    outputSchema: options.outputSchema !== undefined ? parseJsonFlag('--output-schema', options.outputSchema) : undefined,
    artifactTypeId: options.artifactType,
  });
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, withQuery(url, { kind: options.kind }));
      return renderList(ctx, res.body, pickArray(res.body, 'templates'), ['id', 'name', 'kind', 'outputFormat'], 'No templates.',
        (t) => ({ id: t.templateId ?? t.id ?? '', name: t.name ?? '', kind: t.kind ?? '', outputFormat: t.outputFormat ?? '' }));
    }
    case 'get': {
      if (!id) return usage(ctx, 'templates get <templateId> --org <orgId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${url}/${enc(id)}`)).body); return 0;
    }
    case 'catalog': {
      const res = await requestJson(ctx, withQuery(`${url}/catalog`, { kind: options.kind }));
      return renderList(ctx, res.body, pickArray(res.body, 'catalog'), ['id', 'name', 'kind'], 'No catalog templates.',
        (t) => ({ id: t.catalogId ?? t.id ?? '', name: t.name ?? '', kind: t.kind ?? '' }));
    }
    case 'from-catalog': {
      if (!id) return usage(ctx, 'templates from-catalog <catalogId> --org <orgId>');
      const res = await requestJson(ctx, `${url}/from-catalog/${enc(id)}`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Created template ${res.body?.templateId ?? res.body?.id ?? ''} from catalog entry ${id}.`);
    }
    case 'create': {
      const body = mergeBody(ctx, options, {
        name: options.name, kind: options.kind, outputFormat: options.outputFormat, promptRef: options.promptRef, ...richFields(),
      });
      if (!body.name || !body.kind) { write(ctx.io.stderr, 'documents templates create needs --name and --kind.\n'); return 2; }
      const res = await requestJson(ctx, url, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created template ${res.body?.templateId ?? res.body?.id ?? ''} (${String(body.name)}).`);
    }
    case 'update': {
      if (!id) return usage(ctx, 'templates update <templateId> --org <orgId> [--name n] ...');
      const body = mergeBody(ctx, options, { name: options.name, ...richFields() });
      if (Object.keys(body).length === 0) { write(ctx.io.stderr, 'documents templates update needs at least one field.\n'); return 2; }
      const res = await requestJson(ctx, `${url}/${enc(id)}`, { method: 'PUT', body });
      return renderDone(ctx, res.body, `Updated template ${id}.`);
    }
    case 'assemble': {
      if (!id) return usage(ctx, 'templates assemble <templateId> --org <orgId> [--params <json>]');
      const params = options.params !== undefined ? parseJsonFlag('--params', options.params) : {};
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${url}/${enc(id)}/assemble`, { method: 'POST', body: { params } })).body); return 0;
    }
    case 'delete': {
      if (!id) return usage(ctx, 'templates delete <templateId> --org <orgId> --yes');
      if (!options.yes) throw new CliError(`Refusing to delete template ${id} without --yes.`, 2);
      await requestJson(ctx, `${url}/${enc(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted template ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown documents templates command: ${sub}`);
  }
}

async function docArtifacts(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--from', '--to', '--limit', '--cursor'] });
  if (options.help) { write(ctx.io.stdout, DOCUMENTS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, withQuery(ARTIFACTS, { limit: options.limit, cursor: options.cursor }));
      const code = renderList(ctx, res.body, pickArray(res.body, 'artifacts'), ['artifactId', 'type', 'title', 'source'], 'No artifacts.',
        (a) => ({ artifactId: a.artifactId ?? a.id ?? '', type: a.type ?? a.typeId ?? '', title: a.title ?? '', source: a.source ?? '' }));
      if (!ctx.json && res.body?.nextCursor) writeLine(ctx.io.stdout, `More: --cursor ${String(res.body.nextCursor)}`);
      return code;
    }
    case 'get': {
      if (!id) return usage(ctx, 'artifacts get <artifactId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${ARTIFACTS}/${enc(id)}`)).body); return 0;
    }
    case 'revisions': {
      if (!id) return usage(ctx, 'artifacts revisions <artifactId>');
      const res = await requestJson(ctx, `${ARTIFACTS}/${enc(id)}/revisions`);
      return renderList(ctx, res.body, pickArray(res.body, 'revisions'), ['revisionId', 'createdAt'], 'No revisions.',
        (r) => ({ revisionId: r.revisionId ?? r.id ?? '', createdAt: r.createdAt ?? '' }));
    }
    case 'revision': {
      const revisionId = positionals[1];
      if (!id || !revisionId) return usage(ctx, 'artifacts revision <artifactId> <revisionId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${ARTIFACTS}/${enc(id)}/revisions/${enc(revisionId)}`)).body); return 0;
    }
    case 'diff': {
      if (!id || !options.from || !options.to) return usage(ctx, 'artifacts diff <artifactId> --from <revisionId> --to <revisionId>');
      writeJson(ctx.io.stdout, (await requestJson(ctx, withQuery(`${ARTIFACTS}/${enc(id)}/diff`, { from: options.from, to: options.to }))).body); return 0;
    }
    default: throw new CliError(`Unknown documents artifacts command: ${sub}\nRun \`openwop documents --help\` for usage.`);
  }
}

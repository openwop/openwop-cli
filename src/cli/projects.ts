import type { Ctx } from '../context.js';
/** `openwop projects ...` — project workspaces (feature: projects). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const BASE = '/v1/host/openwop-app/projects';

const P = `${BASE}/:id`;

/**
 * Declared project commands (routeKit), checked before the hand-written switch
 * (so `update` and `members add` here supersede the original minimal ones).
 * Paths/fields mirror features/projects/routes.ts.
 */
export const PROJECTS_ROUTES: RouteCmd[] = [
  { words: ['update'], method: 'PATCH', path: P, summary: 'Merge-patch a project. --workflows and --charter REPLACE their whole value (charter null clears).',
    body: [
      { flag: '--name', key: 'name' },
      { flag: '--workflows', key: 'workflows', type: 'csv' },
      { flag: '--charter', key: 'charter', type: 'json' },
      { flag: '--moderator-roster-id', key: 'moderatorRosterId' },
      { flag: '--turn-policy', key: 'turnPolicy', type: 'json' },
    ] },
  { words: ['visibility'], method: 'PATCH', path: `${P}/visibility`, summary: 'Set who can see a project: org | private.',
    body: [{ flag: '--visibility', key: 'visibility', required: true }] },
  { words: ['members', 'add'], method: 'POST', path: `${P}/members`, summary: 'Add (or re-role) a member: user:<userId> | agent:<rosterId>; role lead | contributor | observer.',
    body: [{ flag: '--ref', key: 'ref', required: true }, { flag: '--role', key: 'role' }] },
  { words: ['knowledge'], method: 'GET', path: `${P}/knowledge`, summary: 'Knowledge bound to the project (collections, documents, note count).',
    table: { key: 'collections', columns: ['collectionId', 'orgId', 'name', 'documentCount', 'chunkCount'], empty: 'No knowledge collections bound.' } },
  { words: ['knowledge', 'bind'], method: 'POST', path: `${P}/knowledge/bindings`, summary: 'Bind an existing knowledge collection to the project.',
    body: [{ flag: '--collection-id', key: 'collectionId', required: true }] },
  { words: ['knowledge', 'unbind'], method: 'DELETE', path: `${P}/knowledge/bindings/:collectionId`, summary: 'Unbind a collection (the collection itself is kept).' },
  { words: ['knowledge', 'collections', 'create'], method: 'POST', path: `${P}/knowledge/collections`, summary: 'Create a collection in --org and bind it to the project.',
    body: [{ flag: '--org', key: 'orgId', required: true }, { flag: '--name', key: 'name', required: true }, { flag: '--description', key: 'description' }] },
  { words: ['knowledge', 'documents', 'add'], method: 'POST', path: `${P}/knowledge/collections/:collectionId/documents`,
    summary: 'Add a document to a bound collection: inline --text, a text file, or a binary --file (sent base64 inside the JSON body).',
    body: [
      { flag: '--org', key: 'orgId', required: true }, { flag: '--title', key: 'title' },
      { flag: '--text', key: 'text' }, { flag: '--text-file', key: 'text', type: 'file' },
      { flag: '--file', key: 'contentBase64', type: 'file64' }, { flag: '--content-type', key: 'contentType' },
    ] },
  { words: ['knowledge', 'documents', 'remove'], method: 'DELETE', path: `${P}/knowledge/collections/:collectionId/documents/:documentId`, summary: 'Remove a document (the host needs its --org in the body).',
    body: [{ flag: '--org', key: 'orgId', required: true }] },
  { words: ['knowledge', 'retrieve'], method: 'POST', path: `${P}/knowledge/retrieve`, summary: 'Retrieve chunks from the project\'s knowledge + memory for a query.',
    body: [{ flag: '--query', key: 'query', required: true }] },
  { words: ['memory'], method: 'GET', path: `${P}/memory`, summary: 'Project memory notes.',
    table: { key: 'notes', columns: ['id', 'source', 'contentTrust', 'createdAt', 'content'], empty: 'No notes.' } },
  { words: ['memory', 'add'], method: 'POST', path: `${P}/memory`, summary: 'Add a memory note (≤ 4000 chars).', body: [{ flag: '--content', key: 'content', required: true }] },
  { words: ['memory', 'remove'], method: 'DELETE', path: `${P}/memory/:noteId`, summary: 'Remove a memory note.' },
  { words: ['schedules'], method: 'GET', path: `${P}/schedules`, summary: 'Scheduled workflow runs for the project.',
    table: { key: 'schedules', columns: ['jobId', 'cronExpr', 'enabled', 'workflowId', 'timezone', 'lastRunAt'], empty: 'No schedules.' } },
  { words: ['schedules', 'add'], method: 'POST', path: `${P}/schedules`, summary: 'Add a schedule (5-field cron).',
    body: [{ flag: '--cron-expr', key: 'cronExpr', required: true }, { flag: '--workflow-id', key: 'workflowId' }, { flag: '--timezone', key: 'timezone' }] },
  { words: ['schedules', 'update'], method: 'PATCH', path: `${P}/schedules/:jobId`, summary: 'Edit a schedule (--enabled / --no-enabled to toggle).',
    body: [{ flag: '--enabled', key: 'enabled', type: 'boolean' }, { flag: '--cron-expr', key: 'cronExpr' }, { flag: '--workflow-id', key: 'workflowId' }, { flag: '--timezone', key: 'timezone' }] },
  { words: ['schedules', 'remove'], method: 'DELETE', path: `${P}/schedules/:jobId`, summary: 'Remove a schedule.' },
  { words: ['chat'], method: 'POST', path: `${P}/chat`, summary: 'Ensure the project\'s group conversation exists (idempotent) and return its sessionId.' },
];

export const PROJECTS_HELP = `Usage:
  openwop projects list [--json]
  openwop projects get <projectId> [--json]
  openwop projects create --org <orgId> --name <n> [--json]
  openwop projects delete <projectId> [--yes]
  openwop projects members list <projectId> [--json]
  openwop projects members remove <projectId> <ref> [--yes]
${routesHelp('projects', PROJECTS_ROUTES)}
Project workspaces (host-extension). A project scopes members + knowledge + schedules;
\`create\` needs the owning --org. The host is the authority; the CLI mirrors + relays.
Reads need access to the project (private projects: members only); writes need
workspace:write in the project's org — membership alone never grants write.

Exit codes: 0 ok · 1 server error · 2 usage / not found / validation · 4 not signed in or not permitted.

Examples:
  openwop projects update p_1 --workflows wf.a,wf.b --charter '{"goal":"Ship v2","status":"active"}'
  openwop projects members add p_1 --ref agent:r_7 --role lead
  openwop projects knowledge documents add p_1 kc_1 --org o_1 --title Spec --file spec.pdf --content-type application/pdf
  openwop projects schedules add p_1 --cron-expr "0 9 * * 1" --workflow-id wf.weekly
  openwop projects chat p_1
`;

export async function runProjects(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PROJECTS_HELP); return 0; }
  const declared = await dispatchRoutes(ctx, 'projects', PROJECTS_ROUTES, argv);
  if (declared !== undefined) return declared;
  if (sub === 'members') return projectMembers(ctx, argv.slice(1));
  const args = argv.slice(['list', 'get', 'create', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name'] });
  if (options.help) { write(ctx.io.stdout, PROJECTS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.projects) ? res.body.projects : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No projects.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((p: any) => ({ id: p.id ?? '', name: p.name ?? '', org: p.orgId ?? '' })), ['id', 'name', 'org']));
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop projects get <projectId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.org || !options.name) { write(ctx.io.stderr, 'projects create needs --org and --name.\n'); return 2; }
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { orgId: String(options.org), name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created project ${res.body?.id ?? ''} (${String(options.name)}).`);
      return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop projects delete <projectId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete project ${id} without --yes.`, 2);
      await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted project ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown projects command: ${sub}`);
  }
}

async function projectMembers(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'remove'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'] });
  if (options.help) { write(ctx.io.stdout, PROJECTS_HELP); return 0; }
  const projectId = positionals[0];
  if (!projectId) { write(ctx.io.stderr, 'projects members commands need a <projectId>.\n'); return 2; }
  const url = `${BASE}/${encodeURIComponent(projectId)}/members`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, url);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.members) ? res.body.members : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((m: any) => ({ ref: m.ref ?? m.subject ?? '', role: m.role ?? '' })), ['ref', 'role']) : 'No members.');
      return 0;
    }
    case 'remove': {
      if (positionals.length !== 2) { write(ctx.io.stderr, 'Usage: openwop projects members remove <projectId> <ref> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to remove member ${positionals[1]} without --yes.`, 2);
      await requestJson(ctx, `${url}/${encodeURIComponent(positionals[1])}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Removed member ${positionals[1]}.`); return 0;
    }
    default: throw new CliError(`Unknown projects members command: ${sub}`);
  }
}

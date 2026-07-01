import type { Ctx } from '../context.js';
/** `openwop projects ...` — project workspaces (feature: projects). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/projects';

export const PROJECTS_HELP = `Usage:
  openwop projects list [--json]
  openwop projects get <projectId> [--json]
  openwop projects create --org <orgId> --name <n> [--json]
  openwop projects update <projectId> [--name <n>] [--json]
  openwop projects delete <projectId> [--yes]
  openwop projects members list <projectId> [--json]
  openwop projects members add <projectId> --ref <subjectRef> [--json]
  openwop projects members remove <projectId> <ref> [--yes]

Project workspaces (host-extension). A project scopes members + knowledge + schedules;
\`create\` needs the owning --org. The host is the authority; the CLI mirrors + relays.
`;

export async function runProjects(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PROJECTS_HELP); return 0; }
  if (sub === 'members') return projectMembers(ctx, argv.slice(1));
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete'].includes(sub) ? 1 : 0);
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
    case 'update': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop projects update <projectId> [--name n]\n'); return 2; }
      const patch: Record<string, string> = {}; if (options.name) patch.name = String(options.name);
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated project ${id}.`);
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
  const args = argv.slice(['list', 'add', 'remove'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--ref'] });
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
    case 'add': {
      if (!options.ref) { write(ctx.io.stderr, 'projects members add needs --ref <subjectRef>.\n'); return 2; }
      const res = await requestJson(ctx, url, { method: 'POST', body: { ref: String(options.ref) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Added member ${String(options.ref)} to ${projectId}.`);
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

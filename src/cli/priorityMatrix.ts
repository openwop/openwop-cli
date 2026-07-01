import type { Ctx } from '../context.js';
/** `openwop priority-matrix ...` — prioritization lists + ideas (feature: priority-matrix). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const LISTS = '/v1/host/sample/priority-matrix/lists';

export const PRIORITY_MATRIX_HELP = `Usage:
  openwop priority-matrix lists [--json]
  openwop priority-matrix get <listId> [--json]
  openwop priority-matrix create --org <orgId> --name <n> [--json]
  openwop priority-matrix delete <listId> [--yes]
  openwop priority-matrix ideas <listId> [--json]

Prioritization boards (host-extension). A list holds scored/voted ideas; \`ideas\` reads
a list's ideas. \`create\` needs the owning --org. The host is the authority.`;

export async function runPriorityMatrix(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'lists';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PRIORITY_MATRIX_HELP); return 0; }
  const args = argv.slice(['lists', 'get', 'create', 'delete', 'ideas'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name'] });
  if (options.help) { write(ctx.io.stdout, PRIORITY_MATRIX_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'lists': {
      const res = await requestJson(ctx, LISTS);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.lists) ? res.body.lists : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((l: any) => ({ id: l.id ?? l.listId ?? '', name: l.name ?? '', ideas: l.ideaCount ?? '' })), ['id', 'name', 'ideas']) : 'No lists.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop priority-matrix get <listId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${LISTS}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'ideas': { if (!id) { write(ctx.io.stderr, 'Usage: openwop priority-matrix ideas <listId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${LISTS}/${encodeURIComponent(id)}/ideas`)).body); return 0; }
    case 'create': {
      if (!options.org || !options.name) { write(ctx.io.stderr, 'priority-matrix create needs --org and --name.\n'); return 2; }
      const res = await requestJson(ctx, LISTS, { method: 'POST', body: { orgId: String(options.org), name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created list ${res.body?.id ?? ''} (${String(options.name)}).`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop priority-matrix delete <listId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete list ${id} without --yes.`, 2);
      await requestJson(ctx, `${LISTS}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted list ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown priority-matrix command: ${sub}`);
  }
}

import type { Ctx } from '../context.js';
/** `openwop notebooks ...` — NotebookLM-style notebooks (feature: notebooks). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/notebooks';

export const NOTEBOOKS_HELP = `Usage:
  openwop notebooks list [--json]
  openwop notebooks get <notebookId> [--json]
  openwop notebooks create --org <orgId> --name <n> [--json]
  openwop notebooks delete <notebookId> [--yes]
  openwop notebooks notes <notebookId> [--json]

NotebookLM-style notebooks (host-extension). A notebook holds sources + notes + a chat.
\`create\` needs the owning --org. The host is the authority; the CLI mirrors + relays.`;

export async function runNotebooks(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'create', 'delete', 'notes'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name'] });
  if (options.help) { write(ctx.io.stdout, NOTEBOOKS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.notebooks) ? res.body.notebooks : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((n: any) => ({ id: n.id ?? '', title: n.title ?? '', sources: n.sourceCount ?? '' })), ['id', 'title', 'sources']) : 'No notebooks.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop notebooks get <notebookId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'notes': { if (!id) { write(ctx.io.stderr, 'Usage: openwop notebooks notes <notebookId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}/notes`)).body); return 0; }
    case 'create': {
      if (!options.org || !options.name) { write(ctx.io.stderr, 'notebooks create needs --org and --name.\n'); return 2; }
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { orgId: String(options.org), name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created notebook ${res.body?.id ?? ''} (${String(options.name)}).`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop notebooks delete <notebookId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete notebook ${id} without --yes.`, 2);
      await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted notebook ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown notebooks command: ${sub}`);
  }
}

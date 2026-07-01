import type { Ctx } from '../context.js';
/** `openwop strategy ...` — strategy documents (feature: strategy). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/strategy';

export const STRATEGY_HELP = `Usage:
  openwop strategy list [--json]
  openwop strategy get <strategyId> [--json]
  openwop strategy create --org <orgId> --title <t> [--json]
  openwop strategy update <strategyId> [--title <t>] [--json]
  openwop strategy delete <strategyId> [--yes]
  openwop strategy context [--json]
  openwop strategy health [--json]

Strategy documents (host-extension). \`context\`/\`health\` read the strategy context +
its health. \`create\` needs the owning --org. The host is the authority; the CLI relays.`;

export async function runStrategy(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, STRATEGY_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete', 'context', 'health'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--title'] });
  if (options.help) { write(ctx.io.stdout, STRATEGY_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.strategies) ? res.body.strategies : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((s: any) => ({ id: s.id ?? '', title: s.title ?? '', org: s.orgId ?? '' })), ['id', 'title', 'org']) : 'No strategies.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop strategy get <strategyId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'context': writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/context`)).body); return 0;
    case 'health': writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/health`)).body); return 0;
    case 'create': {
      if (!options.org || !options.title) { write(ctx.io.stderr, 'strategy create needs --org and --title.\n'); return 2; }
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { orgId: String(options.org), title: String(options.title) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created strategy ${res.body?.id ?? ''} (${String(options.title)}).`); return 0;
    }
    case 'update': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop strategy update <strategyId> [--title t]\n'); return 2; }
      const patch: Record<string, string> = {}; if (options.title) patch.title = String(options.title);
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated strategy ${id}.`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop strategy delete <strategyId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete strategy ${id} without --yes.`, 2);
      await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted strategy ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown strategy command: ${sub}`);
  }
}

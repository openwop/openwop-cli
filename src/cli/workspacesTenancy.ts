import type { Ctx } from '../context.js';
/** `openwop workspaces ...` — B2B workspace-as-tenant list/create/switch (ADR 0015).
 *  NOTE: distinct from `workspace` (singular) — the per-tenant agent FILE workspace. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

export const WORKSPACES_HELP = `Usage:
  openwop workspaces list [--json]
  openwop workspaces create --name <n> [--json]
  openwop workspaces switch <workspaceId> [--json]

Your B2B workspaces (each a tenant, ADR 0015). \`switch\` changes the active workspace.
Distinct from \`workspace\` (singular) — the per-tenant agent FILE store.`;

export async function runWorkspaces(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, WORKSPACES_HELP); return 0; }
  const args = argv.slice(['list', 'create', 'switch'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help'], value: ['--name'] });
  if (options.help) { write(ctx.io.stdout, WORKSPACES_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, '/v1/host/sample/me/workspaces');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.workspaces) ? res.body.workspaces : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No workspaces.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((w: any) => ({ id: w.id ?? w.workspaceId ?? '', name: w.name ?? '', active: w.active ? 'yes' : '' })), ['id', 'name', 'active']));
      return 0;
    }
    case 'create': {
      if (!options.name) { write(ctx.io.stderr, 'Usage: openwop workspaces create --name <n> [--json]\n'); return 2; }
      const res = await requestJson(ctx, '/v1/host/sample/workspaces', { method: 'POST', body: { name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created workspace ${res.body?.id ?? ''} (${String(options.name)}).`);
      return 0;
    }
    case 'switch': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop workspaces switch <workspaceId> [--json]\n'); return 2; }
      const res = await requestJson(ctx, `/v1/host/sample/workspaces/${encodeURIComponent(positionals[0])}/switch`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Switched to workspace ${positionals[0]}.`);
      return 0;
    }
    default: throw new CliError(`Unknown workspaces command: ${sub}\nRun \`openwop workspaces --help\` for usage.`);
  }
}

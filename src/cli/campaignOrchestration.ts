import type { Ctx } from '../context.js';
/** `openwop campaigns-orchestration ...` — campaign orchestration (feature: campaign-orchestration). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const BASE = '/v1/host/openwop-app/campaign-orchestration/campaigns';

/** Read-only campaign projections: the workspace (ADR 0356 P2), revision history, ad dispatch ledger. */
export const CAMPAIGNS_ORCH_ROUTES: RouteCmd[] = [
  { words: ['workspace'], method: 'GET', path: `${BASE}/:campaignId/workspace`, summary: 'The campaign + its brief + its linked production plan in one read.' },
  { words: ['versions'], method: 'GET', path: `${BASE}/:campaignId/versions`, summary: 'Revision history.',
    table: { key: 'versions', columns: ['version', 'versionId', 'snapshot.name', 'snapshot.status', 'actor', 'at'], empty: 'No versions.' } },
  { words: ['dispatches'], method: 'GET', path: `${BASE}/:campaignId/dispatches`, summary: 'Ad dispatch state per platform (ids + platform state only).' },
];

export const CAMPAIGNS_ORCH_HELP = `Usage:
  openwop campaigns-orchestration list [--json]
  openwop campaigns-orchestration get <campaignId> [--json]
  openwop campaigns-orchestration create --name <n> [--json]
  openwop campaigns-orchestration update <campaignId> [--name <n>] [--json]
  openwop campaigns-orchestration delete <campaignId> [--yes]
  openwop campaigns-orchestration finalize <campaignId> [--yes] [--json]

Campaign orchestration (host-extension). \`finalize\` locks a campaign for execution.
The host is the authority; the CLI mirrors + relays.

${routesHelp('campaigns-orchestration', CAMPAIGNS_ORCH_ROUTES)}
`;

export async function runCampaignsOrch(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CAMPAIGNS_ORCH_HELP); return 0; }
  const ext = await dispatchRoutes(ctx, 'campaigns-orchestration', CAMPAIGNS_ORCH_ROUTES, argv);
  if (ext !== undefined) return ext;
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete', 'finalize'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--name'] });
  if (options.help) { write(ctx.io.stdout, CAMPAIGNS_ORCH_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.campaigns) ? res.body.campaigns : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((c: any) => ({ id: c.id ?? '', name: c.name ?? '', status: c.status ?? '' })), ['id', 'name', 'status']) : 'No campaigns.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop campaigns-orchestration get <campaignId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.name) { write(ctx.io.stderr, 'campaigns-orchestration create needs --name.\n'); return 2; }
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created campaign ${res.body?.id ?? ''} (${String(options.name)}).`); return 0;
    }
    case 'update': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop campaigns-orchestration update <campaignId> [--name n]\n'); return 2; }
      const patch: Record<string, string> = {}; if (options.name) patch.name = String(options.name);
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated campaign ${id}.`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop campaigns-orchestration delete <campaignId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete campaign ${id} without --yes.`, 2);
      await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted campaign ${id}.`); return 0;
    }
    case 'finalize': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop campaigns-orchestration finalize <campaignId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to finalize campaign ${id} without --yes.`, 2);
      const res = await requestJson(ctx, `/v1/host/openwop-app/campaign-orchestration/finalize`, { method: 'POST', body: { campaignId: id } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Finalized campaign ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown campaigns-orchestration command: ${sub}`);
  }
}

import type { Ctx } from '../context.js';
/** `openwop agent-ops ...` — demo example-data + roster/fleet activity monitoring. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const H = '/v1/host/openwop-app';

/**
 * Declared agent-ops commands (routeKit), checked before the hand-written switch
 * (so `clear`, `roster-activity`, `fleet-activity` here supersede the originals
 * and gain the host's filters). Mirrors routes/agentOps.ts + exampleDataSummary.ts.
 */
export const AGENT_OPS_ROUTES: RouteCmd[] = [
  { words: ['clear'], method: 'POST', path: `${H}/example-data/clear`, confirm: true, summary: 'Remove demo entities (all steps, or only --step ...).',
    body: [{ flag: '--step', key: 'steps', type: 'list' }] },
  { words: ['provision-demo'], method: 'POST', path: `${H}/example-data/provision-demo`, confirm: true,
    summary: 'Turn on the demo feature toggles for this tenant, then seed (superadmin; 409 when demo seeding is disabled on the host).' },
  { words: ['summary'], method: 'GET', path: `${H}/example-data-summary`, summary: 'What the demo host serves: endpoints, node catalog, workflows, prompts + recommendations.' },
  { words: ['roster-activity'], method: 'GET', path: `${H}/roster/:rosterId/activity`, summary: 'Recent runs a roster entry initiated.',
    query: [{ flag: '--limit', key: 'limit', type: 'number' }, { flag: '--status', key: 'status' }],
    table: { key: 'items', columns: ['runId', 'workflowId', 'status', 'source', 'timestamp'], empty: 'No activity.' } },
  { words: ['fleet-activity'], method: 'GET', path: `${H}/fleet/activity`, summary: 'Recent runs across every standing agent.',
    query: [{ flag: '--limit', key: 'limit', type: 'number' }, { flag: '--status', key: 'status' }, { flag: '--roster-id', key: 'rosterId' }],
    table: { key: 'items', columns: ['runId', 'rosterId', 'persona', 'workflowId', 'status', 'timestamp'], empty: 'No activity.' } },
];

export const AGENT_OPS_HELP = `Usage:
  openwop agent-ops seed [--heal] [--json]
  openwop agent-ops status [--json]
  openwop agent-ops run [--step <id>]... [--dry-run] [--json]
  openwop agent-ops roster-check <rosterId> [--json]
${routesHelp('agent-ops', AGENT_OPS_ROUTES)}

Demo/operations helpers: seed/run/clear the example dataset + read roster & fleet
activity. \`seed --heal\` repairs a partial seed; \`run --dry-run\` previews without writing.`;

export async function runAgentOps(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'status';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_OPS_HELP); return 0; }
  const declared = await dispatchRoutes(ctx, 'agent-ops', AGENT_OPS_ROUTES, argv);
  if (declared !== undefined) return declared;
  const args = argv.slice(['seed', 'status', 'run', 'roster-check'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--heal', '--dry-run'], multi: ['--step'] });
  if (options.help) { write(ctx.io.stdout, AGENT_OPS_HELP); return 0; }
  const rid = positionals[0];
  switch (sub) {
    case 'seed': {
      const res = await requestJson(ctx, `${H}/example-data/seed`, { method: 'POST', body: options.heal ? { heal: true } : {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, 'Seeded example data.'); return 0;
    }
    case 'status': writeJson(ctx.io.stdout, (await requestJson(ctx, `${H}/example-data/status`)).body); return 0;
    case 'run': {
      const body: Record<string, unknown> = {};
      if (Array.isArray(options.step) && options.step.length) body.steps = options.step;
      if (options.dryRun) body.dryRun = true;
      const res = await requestJson(ctx, `${H}/example-data/run`, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, options.dryRun ? 'Dry-run complete.' : 'Ran example-data steps.'); return 0;
    }
    case 'roster-check': {
      if (!rid) { write(ctx.io.stderr, 'Usage: openwop agent-ops roster-check <rosterId>\n'); return 2; }
      const res = await requestJson(ctx, `${H}/roster/${encodeURIComponent(rid)}/check`, { method: 'POST', body: {} });
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    default: throw new CliError(`Unknown agent-ops command: ${sub}`);
  }
}

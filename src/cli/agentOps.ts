import type { Ctx } from '../context.js';
/** `openwop agent-ops ...` — demo example-data + roster/fleet activity monitoring. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const H = '/v1/host/sample';

export const AGENT_OPS_HELP = `Usage:
  openwop agent-ops seed [--heal] [--json]
  openwop agent-ops status [--json]
  openwop agent-ops run [--step <id>]... [--dry-run] [--json]
  openwop agent-ops clear [--yes]
  openwop agent-ops roster-check <rosterId> [--json]
  openwop agent-ops roster-activity <rosterId> [--json]
  openwop agent-ops fleet-activity [--json]

Demo/operations helpers: seed/run/clear the example dataset + read roster & fleet
activity. \`seed --heal\` repairs a partial seed; \`run --dry-run\` previews without writing.`;

export async function runAgentOps(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'status';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_OPS_HELP); return 0; }
  const args = argv.slice(['seed', 'status', 'run', 'clear', 'roster-check', 'roster-activity', 'fleet-activity'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--heal', '--dry-run', '--yes'], multi: ['--step'] });
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
    case 'clear': {
      if (!options.yes) throw new CliError('Refusing to clear example data without --yes.', 2);
      await requestJson(ctx, `${H}/example-data/clear`, { method: 'POST', body: {} });
      writeLine(ctx.io.stdout, 'Cleared example data.'); return 0;
    }
    case 'roster-check': {
      if (!rid) { write(ctx.io.stderr, 'Usage: openwop agent-ops roster-check <rosterId>\n'); return 2; }
      const res = await requestJson(ctx, `${H}/roster/${encodeURIComponent(rid)}/check`, { method: 'POST', body: {} });
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'roster-activity': {
      if (!rid) { write(ctx.io.stderr, 'Usage: openwop agent-ops roster-activity <rosterId>\n'); return 2; }
      writeJson(ctx.io.stdout, (await requestJson(ctx, `${H}/roster/${encodeURIComponent(rid)}/activity`)).body); return 0;
    }
    case 'fleet-activity': writeJson(ctx.io.stdout, (await requestJson(ctx, `${H}/fleet/activity`)).body); return 0;
    default: throw new CliError(`Unknown agent-ops command: ${sub}`);
  }
}

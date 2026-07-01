import type { Ctx } from '../context.js';
/** `openwop evals ...` — model eval leaderboard + arena (feature: evals). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const base = (org: string) => `/v1/host/sample/evals/orgs/${encodeURIComponent(org)}`;

export const EVALS_HELP = `Usage:
  openwop evals leaderboard --org <orgId> [--json]
  openwop evals rating --org <orgId> [--json]
  openwop evals match --org <orgId> --model-a <a> --model-b <b> --winner <a|b|tie> [--json]

Model evals (host-extension, org-scoped). \`leaderboard\`/\`rating\` read the standings;
\`match\` records an arena head-to-head outcome. Every command needs --org.`;

function requireOrg(org: unknown): string {
  if (!org) throw new CliError('This command is org-scoped — pass --org <orgId>.', 2);
  return String(org);
}

export async function runEvals(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'leaderboard';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, EVALS_HELP); return 0; }
  const args = argv.slice(['leaderboard', 'rating', 'match'].includes(sub) ? 1 : 0);
  const { options } = parseOptions(args, { bool: ['--help'], value: ['--org', '--model-a', '--model-b', '--winner'] });
  if (options.help) { write(ctx.io.stdout, EVALS_HELP); return 0; }
  const org = requireOrg(options.org);
  switch (sub) {
    case 'leaderboard': writeJson(ctx.io.stdout, (await requestJson(ctx, `${base(org)}/leaderboard`)).body); return 0;
    case 'rating': writeJson(ctx.io.stdout, (await requestJson(ctx, `${base(org)}/arena/rating`)).body); return 0;
    case 'match': {
      if (!options.modelA || !options.modelB || !options.winner) { write(ctx.io.stderr, 'evals match needs --model-a, --model-b, --winner.\n'); return 2; }
      const res = await requestJson(ctx, `${base(org)}/arena/match`, { method: 'POST', body: { modelA: String(options.modelA), modelB: String(options.modelB), winner: String(options.winner) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Recorded match (${String(options.modelA)} vs ${String(options.modelB)} → ${String(options.winner)}).`);
      return 0;
    }
    default: throw new CliError(`Unknown evals command: ${sub}`);
  }
}

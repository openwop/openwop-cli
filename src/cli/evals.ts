import type { Ctx } from '../context.js';
/** `openwop evals ...` — model eval leaderboard + arena (feature: evals). */
import { CliError, HttpError, errorEnvelope } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const base = (org: string) => `/v1/host/openwop-app/evals/orgs/${encodeURIComponent(org)}`;

export const EVALS_HELP = `Usage:
  openwop evals leaderboard --org <orgId> [--json]
  openwop evals rating --org <orgId> --model <model|provider/model> [--json]
  openwop evals match --org <orgId> --run-a <runId> --run-b <runId> --winner <a|b|tie> [--json]

Model evals (host-extension, org-scoped). \`leaderboard\` reads the standings; \`rating\`
reads one model's arena rating from the same fit (1500 is the reference). A model id
served by more than one provider must be passed as its \`provider/model\` key. Both
reads need an admin role.
\`match\` records an arena verdict on two of YOUR OWN conversation runs that answered
the same prompt (openwop-app ADR 0986). The host reads which model answered each run
from its own records, so you name runs, not models. Every command needs --org.`;

/** ADR 0986: the arena no longer takes model names; say so before sending anything. */
const MODEL_FLAGS_REMOVED = 'evals match no longer takes --model-a/--model-b (openwop-app ADR 0986): pass --run-a <runId> --run-b <runId>, two of your own conversation runs that answered the same prompt.';

export async function runEvals(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'leaderboard';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, EVALS_HELP); return 0; }
  const args = argv.slice(['leaderboard', 'rating', 'match'].includes(sub) ? 1 : 0);
  const { options } = parseOptions(args, { bool: ['--help'], value: ['--org', '--model', '--run-a', '--run-b', '--winner', '--model-a', '--model-b'] });
  if (options.help) { write(ctx.io.stdout, EVALS_HELP); return 0; }
  const org = requireOrg(options.org);
  switch (sub) {
    case 'leaderboard': writeJson(ctx.io.stdout, (await requestJson(ctx, `${base(org)}/leaderboard`)).body); return 0;
    case 'rating': return rating(ctx, org, options);
    case 'match': return match(ctx, org, options);
    default: throw new CliError(`Unknown evals command: ${sub}`);
  }
}

async function rating(ctx: Ctx, org: string, options: Record<string, unknown>) {
  if (!options.model) throw new CliError('evals rating needs --model <model|provider/model>.', 2);
  const model = String(options.model);
  let res;
  try {
    res = await requestJson(ctx, `${base(org)}/arena/rating?model=${encodeURIComponent(model)}`);
  } catch (err) {
    // A bare model id served by several providers: list the keys to pick from.
    const keys = err instanceof HttpError && err.status === 400 ? errorEnvelope(err.body).details?.keys : undefined;
    if (Array.isArray(keys)) throw new CliError(`"${model}" is served by more than one provider; pass one of: ${keys.join(', ')}`, 1);
    throw err;
  }
  const body = (res.body ?? {}) as { model?: string; elo?: number };
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  writeLine(ctx.io.stdout, `${body.model ?? model}: ${typeof body.elo === 'number' ? Math.round(body.elo) : '?'}`);
  return 0;
}

async function match(ctx: Ctx, org: string, options: Record<string, unknown>) {
  if (options.modelA !== undefined || options.modelB !== undefined) throw new CliError(MODEL_FLAGS_REMOVED, 2);
  if (!options.runA || !options.runB || !options.winner) throw new CliError('evals match needs --run-a, --run-b, --winner.', 2);
  const w = String(options.winner).toLowerCase();
  if (w !== 'a' && w !== 'b' && w !== 'tie') throw new CliError('--winner must be a, b or tie.', 2);
  const winner = w === 'tie' ? 'tie' : w.toUpperCase();
  let res;
  try {
    res = await requestJson(ctx, `${base(org)}/arena/match`, { method: 'POST', body: { runIdA: String(options.runA), runIdB: String(options.runB), winner } });
  } catch (err) {
    // The host's typed refusal of a model-name body (ADR 0986): name the new flags.
    if (err instanceof HttpError && err.status === 400 && errorEnvelope(err.body).details?.reason === 'arena_contract_changed') {
      throw new CliError(MODEL_FLAGS_REMOVED, 1);
    }
    throw err;
  }
  const body = (res.body ?? {}) as { match?: { modelA?: string; modelB?: string; winner?: string }; ratingA?: number; ratingB?: number; replayed?: boolean };
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  const m = body.match ?? {};
  const ratings = typeof body.ratingA === 'number' && typeof body.ratingB === 'number' ? ` Ratings: ${Math.round(body.ratingA)} / ${Math.round(body.ratingB)}.` : '';
  writeLine(ctx.io.stdout, `${body.replayed ? 'Already recorded' : 'Recorded'} match (${m.modelA ?? String(options.runA)} vs ${m.modelB ?? String(options.runB)} → ${m.winner ?? winner}).${ratings}`);
  return 0;
}

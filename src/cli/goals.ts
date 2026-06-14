import type { Ctx } from '../context.js';
/** `openwop goals ...` — standing goals with judge-based completion (RFC 0097).
 *
 * A standing goal is an objective the host pursues across runs until a JUDGE
 * (RFC 0090) verdicts it satisfied or a BOUND (RFC 0058) stops it. This group
 * drives the host's goal surface (sample host-extension, non-normative;
 * promotable to the normative /v1/goals path at graduation):
 *   GET    /v1/host/sample/goals[?state=]                  — the goal list
 *   GET    /v1/host/sample/goals/{id}                      — one goal
 *   POST   /v1/host/sample/goals                           — create (422 if requiresBounds + no bounds)
 *   POST   /v1/host/sample/goals/{id}/{pause,resume,abandon}
 *
 * Completion is the host JUDGE's verdict — there is deliberately NO `complete`
 * or `satisfy` verb, and the CLI never sets `state: satisfied` (the host rejects
 * a client-supplied satisfied on PATCH; we simply never offer it). The CLI
 * renders the host's resolved view and relays pause/resume/abandon. Gated on
 * `capabilities.agents.goals` (advertised in /.well-known/openwop); fails closed
 * when absent.
 *
 * Boundary vs RFC 0068 commitments: a goal *uses* a commitment/schedule/heartbeat
 * as a continuation arm — it is not itself an arm. A goal has a judge loop and a
 * termination guarantee (bounds); a commitment does not.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const GOALS_HELP = `Usage:
  openwop goals list [--state <s>] [--json]
  openwop goals get <goalId> [--json]
  openwop goals create --objective <text> [--judge host|verifier] [--continuation <arm>]...
                       [--max-iterations <n>] [--max-cost <n>] [--deadline <iso>] [--json]
  openwop goals pause <goalId> [--json]
  openwop goals resume <goalId> [--json]
  openwop goals abandon <goalId> [--yes]

Standing goals (RFC 0097). A goal is an objective the host pursues across runs
until a JUDGE (RFC 0090) verdicts it satisfied or a BOUND (RFC 0058) stops it.
'list'/'get' render the host's goals. 'create' opens a goal with its judge,
continuation arm(s), and bounds. 'pause'/'resume' suspend/restart continuation;
'abandon' closes the goal.

Completion is the host judge's verdict — there is no \`complete\`/\`satisfy\` verb
and the CLI never sets satisfied; you cannot declare victory from the client. The
host is the authority; the CLI renders its resolved view and relays your verb. If
the host does not advertise the goal surface (/.well-known/openwop), the group
fails closed rather than guessing.

Endpoints:
  list     GET    /v1/host/sample/goals[?state=]
  get      GET    /v1/host/sample/goals/{id}
  create   POST   /v1/host/sample/goals          (422 if the host requires bounds and none given)
  pause    POST   /v1/host/sample/goals/{id}/pause
  resume   POST   /v1/host/sample/goals/{id}/resume
  abandon  POST   /v1/host/sample/goals/{id}/abandon

  --state <s>            (list) Filter by state (e.g. active, satisfied, escalated, bound-exceeded, paused).
  --objective <text>     (create) The goal objective (required).
  --judge host|verifier  (create) Who decides completion (default: host).
  --continuation <arm>   (create) A continuation arm: schedule | heartbeat | commitment (repeatable).
  --max-iterations <n>   (create) Bound: max continuation iterations.
  --max-cost <n>         (create) Bound: max accumulated cost.
  --deadline <iso>       (create) Bound: wall-clock deadline (ISO 8601).
  --yes                  (abandon) Required to confirm.
  --json                 Print the raw host response instead of the rendered view.

Boundary: a goal is NOT an RFC 0068 commitment — a goal *uses* a
commitment/schedule/heartbeat as a continuation arm and adds a judge loop + a
termination guarantee (bounds).

Exit codes (get/create/pause/resume reflect the goal's state, so scripts can gate
on the verdict):
  0  satisfied      3  escalated or still open (active/paused)      1  bound-exceeded/abandoned or error
\`list\` exits 0 on success.

Examples:
  openwop goals list --state active
  openwop goals get goal_123 --json
  openwop goals create --objective "Keep the triage backlog under 20" --judge verifier --continuation schedule --max-iterations 50 --max-cost 5.00
  openwop goals pause goal_123
  openwop goals abandon goal_123 --yes
`;

const SUBCOMMANDS = ['list', 'get', 'create', 'pause', 'resume', 'abandon'];

export async function runGoals(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, GOALS_HELP);
    return 0;
  }
  const args = argv.slice(SUBCOMMANDS.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list':
      return await runGoalsList(ctx, args);
    case 'get':
      return await runGoalsGet(ctx, args);
    case 'create':
      return await runGoalsCreate(ctx, args);
    case 'pause':
      return await runGoalsTransition(ctx, args, 'pause');
    case 'resume':
      return await runGoalsTransition(ctx, args, 'resume');
    case 'abandon':
      return await runGoalsAbandon(ctx, args);
    default:
      throw new CliError(`Unknown goals command: ${sub}\nRun \`openwop goals --help\` for usage.`);
  }
}

/** 0 satisfied · 3 escalated or still open (active/paused) · 1 bound-exceeded /
 *  abandoned / unknown. Completion is the host judge's verdict; the CLI mirrors
 *  the goal's state. `0` is reserved for a genuine judge-satisfied so a script
 *  can gate on real success and never see it for a still-running goal. */
function exitForState(state: unknown): number {
  if (state === 'satisfied') return 0;
  if (state === 'escalated' || state === 'active' || state === 'paused' || state === 'running' || state === 'pending') return 3;
  return 1; // bound-exceeded / abandoned / anything unexpected
}

async function ensureAdvertised(ctx: Ctx): Promise<void> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return; // can't prove absence — let the real request decide
  const body = wk.body && typeof wk.body === 'object' ? (wk.body as any) : {};
  const advertised = !!(body.capabilities?.agents?.goals ?? body.agents?.goals);
  if (!advertised) {
    throw new CliError(
      'goals: this host does not advertise the standing-goals capability (capabilities.agents.goals is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
      1,
    );
  }
}

function gate404(err: unknown): never {
  if (err instanceof HttpError && err.status === 404) {
    const detail =
      err.body && typeof err.body === 'object' && typeof (err.body as { message?: string }).message === 'string'
        ? (err.body as { message?: string }).message
        : 'not found';
    throw new CliError(
      `goals: ${detail} (the host must mount /v1/host/sample/goals; the CLI renders the host's view, it never decides).`,
      1,
    );
  }
  throw err;
}

async function runGoalsList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--state'] });
  if (options.help) {
    write(ctx.io.stdout, GOALS_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  const path = options.state !== undefined ? `/v1/host/sample/goals?state=${encodeURIComponent(options.state)}` : '/v1/host/sample/goals';
  let res;
  try {
    res = await requestJson(ctx, path);
  } catch (err) {
    gate404(err);
  }
  const goals = Array.isArray(res!.body?.goals) ? res!.body.goals : [];
  if (ctx.json) {
    writeJson(ctx.io.stdout, { goals });
    return 0;
  }
  if (goals.length === 0) {
    writeLine(ctx.io.stdout, `No goals${options.state ? ` in state ${options.state}` : ''} on this host.`);
    return 0;
  }
  const rows = goals.map((g: any) => ({
    goalId: g.goalId ?? g.id,
    state: g.state ?? '',
    judge: g.judge ?? '',
    objective: truncate(g.objective ?? '', 40),
    iterations: progressIterations(g),
    createdAt: g.createdAt ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['goalId', 'state', 'judge', 'objective', 'iterations', 'createdAt']));
  return 0;
}

function progressIterations(g: any): string {
  const it = g.progress?.iterations ?? g.iterations;
  const max = g.bounds?.maxIterations;
  if (it === undefined) return '';
  return max !== undefined ? `${it}/${max}` : String(it);
}

async function runGoalsGet(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop goals get <goalId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/goals/${encodeURIComponent(positionals[0])}`);
  } catch (err) {
    gate404(err);
  }
  const g = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, g);
    return exitForState(g.state);
  }
  renderGoal(ctx, g, positionals[0]);
  return exitForState(g.state);
}

function renderGoal(ctx: Ctx, g: any, fallbackId: string): void {
  writeLine(ctx.io.stdout, `goalId: ${g.goalId ?? g.id ?? fallbackId}`);
  writeLine(ctx.io.stdout, `state: ${g.state ?? ''}`);
  if (g.objective) writeLine(ctx.io.stdout, `objective: ${g.objective}`);
  writeLine(ctx.io.stdout, `judge: ${g.judge ?? ''}`);
  if (Array.isArray(g.continuation)) writeLine(ctx.io.stdout, `continuation: ${g.continuation.length ? g.continuation.join(', ') : '(none)'}`);
  if (g.bounds) {
    const b = g.bounds;
    const parts = [
      b.maxIterations !== undefined ? `maxIterations=${b.maxIterations}` : null,
      b.maxCost !== undefined ? `maxCost=${b.maxCost}` : null,
      b.deadline !== undefined ? `deadline=${b.deadline}` : null,
    ].filter(Boolean);
    writeLine(ctx.io.stdout, `bounds: ${parts.length ? parts.join(', ') : '(none)'}`);
  }
  const it = progressIterations(g);
  if (it) writeLine(ctx.io.stdout, `iterations: ${it}`);
  if (typeof g.confidence === 'number') writeLine(ctx.io.stdout, `confidence: ${g.confidence}`);
  if (Array.isArray(g.progress?.contributingRunIds)) writeLine(ctx.io.stdout, `contributingRuns: ${g.progress.contributingRunIds.length}`);
  if (g.finalState) writeLine(ctx.io.stdout, `finalState: ${g.finalState}`);
  writeLine(ctx.io.stdout, `createdAt: ${g.createdAt ?? ''}`);
  if (g.closedAt) writeLine(ctx.io.stdout, `closedAt: ${g.closedAt}`);
}

// POST — create a goal. The host rejects (422) a bounds-less goal when it
// advertises requiresBounds; we surface that legibly so the operator adds bounds.
async function runGoalsCreate(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--objective', '--judge', '--max-iterations', '--max-cost', '--deadline'],
    multi: ['--continuation'],
  });
  if (options.help || !options.objective) {
    write(ctx.io.stdout, 'Usage: openwop goals create --objective <text> [--judge host|verifier] [--continuation <arm>]... [--max-iterations <n>] [--max-cost <n>] [--deadline <iso>] [--json]\n');
    return options.help ? 0 : 2;
  }
  if (options.judge !== undefined && !['host', 'verifier'].includes(options.judge)) {
    throw new CliError('--judge must be one of: host, verifier', 2);
  }
  const body: Record<string, any> = { objective: options.objective };
  if (options.judge !== undefined) body.judge = options.judge;
  if (Array.isArray(options.continuation) && options.continuation.length) body.continuation = options.continuation;
  const bounds: Record<string, any> = {};
  if (options.maxIterations !== undefined) {
    const n = Number(options.maxIterations);
    if (!Number.isInteger(n) || n <= 0) throw new CliError('--max-iterations must be a positive integer', 2);
    bounds.maxIterations = n;
  }
  if (options.maxCost !== undefined) {
    const c = Number(options.maxCost);
    if (!Number.isFinite(c) || c < 0) throw new CliError('--max-cost must be a non-negative number', 2);
    bounds.maxCost = c;
  }
  if (options.deadline !== undefined) bounds.deadline = options.deadline;
  if (Object.keys(bounds).length) body.bounds = bounds;
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, '/v1/host/sample/goals', { method: 'POST', body });
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      const detail = (err.body as { message?: string } | undefined)?.message
        ?? 'this host requires bounds on an active goal — pass --max-iterations, --max-cost, and/or --deadline';
      throw new CliError(`goals: ${detail}`, 1);
    }
    gate404(err);
  }
  const g = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, g);
    return exitForState(g.state);
  }
  writeLine(ctx.io.stdout, `✓ Created goal ${g.goalId ?? g.id ?? ''} (state ${g.state ?? 'active'}, judge ${g.judge ?? options.judge ?? 'host'}).`);
  return exitForState(g.state);
}

async function runGoalsTransition(ctx: Ctx, argv: string[], verb: 'pause' | 'resume'): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop goals ${verb} <goalId> [--json]\n`);
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/goals/${encodeURIComponent(positionals[0])}/${verb}`, { method: 'POST' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      const status = (err.body as { state?: string } | undefined)?.state;
      throw new CliError(`goals: cannot ${verb} ${positionals[0]} — the host reports it is ${status ?? 'in a conflicting state'}.`, 1);
    }
    gate404(err);
  }
  const g = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, g);
    return exitForState(g.state);
  }
  writeLine(ctx.io.stdout, `✓ ${verb === 'pause' ? 'Paused' : 'Resumed'} goal ${g.goalId ?? g.id ?? positionals[0]} → ${g.state ?? (verb === 'pause' ? 'paused' : 'active')}.`);
  return exitForState(g.state);
}

async function runGoalsAbandon(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop goals abandon <goalId> [--yes]\n');
    return options.help ? 0 : 2;
  }
  if (!options.yes) {
    writeLine(ctx.io.stderr, `Refusing to abandon goal ${positionals[0]} without --yes.`);
    return 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/goals/${encodeURIComponent(positionals[0])}/abandon`, { method: 'POST' });
  } catch (err) {
    gate404(err);
  }
  const g = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, g);
    return exitForState(g.state ?? 'abandoned');
  }
  writeLine(ctx.io.stdout, `✓ Abandoned goal ${g.goalId ?? g.id ?? positionals[0]} → ${g.state ?? 'abandoned'}.`);
  return exitForState(g.state ?? 'abandoned');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

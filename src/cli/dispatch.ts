import type { Ctx } from '../context.js';
/**
 * `openwop dispatch fanout` — the RFC 0118 parallel fan-out witness seam
 * (host-extension path; the join semantics it exercises are normative).
 *
 *   POST /v1/host/openwop-app/dispatch/fanout   { nextWorkerIds[≥2], config }
 *
 * The host runs its REAL bounded-concurrency coordinator + join fold over a
 * deterministic child dispatcher (each worker id → a completed child), and
 * returns the join outcome, the children, and the merge order. Use it to see
 * how a host folds a fan-out under a given join policy. The host advertises it
 * with `dispatch.fanOutSupported` + "parallel" in `fanOutPolicies`.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { failClosedOn404 } from './requestHelpers.js';
import { readBodyOption } from './contentHelpers.js';

export const DISPATCH_HELP = `Usage:
  openwop dispatch fanout --worker <id> --worker <id> [...] [--join wait-all|quorum|first|race] [--quorum n] [--on-child-failure collect|fail-fast|absorb] [--max-concurrency n] [--json]
  openwop dispatch fanout (--body '{"nextWorkerIds":[...],"config":{...}}' | --body-file <f>) [--json]

Parallel fan-out (RFC 0118). POST /v1/host/openwop-app/dispatch/fanout with
{ nextWorkerIds, config: { fanOutPolicy: "parallel", maxConcurrency?, joinPolicy? } }.
The host runs its real coordinator and join fold over deterministic children
and reports joinOutcome, children[], mergeOrder and the completed/failed/
cancelled counts. At least two --worker ids are required.

Exit codes: 0 join satisfied · 1 join not satisfied / surface absent · 2 usage.

Examples:
  openwop dispatch fanout --worker a --worker b --worker c
  openwop dispatch fanout --worker a --worker b --join quorum --quorum 1 --json
`;

export async function runDispatch(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, DISPATCH_HELP); return sub ? 0 : 2; }
  if (sub !== 'fanout') throw new CliError(`Unknown dispatch command: ${sub}\nRun \`openwop dispatch --help\` for usage.`);
  const { options } = parseOptions(argv.slice(1), {
    bool: ['--help'],
    value: ['--join', '--quorum', '--on-child-failure', '--max-concurrency', '--body', '--body-file'],
    multi: ['--worker'],
  });
  if (options.help) { write(ctx.io.stdout, DISPATCH_HELP); return 0; }
  let body = readBodyOption(ctx, options);
  if (body === undefined) {
    const workers: string[] = options.worker ?? [];
    if (workers.length < 2) throw new CliError('fanout needs at least two --worker <id>.', 2);
    const joinPolicy: Record<string, unknown> = {};
    if (options.join) {
      if (!['wait-all', 'quorum', 'first', 'race'].includes(options.join)) throw new CliError('--join must be wait-all, quorum, first or race.', 2);
      joinPolicy.mode = options.join;
    }
    if (options.quorum !== undefined) joinPolicy.quorum = positiveInt(options.quorum, '--quorum');
    if (options.onChildFailure) {
      if (!['collect', 'fail-fast', 'absorb'].includes(options.onChildFailure)) throw new CliError('--on-child-failure must be collect, fail-fast or absorb.', 2);
      joinPolicy.onChildFailure = options.onChildFailure;
    }
    const config: Record<string, unknown> = { fanOutPolicy: 'parallel' };
    if (options.maxConcurrency !== undefined) config.maxConcurrency = positiveInt(options.maxConcurrency, '--max-concurrency');
    if (Object.keys(joinPolicy).length) config.joinPolicy = joinPolicy;
    body = { nextWorkerIds: workers, config };
  }
  let res;
  try {
    res = await requestJson(ctx, '/v1/host/openwop-app/dispatch/fanout', { method: 'POST', body });
  } catch (err) {
    failClosedOn404(err, 'dispatch fanout');
  }
  const r = res.body ?? {};
  const ok = r.joinOutcome === 'satisfied';
  if (ctx.json) { writeJson(ctx.io.stdout, r); return ok ? 0 : 1; }
  writeLine(ctx.io.stdout, `joinOutcome: ${r.joinOutcome ?? ''}`);
  writeLine(ctx.io.stdout, `completed: ${r.completedCount ?? 0} · failed: ${r.failedCount ?? 0} · cancelled: ${r.cancelledCount ?? 0}`);
  if (Array.isArray(r.mergeOrder)) writeLine(ctx.io.stdout, `mergeOrder: ${r.mergeOrder.join(', ')}`);
  const children = Array.isArray(r.children) ? r.children : [];
  if (children.length) {
    writeLine(ctx.io.stdout, formatTable(children.map((c: any) => ({ childRunId: c.childRunId ?? '', status: c.status ?? '' })), ['childRunId', 'status']));
  }
  return ok ? 0 : 1;
}

function positiveInt(v: unknown, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`${flag} must be a positive integer.`, 2);
  return n;
}

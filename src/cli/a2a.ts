import type { Ctx } from '../context.js';
/** `openwop a2a ...` — async / durable A2A tasks (RFC 0100).
 *
 * When a host advertises `capabilities.a2a.durableTasks`, it persists an
 * `A2ATaskState` per backing run (taskId === runId) for the run's whole
 * lifecycle, readable after the caller disconnects. This group reads that durable
 * projection via the host seam:
 *   GET /v1/host/sample/a2a/tasks/{taskId}  — the durable A2ATaskState
 *
 * The record is content-free by design (RFC 0100): it carries the projected
 * state, the interrupt kind (iff input-required), and an optional push config —
 * never run inputs/outputs/artifacts/credentials. The CLI renders the host's
 * resolved state; it never computes a task state locally. Gated on
 * `capabilities.a2a` (+ `durableTasks` for the durable read); fails closed.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const A2A_HELP = `Usage:
  openwop a2a status [--json]
  openwop a2a task <taskId> [--json]

Async / durable A2A tasks (RFC 0100). When a host advertises
\`capabilities.a2a.durableTasks\`, every backing run has a durable A2ATaskState
(taskId === runId) that survives caller disconnect, host restart, and HITL pauses.
'status' shows what the host advertises; 'task' reads one durable task's live
state.

The host is the authority — the A2ATaskState is the persisted projection of the
run's status; the CLI renders it and never derives a task state locally. The
record is content-free (no run inputs/outputs/artifacts/credentials). Gated on
\`capabilities.a2a\`; the durable read needs \`durableTasks: true\`. Fails closed
when the host doesn't advertise A2A.

Endpoints:
  status   reads /.well-known/openwop → capabilities.a2a
  task     GET /v1/host/sample/a2a/tasks/{taskId}

  --json   Print the raw host response instead of the rendered view.

Exit codes (task reflects the A2A task state, so scripts can gate):
  0  completed
  3  in progress / needs input (submitted | working | input-required | auth-required)
  1  failed | canceled | rejected, or error
\`status\` exits 0 when A2A is advertised, 1 when it is not.

Examples:
  openwop a2a status
  openwop a2a task run_abc123 --json
`;

const SUBCOMMANDS = ['status', 'task'];

export async function runA2a(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'status';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, A2A_HELP);
    return 0;
  }
  const args = argv.slice(SUBCOMMANDS.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'status':
      return await runStatus(ctx, args);
    case 'task':
      return await runTask(ctx, args);
    default:
      throw new CliError(`Unknown a2a command: ${sub}\nRun \`openwop a2a --help\` for usage.`);
  }
}

/** 0 completed · 3 in-progress/needs-input · 1 failed/canceled/rejected/unknown. */
function exitForState(state: unknown): number {
  if (state === 'completed') return 0;
  if (state === 'submitted' || state === 'working' || state === 'input-required' || state === 'auth-required') return 3;
  return 1; // failed | canceled | rejected | anything unexpected
}

async function a2aCaps(ctx: Ctx): Promise<any | undefined> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return undefined; // inconclusive — defer to the live call
  const body = wk.body && typeof wk.body === 'object' ? (wk.body as any) : {};
  return body.capabilities?.a2a ?? body.a2a ?? null;
}

async function runStatus(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, A2A_HELP);
    return 0;
  }
  const a2a = await a2aCaps(ctx);
  if (ctx.json) {
    writeJson(ctx.io.stdout, { a2a: a2a ?? null });
    return a2a ? 0 : 1;
  }
  if (!a2a) {
    writeLine(ctx.io.stdout, 'This host does not advertise A2A (capabilities.a2a absent).');
    return 1;
  }
  writeLine(ctx.io.stdout, `a2a.supported: ${a2a.supported ? 'yes' : 'no'}`);
  if (a2a.agentCardUrl) writeLine(ctx.io.stdout, `agentCardUrl: ${a2a.agentCardUrl}`);
  writeLine(ctx.io.stdout, `streaming: ${a2a.streaming ? 'yes' : 'no'}`);
  writeLine(ctx.io.stdout, `pushNotifications: ${a2a.pushNotifications ? 'yes' : 'no'}`);
  writeLine(ctx.io.stdout, `durableTasks: ${a2a.durableTasks ? 'yes' : 'no'}`);
  if (!a2a.durableTasks) writeLine(ctx.io.stdout, '(durable task reads require durableTasks: true)');
  return 0;
}

async function runTask(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop a2a task <taskId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const a2a = await a2aCaps(ctx);
  if (a2a === null) {
    throw new CliError('a2a: this host does not advertise A2A (capabilities.a2a absent from /.well-known/openwop). The host is the authority — refusing to guess.', 1);
  }
  if (a2a && a2a.durableTasks === false) {
    throw new CliError('a2a: this host advertises A2A but not durable tasks (capabilities.a2a.durableTasks is false) — there is no durable task to read.', 1);
  }
  const id = positionals[0];
  let t: any;
  try {
    const res = await requestJson(ctx, `/v1/host/sample/a2a/tasks/${encodeURIComponent(id)}`);
    t = res.body ?? {};
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(`a2a: no durable task ${id} (the host must serve /v1/host/sample/a2a/tasks/{taskId}; taskId equals the backing runId).`, 1);
    }
    throw err;
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, t);
    return exitForState(t.state);
  }
  writeLine(ctx.io.stdout, `taskId: ${t.taskId ?? id}`);
  writeLine(ctx.io.stdout, `runId: ${t.runId ?? ''}`);
  writeLine(ctx.io.stdout, `state: ${t.state ?? ''}`);
  if (t.interruptKind) writeLine(ctx.io.stdout, `interruptKind: ${t.interruptKind}`);
  if (t.contextId) writeLine(ctx.io.stdout, `contextId: ${t.contextId}`);
  if (t.pushConfig) writeLine(ctx.io.stdout, `pushConfig: ${JSON.stringify(t.pushConfig)}`);
  writeLine(ctx.io.stdout, `updatedAt: ${t.updatedAt ?? ''}`);
  return exitForState(t.state);
}

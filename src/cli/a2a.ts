import type { Ctx } from '../context.js';
/** `openwop a2a ...` — async / durable A2A tasks (RFC 0100).
 *
 * When a host advertises `capabilities.a2a.durableTasks`, it persists an
 * `A2ATaskState` per backing run (taskId === runId) for the run's whole
 * lifecycle, readable after the caller disconnects. This group reads that durable
 * projection via the host seam:
 *   GET /v1/host/openwop-app/a2a/tasks/{taskId}  — the durable A2ATaskState
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
import { randomUUID } from 'node:crypto';

export const A2A_HELP = `Usage:
  openwop a2a status [--json]
  openwop a2a task <taskId> [--json]
  openwop a2a rpc <method> [--params <json>] [--id <id>] [--a2a-version <v>] [--json]
  openwop a2a start [--scenario paused-at-approval] [--json]
  openwop a2a push-config <taskId> --url <https-url> [--token-fingerprint <fp>] [--json]
  openwop a2a invoke --peer-url <url> [--authenticated] [--peer-offers-only <v>]
                     [--request-version <v>] [--scenario <s>] [--json]

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
  status       reads /.well-known/openwop → capabilities.a2a
  task         GET /v1/host/openwop-app/a2a/tasks/{taskId}
  rpc          POST /v1/host/openwop-app/a2a — one A2A JSON-RPC 2.0 call against the
               host's own A2A server (e.g. agent/getCard, message/send). --a2a-version
               sets the A2A-Version header (absent = a 0.3-era peer); a JSON-RPC error
               in the reply exits 1. Only when the operator enabled the A2A server.
  start        POST /v1/host/openwop-app/a2a/tasks/start — start the sample durable task
               (a run paused at an approval); prints its taskId.
  push-config  POST /v1/host/openwop-app/a2a/tasks/push-config { taskId, url, tokenFingerprint? }
               — register a push-notification target (the host refuses private/unsafe URLs).
  invoke       POST /v1/host/openwop-app/a2a/invoke — have the HOST call a peer A2A agent
               and report the negotiated protocol version (a test seam: only on servers
               with test seams enabled).

  --json   Print the raw host response instead of the rendered view.

Exit codes (task reflects the A2A task state, so scripts can gate):
  0  completed
  3  in progress / needs input (submitted | working | input-required | auth-required)
  1  failed | canceled | rejected, or error
\`status\` exits 0 when A2A is advertised, 1 when it is not.

Examples:
  openwop a2a status
  openwop a2a task run_abc123 --json
  openwop a2a rpc agent/getCard
  openwop a2a rpc message/send --params '{"message":{"role":"user","parts":[{"kind":"text","text":"hi"}]}}' --a2a-version 1.0
  openwop a2a push-config run_abc123 --url https://hooks.example.com/a2a
`;

const SUBCOMMANDS = ['status', 'task', 'rpc', 'start', 'push-config', 'invoke'];
const A2A_BASE = '/v1/host/openwop-app/a2a';

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
    case 'rpc':
      return await runRpc(ctx, args);
    case 'start':
      return await runStart(ctx, args);
    case 'push-config':
      return await runPushConfig(ctx, args);
    case 'invoke':
      return await runInvoke(ctx, args);
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
    const res = await requestJson(ctx, `/v1/host/openwop-app/a2a/tasks/${encodeURIComponent(id)}`);
    t = res.body ?? {};
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(`a2a: no durable task ${id} (the host must serve /v1/host/openwop-app/a2a/tasks/{taskId}; taskId equals the backing runId).`, 1);
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

// `openwop a2a rpc <method>` — one JSON-RPC 2.0 call to the host's A2A server.
async function runRpc(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--params', '--id', '--a2a-version'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, "Usage: openwop a2a rpc <method> [--params '{...}'] [--id <id>] [--a2a-version <v>] [--json]\n");
    return options.help ? 0 : 2;
  }
  let params: unknown = {};
  if (options.params !== undefined) {
    try { params = JSON.parse(String(options.params)); } catch { throw new CliError('--params must be valid JSON', 2); }
  }
  const body = { jsonrpc: '2.0', id: options.id ?? randomUUID(), method: positionals[0], params };
  const headers: Record<string, string> = {};
  if (options.a2aVersion) headers['a2a-version'] = String(options.a2aVersion);
  const res = await requestJson(ctx, A2A_BASE, { method: 'POST', body, headers });
  const reply = res.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, reply);
    return reply.error ? 1 : 0;
  }
  if (reply.error) {
    writeLine(ctx.io.stderr, `openwop: a2a ${positionals[0]} failed: ${reply.error.code ?? ''} ${reply.error.message ?? ''}`.trim());
    if (reply.error.data !== undefined) writeLine(ctx.io.stderr, JSON.stringify(reply.error.data));
    return 1;
  }
  writeLine(ctx.io.stdout, JSON.stringify(reply.result ?? reply, null, 2));
  return 0;
}

async function runStart(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--scenario'] });
  if (options.help) { write(ctx.io.stdout, A2A_HELP); return 0; }
  const res = await requestJson(ctx, `${A2A_BASE}/tasks/start`, { method: 'POST', body: { scenario: options.scenario ?? 'paused-at-approval' } });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Started durable task ${res.body?.taskId}. Read it with \`openwop a2a task ${res.body?.taskId}\`.`);
  return 0;
}

async function runPushConfig(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--url', '--token-fingerprint'] });
  if (options.help || positionals.length !== 1 || !options.url) {
    write(ctx.io.stdout, 'Usage: openwop a2a push-config <taskId> --url <https-url> [--token-fingerprint <fp>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = { taskId: positionals[0], url: options.url };
  if (options.tokenFingerprint) body.tokenFingerprint = options.tokenFingerprint;
  const res = await requestJson(ctx, `${A2A_BASE}/tasks/push-config`, { method: 'POST', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Push target set for task ${positionals[0]} → ${res.body?.pushConfig?.url ?? options.url}.`);
  return 0;
}

async function runInvoke(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, {
    bool: ['--help', '--authenticated'],
    value: ['--peer-url', '--peer-offers-only', '--request-version', '--scenario'],
  });
  if (options.help || !options.peerUrl) {
    write(ctx.io.stdout, 'Usage: openwop a2a invoke --peer-url <url> [--authenticated] [--peer-offers-only <v>] [--request-version <v>] [--scenario <s>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = { peerUrl: options.peerUrl };
  if (options.authenticated) body.authenticated = true;
  if (options.peerOffersOnly) body.peerOffersOnly = options.peerOffersOnly;
  if (options.requestVersion) body.requestVersion = options.requestVersion;
  if (options.scenario) body.scenario = options.scenario;
  const res = await requestJson(ctx, `${A2A_BASE}/invoke`, { method: 'POST', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `negotiatedVersion: ${res.body?.negotiatedVersion ?? '(none)'}`);
  if (res.body?.peerAuthority) writeLine(ctx.io.stdout, `peerAuthority: ${JSON.stringify(res.body.peerAuthority)}`);
  return 0;
}

import type { Ctx } from '../context.js';
/** `openwop workforces ...` (alias `fleet`) — durable multi-agent orchestration.
 *
 * Drives the Governed Workforce surface (sample host-extension, non-normative):
 *   GET   /v1/host/sample/workforces                       — list definitions
 *   GET   /v1/host/sample/workforces/{id}                  — the full bundle
 *   GET   /v1/host/sample/workforces/{id}/metrics          — aggregate telemetry
 *   GET   /v1/host/sample/workforces/{id}/governance       — autonomy + posture
 *   GET   /v1/host/sample/workforces/{id}/migration        — migration journey
 *   GET   /v1/host/sample/workforces/{id}/trace[?q=]       — cross-run trace search
 *   GET   /v1/host/sample/workforces/{id}/shadow           — shadow-eval summary
 *   PATCH /v1/host/sample/workforces/{id}                  — set status (cutover)
 *   POST  /v1/host/sample/workforces/{id}/eval             — live shadow eval (gated)
 *
 * BOUNDARY: a `workforce` is durable multi-agent orchestration at fleet scale —
 * a governed bundle of agent specs, autonomy graduation, and aggregate telemetry.
 * It COMPOSES with but does NOT duplicate `kanban` (task boards) or `roster`
 * (standing agents): this group renders the workforce's governance/metrics view,
 * it does not re-model boards or roster entries. The host is the authority — the
 * CLI renders its resolved view and fails closed if the surface isn't advertised.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

const STATUSES = ['shadow', 'piloting', 'production'];

export const WORKFORCES_HELP = `Usage:
  openwop workforces list [--json]
  openwop workforces get <workforceId> [--json]
  openwop workforces metrics <workforceId> [--json]
  openwop workforces governance <workforceId> [--json]
  openwop workforces migration <workforceId> [--json]
  openwop workforces trace <workforceId> [--q <query>] [--json]
  openwop workforces shadow <workforceId> [--json]
  openwop workforces status <workforceId> <shadow|piloting|production> [--json]
  openwop workforces eval <workforceId> [--json]

Durable multi-agent orchestration at fleet scale (alias: \`fleet\`). A workforce is
a governed bundle — agent specs, graduated-autonomy posture, and aggregate
telemetry derived from its runs. \`status\` requests a cutover (the host gates
promotion to \`production\` on the workforce having graduated to bounded-autonomous,
and always allows rollback). \`eval\` runs a live shadow eval (host-gated capability).

This group COMPOSES with — and does not duplicate — \`kanban\` (task boards) and
\`roster\` (standing agents): it renders the workforce's governance/metrics view,
never re-modelling boards or roster entries. The host is the authority; the CLI
renders its resolved view and fails closed if the surface isn't advertised.

Endpoints:
  list        GET   /v1/host/sample/workforces
  get         GET   /v1/host/sample/workforces/{id}
  metrics     GET   /v1/host/sample/workforces/{id}/metrics
  governance  GET   /v1/host/sample/workforces/{id}/governance
  migration   GET   /v1/host/sample/workforces/{id}/migration
  trace       GET   /v1/host/sample/workforces/{id}/trace[?q=]
  shadow      GET   /v1/host/sample/workforces/{id}/shadow
  status      PATCH /v1/host/sample/workforces/{id}   (body {status})
  eval        POST  /v1/host/sample/workforces/{id}/eval

  --q <query>   (trace) Match runs by correlationId / batchId / runId / outcome / status.
  --json        Print the raw host response instead of the rendered view.

Exit codes:
  reads / status / eval   0 ok · 2 usage · 1 not-found / not-eligible / error

Examples:
  openwop workforces list
  openwop fleet get wf_support --json
  openwop workforces metrics wf_support
  openwop workforces trace wf_support --q batch_42
  openwop workforces status wf_support production
`;

const SUBCOMMANDS = ['list', 'get', 'metrics', 'governance', 'migration', 'trace', 'shadow', 'status', 'eval'];

export async function runWorkforces(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, WORKFORCES_HELP);
    return 0;
  }
  const args = argv.slice(SUBCOMMANDS.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list':
      return await runWfList(ctx, args);
    case 'get':
      return await runWfReadOne(ctx, args, '', renderWorkforce);
    case 'metrics':
      return await runWfReadOne(ctx, args, '/metrics', renderMetrics);
    case 'governance':
      return await runWfReadOne(ctx, args, '/governance', renderGovernance);
    case 'migration':
      return await runWfReadOne(ctx, args, '/migration', renderMigration);
    case 'trace':
      return await runWfTrace(ctx, args);
    case 'shadow':
      return await runWfReadOne(ctx, args, '/shadow', renderShadow);
    case 'status':
      return await runWfStatus(ctx, args);
    case 'eval':
      return await runWfEval(ctx, args);
    default:
      throw new CliError(`Unknown workforces command: ${sub}\nRun \`openwop workforces --help\` for usage.`);
  }
}

/** Capability honesty: confirm the host advertises the workforces surface. A
 *  reachable discovery doc that omits it ⇒ fail closed; an unreachable one is
 *  inconclusive (defer to the live call's 404 translation). */
async function ensureAdvertised(ctx: Ctx): Promise<void> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return;
  const paths = wk.body && typeof wk.body === 'object' ? (wk.body as { paths?: unknown }).paths : undefined;
  const advertised =
    paths !== null && typeof paths === 'object' &&
    Object.keys(paths as Record<string, unknown>).some((p) => p.startsWith('/v1/host/sample/workforces'));
  if (!advertised) {
    throw new CliError(
      'workforces: this host does not advertise the workforces surface (/v1/host/sample/workforces is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
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
      `workforces: ${detail} (the host must mount /v1/host/sample/workforces; the CLI renders the host's view, it never orchestrates locally).`,
      1,
    );
  }
  throw err;
}

const num = (v: unknown): string => (typeof v === 'number' ? String(v) : v == null ? '' : String(v));
const pct = (v: unknown): string => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '');
const ms = (v: unknown): string => (typeof v === 'number' ? `${Math.round(v)}ms` : '');

async function runWfList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, WORKFORCES_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, '/v1/host/sample/workforces');
  } catch (err) {
    gate404(err);
  }
  const workforces = Array.isArray(res!.body?.workforces) ? res!.body.workforces : [];
  if (ctx.json) {
    writeJson(ctx.io.stdout, { workforces });
    return 0;
  }
  if (workforces.length === 0) {
    writeLine(ctx.io.stdout, 'No workforces on this host.');
    return 0;
  }
  const rows = workforces.map((w: any) => ({
    workforceId: w.workforceId,
    name: w.name ?? '',
    businessFunction: w.businessFunction ?? '',
    status: w.status ?? '',
    autonomy: w.autonomyLevel ?? '',
    agents: Array.isArray(w.agents) ? String(w.agents.length) : '0',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['workforceId', 'name', 'businessFunction', 'status', 'autonomy', 'agents']));
  return 0;
}

/** Shared read of /workforces/{id}{suffix} with a human renderer + --json passthrough. */
async function runWfReadOne(
  ctx: Ctx,
  argv: string[],
  suffix: string,
  render: (ctx: Ctx, body: any, id: string) => void,
): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, WORKFORCES_HELP);
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/workforces/${encodeURIComponent(positionals[0])}${suffix}`);
  } catch (err) {
    gate404(err);
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, res!.body);
    return 0;
  }
  render(ctx, res!.body ?? {}, positionals[0]);
  return 0;
}

function renderWorkforce(ctx: Ctx, w: any, id: string): void {
  writeLine(ctx.io.stdout, `workforceId: ${w.workforceId ?? id}`);
  writeLine(ctx.io.stdout, `name: ${w.name ?? ''}`);
  writeLine(ctx.io.stdout, `businessFunction: ${w.businessFunction ?? ''}`);
  writeLine(ctx.io.stdout, `status: ${w.status ?? ''}`);
  writeLine(ctx.io.stdout, `autonomyLevel: ${w.autonomyLevel ?? ''}`);
  if (w.purpose?.statement) writeLine(ctx.io.stdout, `purpose: ${w.purpose.statement}`);
  if (Array.isArray(w.successMetrics)) writeLine(ctx.io.stdout, `successMetrics: ${w.successMetrics.join(', ') || '(none)'}`);
  if (Array.isArray(w.workflowCatalog)) writeLine(ctx.io.stdout, `workflowCatalog: ${w.workflowCatalog.join(', ') || '(none)'}`);
  if (Array.isArray(w.agents)) {
    writeLine(ctx.io.stdout, `agents (${w.agents.length}):`);
    for (const a of w.agents) {
      writeLine(ctx.io.stdout, `  · ${a.agentRef ?? '?'} [${a.role ?? '?'}] autonomy=${a.autonomyLevel ?? '?'}`);
    }
  }
}

function renderMetrics(ctx: Ctx, m: any, id: string): void {
  writeLine(ctx.io.stdout, `workforceId: ${m.workforceId ?? id}`);
  writeLine(ctx.io.stdout, `totalRuns: ${num(m.totalRuns)}  terminalRuns: ${num(m.terminalRuns)}  openApprovals: ${num(m.openApprovals)}`);
  writeLine(ctx.io.stdout, `cycleTimeP50: ${ms(m.cycleTimeP50Ms)}  costPerCleared: ${m.costPerClearedUsd != null ? `$${m.costPerClearedUsd}` : ''}`);
  writeLine(ctx.io.stdout, `escalationRate: ${pct(m.escalationRate)}  overrideRate: ${pct(m.overrideRate)}  falsePositiveRate: ${pct(m.falsePositiveRate)}  recoveryRate: ${pct(m.recoveryRate)}`);
  writeLine(ctx.io.stdout, `policyViolations: ${num(m.policyViolations)}`);
  if (m.source) writeLine(ctx.io.stdout, `source: ${m.source}`);
}

function renderGovernance(ctx: Ctx, g: any, id: string): void {
  const a = g.autonomy ?? {};
  const p = g.posture ?? {};
  writeLine(ctx.io.stdout, `workforceId: ${a.workforceId ?? id}`);
  writeLine(ctx.io.stdout, `currentTier: ${a.currentTier ?? '(none)'}  nextTier: ${a.nextTier ?? '(none)'}  eligibleForNext: ${a.eligibleForNext === true ? 'yes' : 'no'}`);
  if (a.nextThreshold != null) writeLine(ctx.io.stdout, `nextThreshold: ${num(a.nextThreshold)}  recentOverrideIncidence: ${pct(a.recentOverrideIncidence)}`);
  writeLine(ctx.io.stdout, `posture — overrides: ${num(p.overrides)}  escalations: ${num(p.escalations)}  falsePositives: ${num(p.falsePositives)}  recoveries: ${num(p.recoveries)}  policyViolations: ${num(p.policyViolations)}`);
  if (g.source) writeLine(ctx.io.stdout, `source: ${g.source}`);
}

function renderMigration(ctx: Ctx, j: any, id: string): void {
  writeLine(ctx.io.stdout, `workforceId: ${j.workforceId ?? id}`);
  const stages = Array.isArray(j.stages) ? j.stages : [];
  if (stages.length === 0) {
    // Some hosts key the journey by stage object; print compactly.
    writeJson(ctx.io.stdout, j);
    return;
  }
  for (const s of stages) {
    writeLine(ctx.io.stdout, `  · ${s.key ?? s.stage ?? '?'}: ${s.status ?? '?'}`);
  }
}

function renderShadow(ctx: Ctx, s: any, id: string): void {
  writeLine(ctx.io.stdout, `workforceId: ${s.workforceId ?? id}`);
  // The shadow summary shape varies; render top-level scalars, JSON the rest.
  for (const [k, v] of Object.entries(s)) {
    if (k === 'workforceId') continue;
    if (v == null || typeof v === 'object') continue;
    writeLine(ctx.io.stdout, `${k}: ${String(v)}`);
  }
}

async function runWfTrace(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--q'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop workforces trace <workforceId> [--q <query>] [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  const q = options.q !== undefined ? `?q=${encodeURIComponent(options.q)}` : '';
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/workforces/${encodeURIComponent(positionals[0])}/trace${q}`);
  } catch (err) {
    gate404(err);
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, res!.body);
    return 0;
  }
  const matches = Array.isArray(res!.body?.matches) ? res!.body.matches : [];
  if (matches.length === 0) {
    writeLine(ctx.io.stdout, `No trace matches for ${positionals[0]}${options.q ? ` (q=${options.q})` : ''}.`);
    return 0;
  }
  writeLine(ctx.io.stdout, formatTable(
    matches.map((m: any) => ({ runId: m.runId ?? '', status: m.status ?? '', outcome: m.outcome ?? '', createdAt: m.createdAt ?? m.atIso ?? '' })),
    ['runId', 'status', 'outcome', 'createdAt'],
  ));
  return 0;
}

async function runWfStatus(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 2) {
    write(ctx.io.stdout, 'Usage: openwop workforces status <workforceId> <shadow|piloting|production> [--json]\n');
    return options.help ? 0 : 2;
  }
  const [id, status] = positionals;
  if (!STATUSES.includes(status)) {
    throw new CliError(`status must be one of: ${STATUSES.join(', ')}`, 2);
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/workforces/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
  } catch (err) {
    // 409 = the host refused the cutover (not graduated to bounded-autonomous yet).
    if (err instanceof HttpError && err.status === 409) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? 'cutover not eligible';
      throw new CliError(`workforces: ${detail}`, 1);
    }
    gate404(err);
  }
  const out = res!.body ?? {};
  if (ctx.json) {
    writeJson(ctx.io.stdout, out);
    return 0;
  }
  writeLine(ctx.io.stdout, `✓ ${out.workforceId ?? id} → status ${out.status ?? status}`);
  return 0;
}

async function runWfEval(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop workforces eval <workforceId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/workforces/${encodeURIComponent(positionals[0])}/eval`, { method: 'POST' });
  } catch (err) {
    // 501 = the host does not enable the agent eval suite — fail closed legibly.
    if (err instanceof HttpError && err.status === 501) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? 'this host does not enable the agent eval suite';
      throw new CliError(`workforces: ${detail}`, 1);
    }
    gate404(err);
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, res!.body);
    return 0;
  }
  const s = res!.body ?? {};
  writeLine(ctx.io.stdout, `eval complete for ${positionals[0]}`);
  for (const [k, v] of Object.entries(s)) {
    if (v == null || typeof v === 'object') continue;
    writeLine(ctx.io.stdout, `${k}: ${String(v)}`);
  }
  return 0;
}

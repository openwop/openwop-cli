import type { Ctx } from '../context.js';
/** `openwop cron ...` — manage RFC 0052 scheduled jobs (sample-extension). */
import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';

export const CRON_HELP = `Usage:
  openwop cron list [--roster <rosterId>] [--json]
  openwop cron add "<cronExpr>" [--workflow <id>] [--job-id <id>] [--first-fire-at-ms <ms>] [--json]
  openwop cron enable <jobId> [--json]
  openwop cron disable <jobId> [--json]
  openwop cron remove <jobId> [--json]
  openwop cron trigger <jobId> [--json]

Manage scheduled (cron) jobs on the configured host via the RFC 0052 sample
scheduler CRUD (/v1/host/sample/scheduler/jobs). This is a sample-extension
surface — not part of the normative OpenWOP wire contract.

  list     Lists jobs (tenant-scoped). --roster <id> filters to the schedules
           owned by one roster member (?rosterId=).
  add      Registers a job. --job-id is optional (the host assigns a UUID when
           omitted). A --first-fire-at-ms beyond the host's maxFutureHorizon is
           rejected with schedule_horizon_exceeded (RFC 0052 §B.3).
  enable   Activates a job (PATCH {enabled:true}); its triggers fire again.
  disable  Deactivates a job (PATCH {enabled:false}); the row stays but its
           triggers are inert (mirrors the roster 'enabled' posture).
  trigger  Fires the job once now. Honors RFC 0052 §B.2 fire-once-per-tick: a
           single trigger advances the scheduler clock one tick and produces
           exactly one run.
`;


export async function runCron(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'add', 'enable', 'disable', 'remove', 'rm', 'trigger'].includes(sub) ? 1 : 0);
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, CRON_HELP);
    return 0;
  }
  switch (sub) {
    case 'list':
      return await runCronList(ctx, args);
    case 'add':
      return await runCronAdd(ctx, args);
    case 'enable':
      return await runCronSetEnabled(ctx, args, true);
    case 'disable':
      return await runCronSetEnabled(ctx, args, false);
    case 'remove':
    case 'rm':
      return await runCronRemove(ctx, args);
    case 'trigger':
      return await runCronTrigger(ctx, args);
    default:
      throw new CliError(`Unknown cron command: ${sub}\nRun \`openwop cron --help\` for usage.`);
  }
}

async function runCronList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--roster'] });
  if (options.help) {
    write(ctx.io.stdout, CRON_HELP);
    return 0;
  }
  // Optional ?rosterId= filter — schedules owned by one roster member.
  const path = options.roster !== undefined
    ? `/v1/host/sample/scheduler/jobs?rosterId=${encodeURIComponent(options.roster)}`
    : '/v1/host/sample/scheduler/jobs';
  const res = await requestJson(ctx, path);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const jobs = Array.isArray(res.body?.jobs) ? res.body.jobs : [];
  if (jobs.length === 0) {
    writeLine(ctx.io.stdout, options.roster !== undefined
      ? `No scheduled jobs for roster ${options.roster}.`
      : 'No scheduled jobs. Add one with `openwop cron add "<cronExpr>" --workflow <id>`.');
    return 0;
  }
  const rows = jobs.map((j: any) => ({
    jobId: j.jobId,
    cronExpr: j.cronExpr,
    workflowId: j.workflowId ?? '',
    enabled: j.enabled === false ? 'no' : 'yes',
    rosterId: j.rosterId ?? '',
    lastFiredTick: j.lastFiredTick ?? '-',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['jobId', 'cronExpr', 'workflowId', 'enabled', 'rosterId', 'lastFiredTick']));
  return 0;
}

// PATCH /v1/host/sample/scheduler/jobs/{jobId} {enabled} — toggle a schedule
// active/inert (RFC 0052). A disabled job keeps its row but fires no triggers.
async function runCronSetEnabled(ctx: Ctx, argv: string[], enabled: boolean) {
  const verb = enabled ? 'enable' : 'disable';
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop cron ${verb} <jobId> [--json]\n`);
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/host/sample/scheduler/jobs/${encodeURIComponent(positionals[0])}`, {
    method: 'PATCH',
    body: { enabled },
  });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `✓ ${enabled ? 'Enabled' : 'Disabled'} job ${res.body?.jobId ?? positionals[0]} (enabled: ${res.body?.enabled === false ? 'false' : enabled ? 'true' : 'false'})`);
  return 0;
}

async function runCronAdd(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--workflow', '--job-id', '--first-fire-at-ms'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop cron add "<cronExpr>" [--workflow <id>] [--job-id <id>] [--first-fire-at-ms <ms>] [--json]\n');
    return options.help ? 0 : 2;
  }
  const body = {
    cronExpr: positionals[0],
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.workflow ? { workflowId: options.workflow } : {}),
    ...(options.firstFireAtMs !== undefined ? { firstFireAtMs: Number(options.firstFireAtMs) } : {}),
  };
  const res = await requestJson(ctx, '/v1/host/sample/scheduler/jobs', { method: 'POST', body });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `✓ Scheduled job ${res.body.jobId} (${res.body.cronExpr})`);
  return 0;
}

async function runCronRemove(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop cron remove <jobId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/host/sample/scheduler/jobs/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `✓ Removed scheduled job ${positionals[0]}`);
  return 0;
}

async function runCronTrigger(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop cron trigger <jobId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/host/sample/scheduler/jobs/${encodeURIComponent(positionals[0])}/trigger`, { method: 'POST', body: {} });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `✓ Fired ${positionals[0]} — ${res.body.runsFired} run(s) (tick ${res.body.lastFiredTick}).`);
  return 0;
}


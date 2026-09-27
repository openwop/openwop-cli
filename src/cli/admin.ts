import type { Ctx } from '../context.js';
/** `openwop admin ...` — operator maintenance (ephemeral-secret cleanup). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { promptYesNo } from '../prompt.js';
import { gatedRequest } from './adminShared.js';

export const ADMIN_HELP = `Usage:
  openwop admin cleanup [--confirm] [--json]
  openwop admin cleanup --status [--json]
  openwop admin run-retention [--json]
  openwop admin run-retention hold <tenantId> --reason <text> [--json]
  openwop admin run-retention release <tenantId> [--json]

Operator maintenance for the demo host. \`cleanup\` POSTs to
/v1/host/openwop-app/admin/cleanup, wiping ephemeral secrets for tenants idle past
the cleanup window; \`--status\` is a read-only liveness probe. Admin-token
gated — pass the host's OPENWOP_ADMIN_TOKEN via --api-key. Without --confirm
the destructive POST asks for confirmation.

\`run-retention\` (ADR 0371) reads the run-retention posture — default retention days,
export on/off, the sweep window, the last sweep + proposal sweep, and every legal HOLD —
from GET /v1/host/openwop-app/admin/run-retention. \`hold\` places a legal hold on a tenant
(POST /admin/run-retention/hold {tenantId, reason}; its runs are exempt from the sweep);
\`release\` removes it (DELETE /admin/run-retention/hold/:tenantId). Counters are
per-instance; holds are durable and global.

Every admin route needs the admin token: without it the command fails closed with exit 4;
when the server has no admin token configured it exits 1 and says so.

Exit codes: 0 ok · 1 host error / admin routes disabled · 2 usage · 4 missing/wrong admin token.
`;

export async function runAdmin(ctx: Ctx, argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, ADMIN_HELP);
    return sub ? 0 : 2;
  }
  if (sub === 'run-retention') return await runRetention(ctx, argv.slice(1));
  if (sub !== 'cleanup') throw new CliError(`Unknown admin command: ${sub}\nRun \`openwop admin --help\` for usage.`);

  const { options } = parseOptions(argv.slice(1), { bool: ['--status', '--confirm', '--yes'] });
  if (options.status) {
    const res = await requestJson(ctx, '/v1/host/openwop-app/admin/cleanup/status');
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const oldest = res.body.oldestActivityMs == null ? 'n/a' : `${Math.round(res.body.oldestActivityMs / 1000)}s ago`;
    writeLine(ctx.io.stdout, `trackedTenants=${res.body.trackedTenants} oldestActivity=${oldest}`);
    return 0;
  }
  // The POST wipes expired ephemeral secrets for inactive tenants — confirm.
  if (!options.confirm && !options.yes) {
    const ok = await promptYesNo(ctx, 'Run cleanup now? This wipes ephemeral secrets for tenants idle past the window.', false);
    if (!ok) { writeLine(ctx.io.stdout, 'Aborted.'); return 1; }
  }
  const res = await requestJson(ctx, '/v1/host/openwop-app/admin/cleanup', { method: 'POST', body: {} });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `✓ Cleanup ran — activeTenants=${res.body.activeTenants} wipedSecrets=${res.body.wipedSecrets} window=${Math.round((res.body.windowMs ?? 0) / 3_600_000)}h`);
  return 0;
}

const RETENTION = '/v1/host/openwop-app/admin/run-retention';
const SURFACE = 'Run-retention administration';

async function runRetention(ctx: Ctx, argv: string[]) {
  const verb = argv[0] === 'hold' || argv[0] === 'release' || argv[0] === 'status' ? argv[0] : 'status';
  const { options, positionals } = parseOptions(argv[0] === verb ? argv.slice(1) : argv, { bool: ['--help'], value: ['--reason'] });
  if (options.help) { write(ctx.io.stdout, ADMIN_HELP); return 0; }
  if (verb === 'hold') {
    if (!positionals[0] || !options.reason) throw new CliError('Usage: openwop admin run-retention hold <tenantId> --reason <text>', 2);
    const res = await gatedRequest(ctx, `${RETENTION}/hold`, { method: 'POST', body: { tenantId: positionals[0], reason: options.reason } }, SURFACE, 'admin-token');
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    writeLine(ctx.io.stdout, `Legal hold placed on ${positionals[0]}.`);
    return 0;
  }
  if (verb === 'release') {
    if (!positionals[0]) throw new CliError('Usage: openwop admin run-retention release <tenantId>', 2);
    const res = await gatedRequest(ctx, `${RETENTION}/hold/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' }, SURFACE, 'admin-token');
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    writeLine(ctx.io.stdout, res.body?.removed ? `Released the hold on ${positionals[0]}.` : `No hold was set on ${positionals[0]}.`);
    return 0;
  }
  const res = await gatedRequest(ctx, RETENTION, undefined, SURFACE, 'admin-token');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `defaultRetentionDays: ${b.defaultRetentionDays ?? '(none)'}`);
  writeLine(ctx.io.stdout, `exportEnabled:        ${b.exportEnabled ? 'yes' : 'no'}`);
  writeLine(ctx.io.stdout, `window:               ${b.window ?? '(default)'}`);
  writeLine(ctx.io.stdout, `lastSweep:            ${b.lastSweep ? JSON.stringify(b.lastSweep) : '(none on this instance)'}`);
  writeLine(ctx.io.stdout, `proposalSweep:        ${b.proposalSweep ? JSON.stringify(b.proposalSweep) : '(none on this instance)'}`);
  const holds = Array.isArray(b.holds) ? b.holds : [];
  writeLine(ctx.io.stdout, `holds:                ${holds.length ? '' : '(none)'}`);
  for (const h of holds) writeLine(ctx.io.stdout, `  ${h.tenantId ?? '?'} — ${h.reason ?? ''}${h.createdAt ? ` (${h.createdAt})` : ''}`);
  return 0;
}

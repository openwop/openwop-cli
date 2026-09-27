import type { Ctx } from '../context.js';
/**
 * `openwop runtime-posture ...` — the serving service's warm/cold posture
 * (openwop-app `features/runtime-posture/routes.ts`). Read-only by design: a
 * change REQUEST returns the exact commands an operator with deploy rights runs;
 * the host never applies anything itself.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { gatedRequest } from './adminShared.js';

const BASE = '/v1/host/openwop-app/runtime-posture';
const SURFACE = 'Runtime posture';

export const RUNTIME_POSTURE_HELP = `Usage:
  openwop runtime-posture [get] [--json]
  openwop runtime-posture request --warm|--cold [--json]

The serving service's runtime posture (host extension, SUPER-ADMIN gated).
  get      GET  ${BASE}                   live posture (serving revision, warm/cold, rollout)
  request  POST ${BASE}/change-requests   ask for a warm/cold change; returns the commands to run

A change request APPLIES NOTHING: the host records it in the audit log and returns the
exact commands for an operator holding deploy rights. Without a super-admin principal
both commands fail closed with exit 4.

Exit codes: 0 ok · 2 usage / posture unreadable (409) · 4 not a super-admin.

Examples:
  openwop runtime-posture
  openwop runtime-posture request --warm
`;

export async function runRuntimePosture(ctx: Ctx, argv: string[]) {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'get';
  if (argv[0] === '--help' || argv[0] === '-h') { write(ctx.io.stdout, RUNTIME_POSTURE_HELP); return 0; }
  const { options } = parseOptions(sub === argv[0] ? argv.slice(1) : argv, { bool: ['--help', '--warm', '--cold'] });
  if (options.help) { write(ctx.io.stdout, RUNTIME_POSTURE_HELP); return 0; }
  if (sub === 'get') {
    const res = await gatedRequest(ctx, BASE, undefined, SURFACE, 'superadmin');
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const b = res.body ?? {};
    if (b.available === false) { writeLine(ctx.io.stdout, `Live posture unavailable: ${b.reason ?? 'unknown reason'}`); return 0; }
    writeLine(ctx.io.stdout, `service:  ${b.project ?? '?'}/${b.region ?? '?'}/${b.service ?? '?'}`);
    writeLine(ctx.io.stdout, `posture:  ${b.serving?.posture ?? '?'}`);
    writeLine(ctx.io.stdout, `serving:  ${b.servingRevision ?? '?'}${b.pendingRevision ? ` (pending ${b.pendingRevision})` : ''}`);
    writeLine(ctx.io.stdout, `rollout:  ${b.rollout ?? '?'}`);
    return 0;
  }
  if (sub !== 'request') throw new CliError(`Unknown runtime-posture command: ${sub}\nRun \`openwop runtime-posture --help\` for usage.`);
  if (Boolean(options.warm) === Boolean(options.cold)) throw new CliError('Pass exactly one of --warm or --cold.', 2);
  const res = await gatedRequest(ctx, `${BASE}/change-requests`, { method: 'POST', body: { warm: Boolean(options.warm) } }, SURFACE, 'superadmin');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `${b.from ?? '?'} → ${b.to ?? '?'}${b.noop ? ' (already there — no-op)' : ''}`);
  for (const c of Array.isArray(b.commands) ? b.commands : []) writeLine(ctx.io.stdout, `  ${c}`);
  if (b.note) writeLine(ctx.io.stdout, b.note);
  return 0;
}

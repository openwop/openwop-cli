import type { Ctx } from '../context.js';
/**
 * `openwop maintenance ...` — super-admin data maintenance (openwop-app
 * `routes/subjectRekey.ts`, ADR 0006 membership subjects). `rekey-member-subjects`
 * rewrites legacy org-member subjects (e.g. `oidc:<sub>`) to the durable
 * `user:<id>` subject so membership resolves after the users-feature bind.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { gatedRequest } from './adminShared.js';

export const MAINTENANCE_HELP = `Usage:
  openwop maintenance rekey-member-subjects [--tenant <tenantId>] [--json]

Super-admin data maintenance (host extension).
  rekey-member-subjects  POST /v1/host/openwop-app/maintenance/rekey-member-subjects
                         Re-key legacy member subjects to durable user ids for the
                         caller's workspace (or --tenant). Idempotent; audited.

SUPER-ADMIN gated: without a super-admin principal the command fails closed with exit 4.

Exit codes: 0 ok · 2 usage · 4 not a super-admin.

Examples:
  openwop maintenance rekey-member-subjects
  openwop maintenance rekey-member-subjects --tenant t_acme --json
`;

export async function runMaintenance(ctx: Ctx, argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, MAINTENANCE_HELP); return sub ? 0 : 2; }
  if (sub !== 'rekey-member-subjects') throw new CliError(`Unknown maintenance command: ${sub}\nRun \`openwop maintenance --help\` for usage.`);
  const { options } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--tenant'] });
  if (options.help) { write(ctx.io.stdout, MAINTENANCE_HELP); return 0; }
  const body: Record<string, any> = {};
  if (options.tenant) body.tenantId = options.tenant;
  const res = await gatedRequest(ctx, '/v1/host/openwop-app/maintenance/rekey-member-subjects', { method: 'POST', body }, 'Subject re-key maintenance', 'superadmin');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const { tenantId, ...counts } = res.body ?? {};
  writeLine(ctx.io.stdout, `Re-keyed member subjects for ${tenantId ?? '?'}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(no changes)'}`);
  return 0;
}

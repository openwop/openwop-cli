import type { Ctx } from '../context.js';
/**
 * `openwop commissions ...` — sales commissions (openwop-app ADR 0280).
 * Host-extension routes under `/v1/host/openwop-app/commissions/orgs/:orgId/*`
 * (toggle `sales-commissions`; reads need workspace:read, plan admin + statement
 * compute/approve/pay need `host:commissions:manage` — built-in admin/owner).
 * The host computes every statement total; `approve` only submits a draft to the
 * approval gate (a human decides it in the reviews inbox). The CLI never
 * computes or asserts a payout.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const B = '/v1/host/openwop-app/commissions/orgs/:org';
const PLAN_FIELDS = ['currency', 'assignment:json', 'rules:json', 'effectiveFrom', 'effectiveTo'];

export const COMMISSIONS_SPECS: CommandSpec[] = [
  { cmd: ['plans', 'list'], method: 'GET', route: `${B}/plans`, summary: 'List commission plans.', list: { key: 'plans', columns: ['planId', 'name', 'currency', 'effectiveFrom', 'effectiveTo'], empty: 'No commission plans.' } },
  { cmd: ['plans', 'get'], method: 'GET', route: `${B}/plans/:planId`, summary: 'Get one commission plan.' },
  { cmd: ['plans', 'create'], method: 'POST', route: `${B}/plans`, summary: 'Create a commission plan.', body: ['name!', 'currency!', 'assignment:json', 'rules:json', 'effectiveFrom!', 'effectiveTo'] },
  { cmd: ['plans', 'update'], method: 'PATCH', route: `${B}/plans/:planId`, summary: 'Patch a commission plan.', body: ['name', ...PLAN_FIELDS] },
  { cmd: ['plans', 'delete'], method: 'DELETE', route: `${B}/plans/:planId`, summary: 'Delete a commission plan (refused once it has approved/paid statements).', confirm: true },
  { cmd: ['plans', 'compute'], method: 'POST', route: `${B}/plans/:planId/statements/compute`, summary: 'Compute (or recompute) a rep\'s statement for a period.', body: ['subjectId!', 'period!'] },
  { cmd: ['statements', 'list'], method: 'GET', route: `${B}/statements`, summary: 'List statements (managers see all reps; reps see their own).', query: ['subjectId', 'period', 'planId'], list: { key: 'statements', columns: ['statementId', 'planId', 'subjectId', 'period', 'status', 'total', 'currency'], empty: 'No statements.' } },
  { cmd: ['statements', 'get'], method: 'GET', route: `${B}/statements/:statementId`, summary: 'Get one statement.' },
  { cmd: ['statements', 'approve'], method: 'POST', route: `${B}/statements/:statementId/approve`, summary: 'Submit a draft statement for approval (returns the review card).' },
  { cmd: ['statements', 'pay'], method: 'POST', route: `${B}/statements/:statementId/pay`, summary: 'Mark an approved statement paid.' },
];

export const COMMISSIONS_HELP = buildGroupHelp('commissions', `
Sales commissions (host-extension /v1/host/openwop-app/commissions/…,
org-scoped). A plan has --currency (ISO-4217, e.g. USD), --effective-from /
--effective-to (YYYY-MM-DD), --assignment {"kind":"territory"|"role"|"rep","ref":"…"}
and --rules [{"basis":"deal-won","type":"percentage"|"fixed","rate":n,
"accelerators":[{"attainmentGte":100,"rate":n}],"cap":n}]. \`plans compute\`
asks the server to compute a statement for --subject-id over --period;
\`statements approve\` submits it to the approval gate (decided in the reviews
inbox, exit 0 on 202); \`statements pay\` records the payout. Totals are the
server's own numbers.
`, COMMISSIONS_SPECS, `Examples:
  openwop commissions plans list --org org_1
  openwop commissions plans create --org org_1 --name "AE 2026" --currency USD --effective-from 2026-01-01 --assignment '{"kind":"role","ref":"ae"}' --rules '[{"basis":"deal-won","type":"percentage","rate":8}]'
  openwop commissions plans compute plan_1 --org org_1 --subject-id user_7 --period 2026-09
  openwop commissions statements approve stmt_1 --org org_1`);

export async function runCommissions(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'commissions', COMMISSIONS_HELP, COMMISSIONS_SPECS, argv);
}

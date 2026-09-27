import type { Ctx } from '../context.js';
/**
 * `openwop operations ...` — the operator console (ADR 0395 operator admin suite):
 * host health / SLO / DLQ / dispatch-outbox / webhook-delivery summaries plus the
 * recovery verbs (DLQ replay, outbox redrive, delivery retry, trigger pause) and
 * saga compensation (per-run obligations + recovery actions).
 *
 * Most summaries are SUPERADMIN (403 → exit 4); the per-org webhook summary and
 * run compensation are tenant-scoped and 404 when the `operations` feature is off.
 * The host is the authority for every recovery decision — the CLI relays the verb
 * and prints the host's verdict; every mutation is audit-logged host-side.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const B = '/v1/host/openwop-app/operations';

export const OPERATIONS_ROUTES: RouteCmd[] = [
  { words: ['health'], method: 'GET', path: `${B}/health/summary`, summary: 'Host health rollup (providers, config, storage, SSE, rate limits, daemon). Superadmin.' },
  { words: ['slo'], method: 'GET', path: `${B}/slo/summary`, summary: 'SLO rows + active alerts from the local metrics scrape. Superadmin.',
    table: { key: 'rows', columns: ['id', 'metric', 'state', 'observed', 'comparison', 'target'], empty: 'No SLO rows.' } },
  { words: ['dlq'], method: 'GET', path: `${B}/dlq/summary`, summary: 'Dead-letter queue depth per subject. Superadmin.',
    query: [{ flag: '--tenant-id', key: 'tenantId' }],
    table: { key: 'subjects', columns: ['tenantId', 'subject', 'depth', 'reasons'], empty: 'Dead-letter queue is empty.' } },
  { words: ['dlq', 'replay'], method: 'POST', path: `${B}/dlq/replay`, summary: 'Replay one dead-lettered message (202). Superadmin.',
    body: [{ flag: '--tenant-id', key: 'tenantId', required: true }, { flag: '--subject', key: 'subject', required: true }, { flag: '--message-id', key: 'messageId', required: true }] },
  { words: ['outbox'], method: 'GET', path: `${B}/dispatch-outbox/summary`, summary: 'Run-dispatch outbox: pending/dead counts + dead rows. Superadmin.',
    table: { key: 'dead', columns: ['runId', 'tenantId', 'workflowId', 'attempts', 'lastError', 'updatedAt'], empty: 'No dead outbox rows.' } },
  { words: ['outbox', 'redrive'], method: 'POST', path: `${B}/dispatch-outbox/:runId/redrive`, summary: 'Re-drive a dead outbox row (202). Superadmin; the reason is audit-logged.',
    body: [{ flag: '--reason', key: 'reason', required: true }] },
  { words: ['webhooks'], method: 'GET', path: [`${B}/webhooks/summary`, `${B}/orgs/:orgId/webhooks/summary`],
    summary: 'Webhook + trigger-subscription delivery health. No <orgId> = all tenants (superadmin, optional --tenant-id); with <orgId> = your tenant (webhooks:manage).',
    query: [{ flag: '--tenant-id', key: 'tenantId' }],
    table: { key: 'webhooks', columns: ['subscriptionId', 'url', 'counts.pending', 'counts.dead', 'counts.delivered'], empty: 'No webhook subscriptions.' } },
  { words: ['webhooks', 'retry'], method: 'POST', path: `${B}/webhooks/deliveries/:deliveryId/retry`, summary: 'Retry one failed webhook delivery (202). Superadmin.' },
  { words: ['triggers', 'set-state'], method: 'POST', path: `${B}/trigger-subscriptions/:subscriptionId/state`, summary: 'Pause or resume a trigger subscription. Superadmin.',
    body: [{ flag: '--state', key: 'state', required: true, help: 'active | paused' }] },
  { words: ['compensation'], method: 'GET', path: `${B}/runs/:runId/compensation`, summary: 'A run\'s compensation status + obligations (host:compensation:start).',
    table: { key: 'obligations', columns: ['obligationId', 'nodeId', 'state', 'effectKind', 'attempts', 'requiresApproval'], empty: 'No compensation obligations.' } },
  { words: ['compensation', 'act'], method: 'POST', path: `${B}/runs/:runId/compensation/actions`,
    summary: 'Apply a recovery action to one obligation: start | retry | skip | substitute | terminate (409 approval_required when a second approver is needed).',
    body: [
      { flag: '--action', key: 'action', required: true },
      { flag: '--obligation-id', key: 'obligationId', required: true },
      { flag: '--expected-state', key: 'expectedState', required: true },
      { flag: '--reason', key: 'reason' },
      { flag: '--node-type-id', key: 'nodeTypeId' },
    ] },
];

export const OPERATIONS_HELP = `Usage:
${routesHelp('operations', OPERATIONS_ROUTES)}
Operator console (ADR 0395). Summaries are point-in-time reads; several are per
server instance (the body says \`perInstance\`). Recovery verbs are audit-logged by the
host. The host decides every action — a refused one comes back as its error.

Exit codes: 0 ok · 1 server error (or 5xx) · 2 usage / not found / validation · 4 not signed in or not permitted (most summaries need a super-admin).

Examples:
  openwop operations health --json
  openwop operations dlq --tenant-id t_1
  openwop operations dlq replay --tenant-id t_1 --subject runs.dispatch.dlq --message-id m_9
  openwop operations outbox redrive run_42 --reason "provider outage cleared"
  openwop operations webhooks org_123
  openwop operations compensation run_42
  openwop operations compensation act run_42 --action retry --obligation-id ob_1 --expected-state failed
`;

export async function runOperations(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'operations', OPERATIONS_HELP, OPERATIONS_ROUTES, argv);
}

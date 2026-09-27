import type { Ctx } from '../context.js';
/**
 * `openwop bi ...` — org-scoped business-intelligence metrics (ADR 0417): a
 * metric is a stored aggregate (count|sum|avg|min|max) over a registered entity
 * type (crm.deal, commerce.product, servicedesk.ticket, ...). Defining metrics
 * needs member-management rights in the org; reading + running needs
 * workspace:read. System metrics are read-only (403 on edit). 404 when the `bi`
 * feature is off.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const M = '/v1/host/openwop-app/bi/orgs/:orgId/metrics';

const DEF_FIELDS = [
  { flag: '--title', key: 'title' },
  { flag: '--entity-type', key: 'entityType' },
  { flag: '--aggregate', key: 'aggregate', help: 'count | sum | avg | min | max' },
  { flag: '--field', key: 'field', help: 'numeric field; not needed for count' },
  { flag: '--description', key: 'description' },
  { flag: '--filters', key: 'filters', type: 'json' as const, help: '[{key, op, value}]' },
  { flag: '--group-by', key: 'groupBy' },
  { flag: '--time-field', key: 'timeField' },
];

const METADATA = ['tenantId', 'orgId', 'createdBy', 'createdAt', 'updatedAt', 'system', 'metricId'];

export const BI_ROUTES: RouteCmd[] = [
  { words: ['metrics'], method: 'GET', path: M, summary: 'Metrics defined in the org (system metrics included).',
    table: { key: 'metrics', columns: ['metricId', 'title', 'entityType', 'aggregate', 'field', 'groupBy', 'system'], empty: 'No metrics.' } },
  { words: ['metrics', 'get'], method: 'GET', path: `${M}/:metricId`, summary: 'One metric definition.' },
  { words: ['metrics', 'create'], method: 'POST', path: M, summary: 'Define a metric.',
    body: [{ flag: '--metric-id', key: 'metricId', required: true }, ...DEF_FIELDS.map((f) => (['title', 'entityType', 'aggregate'].includes(f.key) ? { ...f, required: true } : f))] },
  { words: ['metrics', 'update'], method: 'PATCH', path: `${M}/:metricId`,
    rmw: { pick: (b: any) => { const m = { ...(b?.metric ?? {}) }; for (const k of METADATA) delete m[k]; return m; } },
    summary: 'Edit a metric. The host REPLACES the whole definition, so the CLI reads it first and overlays your flags.',
    body: DEF_FIELDS },
  { words: ['metrics', 'delete'], method: 'DELETE', path: `${M}/:metricId`, summary: 'Delete a stored metric (system metrics refuse).' },
  { words: ['metrics', 'run'], method: 'POST', path: `${M}/:metricId/run`, summary: 'Evaluate a metric now (group by a field, or bucket by day|week|month over a time range).',
    body: [{ flag: '--group-by', key: 'groupBy' }, { flag: '--since', key: 'since' }, { flag: '--until', key: 'until' }, { flag: '--bucket', key: 'bucket' }] },
];

export const BI_HELP = `Usage:
${routesHelp('bi', BI_ROUTES)}
Business-intelligence metrics (ADR 0417). The host computes every value; the CLI
only relays the definition and prints the host's result points.

Exit codes: 0 ok · 1 server error · 2 usage / not found / validation · 4 not signed in or not permitted.

Examples:
  openwop bi metrics org_1
  openwop bi metrics create org_1 --metric-id open-deals --title "Open deals" --entity-type crm.deal --aggregate count
  openwop bi metrics update org_1 open-deals --group-by stageId
  openwop bi metrics run org_1 open-deals --bucket week --since 2026-07-01T00:00:00Z
`;

export async function runBi(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'bi', BI_HELP, BI_ROUTES, argv);
}

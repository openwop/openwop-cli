import type { Ctx } from '../context.js';
/**
 * `openwop insights-suite ...` — the insights-suite configuration (ADR 0081 /
 * ADR 0599): principal, business units, the schedule that builds the pack, the
 * plan source, and the anniversary trigger. Tenant-level: reads need
 * workspace:read in the tenant's root org (a missing scope reads as 404), writes
 * workspace:write. 404 when the feature is off.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const C = '/v1/host/openwop-app/insights-suite/config';

export const INSIGHTS_SUITE_ROUTES: RouteCmd[] = [
  { words: ['config'], method: 'GET', path: C, summary: 'The current configuration (null until saved).' },
  { words: ['config', 'set'], method: 'PUT', path: C,
    rmw: { pick: (b: any) => { const c = { ...(b?.config ?? {}) }; delete c.tenantId; delete c.updatedAt; return c; } },
    summary: 'Edit the configuration. The host REPLACES it whole, so the CLI reads it first and overlays your flags (a schedule needs a plan-source project).',
    body: [
      { flag: '--principal-user-id', key: 'principalUserId' },
      { flag: '--business-units', key: 'businessUnits', type: 'csv' },
      { flag: '--schedule-cron', key: 'scheduleCron' },
      { flag: '--schedule-timezone', key: 'scheduleTimezone' },
      { flag: '--plan-project-id', key: 'planSource.projectId' },
      { flag: '--plan-dataset', key: 'planSource.dataset' },
      { flag: '--anniversary-trigger', key: 'anniversaryTriggerEnabled', type: 'boolean' },
    ] },
];

export const INSIGHTS_SUITE_HELP = `Usage:
${routesHelp('insights-suite', INSIGHTS_SUITE_ROUTES)}
Insights suite configuration (ADR 0599). Saving also re-registers the host's
schedule + anniversary trigger.

Exit codes: 0 ok · 1 server error · 2 usage / not found (feature off or no access) / validation · 4 not signed in or not permitted.

Examples:
  openwop insights-suite config
  openwop insights-suite config set --principal-user-id u_1 --business-units sales,support
  openwop insights-suite config set --schedule-cron "0 7 * * 1" --schedule-timezone Europe/London --plan-project-id p_1
`;

export async function runInsightsSuite(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'insights-suite', INSIGHTS_SUITE_HELP, INSIGHTS_SUITE_ROUTES, argv);
}

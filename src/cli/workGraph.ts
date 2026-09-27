import type { Ctx } from '../context.js';
/**
 * `openwop work-graph ...` — ambient work-graph suggestions (ADR 0137): repeated
 * tool sequences mined from runs, offered as workflow drafts. Accepting creates a
 * reviewable proposal (never a live workflow). Needs workspace:write in the org.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const S = '/v1/host/openwop-app/work-graph/orgs/:orgId/suggestions';

export const WORK_GRAPH_ROUTES: RouteCmd[] = [
  { words: ['refresh'], method: 'POST', path: `${S}/refresh`, summary: 'Re-mine recent runs now and return the open suggestions.',
    table: { key: 'suggestions', columns: ['suggestionId', 'count', 'status', 'toolSequence', 'lastSeenAt'], empty: 'No suggestions.' } },
  { words: ['accept'], method: 'POST', path: `${S}/:id/accept`, summary: 'Accept a suggestion: returns a draft seed and (best-effort) a reviewable proposal id.' },
  { words: ['dismiss'], method: 'POST', path: `${S}/:id/dismiss`, summary: 'Dismiss a suggestion.' },
];

export const WORK_GRAPH_HELP = `Usage:
${routesHelp('work-graph', WORK_GRAPH_ROUTES)}
Ambient work graph (ADR 0137). \`refresh\` renders its suggestions as a table (use --json for the raw body).

Exit codes: 0 ok · 1 server error · 2 usage / not found · 4 not signed in or not permitted.

Examples:
  openwop work-graph refresh org_1
  openwop work-graph accept org_1 sug_42 --json
`;

export async function runWorkGraph(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'work-graph', WORK_GRAPH_HELP, WORK_GRAPH_ROUTES, argv);
}

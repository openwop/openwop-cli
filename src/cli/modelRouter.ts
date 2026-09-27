import type { Ctx } from '../context.js';
/**
 * `openwop model-router ...` — the rule-based model router (ADR 0130 / 0714):
 * turn an org's already-saved routing config on or off. Needs workspace:write in
 * the org; 404 when no router config exists yet (set rules first).
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const E = '/v1/host/openwop-app/model-router/orgs/:orgId/config/enable';

export const MODEL_ROUTER_ROUTES: RouteCmd[] = [
  { words: ['enable'], method: 'POST', path: E, fixed: { enabled: true }, summary: 'Enable the org\'s saved model-router config.' },
  { words: ['disable'], method: 'POST', path: E, fixed: { enabled: false }, summary: 'Disable it (same route, sends enabled:false).' },
];

export const MODEL_ROUTER_HELP = `Usage:
${routesHelp('model-router', MODEL_ROUTER_ROUTES)}
Rule-based model router (ADR 0130). The host evaluates the rules per call; the CLI
only flips the switch.

Examples:
  openwop model-router enable org_1
  openwop model-router disable org_1
`;

export async function runModelRouter(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'model-router', MODEL_ROUTER_HELP, MODEL_ROUTER_ROUTES, argv);
}

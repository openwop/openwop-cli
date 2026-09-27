import type { Ctx } from '../context.js';
/**
 * `openwop kicktodo ...` — KickTodo operator reads (ADR 0414 core, ADR 0415
 * creator): the superadmin readiness probe and the Challenge Author agent.
 *
 * `readiness` answers 503 when the product is `degraded`; that is a normal
 * answer, not a transport failure — the CLI prints the body (read `blockers`)
 * and exits 1 so scripts can gate on it.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const B = '/v1/host/openwop-app/kicktodo';

export const KICKTODO_ROUTES: RouteCmd[] = [
  { words: ['readiness'], method: 'GET', path: `${B}/readiness`, bodyOnError: [503],
    summary: 'Product readiness: features, packs, default workspaces, providers, scheduler, storage (superadmin). Exit 1 when degraded.' },
  { words: ['author'], method: 'GET', path: `${B}/creator/author`,
    summary: 'The Challenge Author agent + its workflow portfolio (provisioned on first read; needs host:kicktodo:manage).' },
];

export const KICKTODO_HELP = `Usage:
${routesHelp('kicktodo', KICKTODO_ROUTES)}
KickTodo operator surface (ADR 0414 / 0415).

Exit codes: 0 ready / ok · 1 degraded or server error · 2 usage / not found (feature off) · 4 not signed in or not permitted.

Examples:
  openwop kicktodo readiness
  openwop kicktodo author --json
`;

export async function runKicktodo(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'kicktodo', KICKTODO_HELP, KICKTODO_ROUTES, argv);
}

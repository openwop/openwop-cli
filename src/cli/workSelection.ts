import type { Ctx } from '../context.js';
/**
 * `openwop work-selection ...` — the ranked work-selection agenda for a board
 * (ADR 0534): each card's rank, score, and the per-criterion "why". A board you
 * cannot read returns an empty ranking, not an error. 404 when the feature is off.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

export const WORK_SELECTION_ROUTES: RouteCmd[] = [
  { words: ['ranking'], method: 'GET', path: '/v1/host/openwop-app/work-selection/boards/:boardId/ranking', summary: 'Ranked cards on a board with the reasons for each score.',
    table: { key: 'ranked', columns: ['rank', 'cardId', 'title', 'score'], empty: 'Nothing ranked (empty board, or no access).' } },
];

export const WORK_SELECTION_HELP = `Usage:
${routesHelp('work-selection', WORK_SELECTION_ROUTES)}
Work selection (ADR 0534). The host scores; the CLI renders.

Examples:
  openwop work-selection ranking board_1
  openwop work-selection ranking board_1 --json
`;

export async function runWorkSelection(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'work-selection', WORK_SELECTION_HELP, WORK_SELECTION_ROUTES, argv);
}

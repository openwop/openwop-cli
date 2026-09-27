import type { Ctx } from '../context.js';
/**
 * `openwop tasks ...` — the run task deck (ADR 0133): your runs and their direct
 * children bucketed by pending / running / blocked / delegated / completed /
 * failed. An anonymous caller gets an empty deck.
 */
import { formatTable } from '../io.js';
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const BUCKETS = ['pending', 'running', 'blocked', 'delegated', 'completed', 'failed'];

/** Flatten the deck's buckets into one table (the human view). */
function renderDeck(body: any): string {
  const buckets = body?.deck?.buckets ?? {};
  const rows = BUCKETS.flatMap((b) => (Array.isArray(buckets[b]) ? buckets[b] : []).map((c: any) => ({
    bucket: b, runId: c.runId ?? '', status: c.status ?? '', title: c.title ?? '',
    children: Array.isArray(c.children) ? c.children.length : 0, updatedAt: c.updatedAt ?? '',
  })));
  return rows.length ? formatTable(rows, ['bucket', 'runId', 'status', 'title', 'children', 'updatedAt']) : 'No tasks.';
}

export const TASKS_ROUTES: RouteCmd[] = [
  { words: ['deck'], method: 'GET', path: '/v1/host/openwop-app/tasks', human: renderDeck,
    summary: 'Your task deck (optionally scoped to one conversation\'s run).',
    query: [{ flag: '--conversation-run-id', key: 'conversationRunId' }] },
];

export const TASKS_HELP = `Usage:
${routesHelp('tasks', TASKS_ROUTES)}
Run task deck (ADR 0133). The human view flattens the buckets into one table.

Examples:
  openwop tasks deck
  openwop tasks deck --conversation-run-id run_1 --json
`;

export async function runTasks(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'tasks', TASKS_HELP, TASKS_ROUTES, argv);
}

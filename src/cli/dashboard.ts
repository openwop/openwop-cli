import type { Ctx } from '../context.js';
/**
 * `openwop dashboard ...` — your personal dashboard state (ADR 0375 editable
 * widgets, ADR 0577 AI briefing tile): tile layout, the pinned note, and the
 * conversation the briefing tile reads. All three are self-scoped to the calling
 * subject (401 when unauthenticated) and REPLACE on write.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const B = '/v1/host/openwop-app/dashboard';

export const DASHBOARD_ROUTES: RouteCmd[] = [
  { words: ['layout'], method: 'GET', path: `${B}/layout`, summary: 'Your tile layout (null = the frontend derives the default).',
    table: { key: 'layout.tiles', columns: ['id', 'order', 'size', 'enabled'], empty: 'No saved layout (the default is used).' } },
  { words: ['layout', 'set'], method: 'PUT', path: `${B}/layout`, summary: 'REPLACE the layout: a JSON array of {id, order, size: half|full, enabled}.',
    body: [{ flag: '--tiles', key: 'tiles', type: 'json', required: true }] },
  { words: ['note'], method: 'GET', path: `${B}/note`, summary: 'Your dashboard note.' },
  { words: ['note', 'set'], method: 'PUT', path: `${B}/note`, summary: 'Replace your note (≤ 4000 chars).',
    body: [{ flag: '--text', key: 'text' }, { flag: '--text-file', key: 'text', type: 'file' }] },
  { words: ['briefing'], method: 'GET', path: `${B}/briefing`, summary: 'Which conversation the AI briefing tile shows.' },
  { words: ['briefing', 'set'], method: 'PUT', path: `${B}/briefing`, summary: 'Point the briefing tile at a conversation.',
    body: [{ flag: '--conversation-id', key: 'conversationId', required: true }] },
];

export const DASHBOARD_HELP = `Usage:
${routesHelp('dashboard', DASHBOARD_ROUTES)}
Personal dashboard state (ADR 0375 / 0577). Everything is yours alone — no org.

Exit codes: 0 ok · 1 server error · 2 usage / validation · 4 not signed in.

Examples:
  openwop dashboard layout
  openwop dashboard layout set --tiles '[{"id":"runs","order":0,"size":"full","enabled":true}]'
  openwop dashboard note set --text "Ship the Q3 plan"
  openwop dashboard briefing set --conversation-id conv_1
`;

export async function runDashboard(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'dashboard', DASHBOARD_HELP, DASHBOARD_ROUTES, argv);
}

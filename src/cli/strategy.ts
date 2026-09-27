import type { Ctx } from '../context.js';
/** `openwop strategy ...` — strategy documents (feature: strategy). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const BASE = '/v1/host/openwop-app/strategy';

const S = `${BASE}/:id`;

/**
 * Declared strategy commands (routeKit). Checked BEFORE the hand-written switch
 * below, so `update`/`delete`/`context` here supersede the original minimal ones.
 * Paths/fields mirror features/strategy/routes.ts + strategyService.ts.
 */
export const STRATEGY_ROUTES: RouteCmd[] = [
  { words: ['update'], method: 'PATCH', path: S, summary: 'Field-level patch: each flag REPLACES that field; omitted fields are untouched (objectives/initiatives replace the whole array).',
    body: [
      { flag: '--title', key: 'title' },
      { flag: '--status', key: 'status', help: 'draft | active | paused | completed | archived' },
      { flag: '--scope', key: 'scope' },
      { flag: '--org', key: 'orgId' },
      { flag: '--planning-horizon', key: 'planningHorizon' },
      { flag: '--period', key: 'period', type: 'json' },
      { flag: '--summary', key: 'summary' },
      { flag: '--rationale', key: 'rationale' },
      { flag: '--owner-user-id', key: 'ownerUserId' },
      { flag: '--accountable-executive', key: 'accountableExecutive' },
      { flag: '--confidence', key: 'confidence' },
      { flag: '--risk', key: 'risk' },
      { flag: '--health-override', key: 'healthOverride' },
      { flag: '--parent-strategy-id', key: 'parentStrategyId' },
      { flag: '--objectives', key: 'objectives', type: 'json' },
      { flag: '--initiatives', key: 'initiatives', type: 'json' },
    ] },
  { words: ['delete'], method: 'DELETE', path: S, summary: 'Archive a strategy (soft, the default) or remove it for good with --hard.',
    query: [{ flag: '--hard', key: 'hard', type: 'boolean' }] },
  { words: ['context'], method: 'GET', path: [`${BASE}/context`, `${S}/context`],
    summary: 'Strategy context: for one strategy (<id>), or the strategies linked to --project-id | --priority-list-id [--card-id] | --board-id.',
    query: [{ flag: '--project-id', key: 'projectId' }, { flag: '--priority-list-id', key: 'priorityListId' }, { flag: '--card-id', key: 'cardId' }, { flag: '--board-id', key: 'boardId' }] },
  { words: ['timeline'], method: 'GET', path: [`${BASE}/timeline`, `${S}/timeline`], summary: 'Initiatives + milestones + idea schedules on one timeline (all readable strategies, or one).',
    table: { key: 'items', columns: ['kind', 'id', 'title', 'startDate', 'dueDate', 'status', 'overdue'], empty: 'Nothing on the timeline.' } },
  { words: ['versions'], method: 'GET', path: `${S}/versions`, summary: 'Saved revisions of a strategy.',
    table: { key: 'versions', columns: ['n', 'title', 'status', 'actor', 'createdAt'], empty: 'No versions.' } },
  { words: ['versions', 'get'], method: 'GET', path: `${S}/versions/:n`, summary: 'One revision (full snapshot).' },
  { words: ['versions', 'restore'], method: 'POST', path: `${S}/versions/:n/restore`, confirm: true, summary: 'Restore a revision\'s content (title, summary, objectives, initiatives, ...).' },
  { words: ['check-ins'], method: 'GET', path: `${S}/check-ins`, summary: 'Key-result check-ins (confirmed, and agent-proposed awaiting a decision).',
    query: [{ flag: '--kr-id', key: 'krId' }],
    table: { key: 'checkIns', columns: ['checkInId', 'krId', 'value', 'status', 'origin', 'confidence', 'createdAt'], empty: 'No check-ins.' } },
  { words: ['check-ins', 'add'], method: 'POST', path: `${S}/key-results/:krId/check-ins`, summary: 'Record a check-in on a key result (needs --value and/or --note).',
    body: [{ flag: '--value', key: 'value', type: 'number' }, { flag: '--note', key: 'note' }, { flag: '--confidence', key: 'confidence', help: 'high | medium | low' }] },
  { words: ['check-ins', 'confirm'], method: 'POST', path: `${S}/check-ins/:checkInId/confirm`, summary: 'Confirm an agent-proposed check-in (decides its approval).' },
  { words: ['check-ins', 'dismiss'], method: 'POST', path: `${S}/check-ins/:checkInId/dismiss`, summary: 'Dismiss an agent-proposed check-in.' },
  { words: ['decisions', 'record'], method: 'POST', path: `${S}/decisions`, summary: 'Record a decision as a linked decision-record document (needs the documents feature).',
    body: [{ flag: '--title', key: 'title', required: true }, { flag: '--decision', key: 'decision', required: true }, { flag: '--rationale', key: 'rationale' }, { flag: '--alternatives', key: 'alternatives' }, { flag: '--approval-id', key: 'approvalId' }] },
  { words: ['import-objectives'], method: 'POST', path: `${S}/import-objectives`, summary: 'Merge objectives + key results from CSV rows `objective,keyResult,target,unit` (header optional).',
    body: [{ flag: '--csv', key: 'csv' }, { flag: '--csv-file', key: 'csv', type: 'file' }] },
  { words: ['initiatives', 'from-idea'], method: 'POST', path: `${S}/initiatives/from-idea`, summary: 'Promote a priority-matrix idea into an initiative (links it; moves the card to done).',
    body: [{ flag: '--list-id', key: 'listId', required: true }, { flag: '--card-id', key: 'cardId', required: true }] },
  { words: ['links', 'set'], method: 'PUT', path: `${S}/links`, summary: 'REPLACE all links: a JSON array of {kind:project|priority-list|priority-idea|advisory-board|document, ...ids}.',
    body: [{ flag: '--links', key: 'links', type: 'json', required: true }] },
  { words: ['cadence'], method: 'GET', path: `${BASE}/cadence`, summary: 'Your strategy cadence config (weekly check-in, metric sync, board pack).' },
  { words: ['cadence', 'set'], method: 'PUT', path: `${BASE}/cadence`,
    rmw: { pick: (b: any) => { const c = b?.config ?? {}; const out: Record<string, unknown> = {}; for (const k of ['weeklyCheckin', 'metricSync', 'boardPack']) if (c[k] !== undefined) out[k] = c[k]; return out; } },
    summary: 'Edit the cadence. Read-modify-write: the host replaces the whole config, so entries you do not pass are kept. Each entry: {enabled, cron, timezone?, params?}.',
    body: [{ flag: '--weekly-checkin', key: 'weeklyCheckin', type: 'json' }, { flag: '--metric-sync', key: 'metricSync', type: 'json' }, { flag: '--board-pack', key: 'boardPack', type: 'json' }] },
  { words: ['reindex-kb'], method: 'POST', path: `${BASE}/reindex-kb`, summary: 'Re-index an org\'s strategies into the knowledge base.',
    body: [{ flag: '--org', key: 'orgId', required: true }] },
];

export const STRATEGY_HELP = `Usage:
  openwop strategy list [--json]
  openwop strategy get <strategyId> [--json]
  openwop strategy create --org <orgId> --title <t> [--json]
  openwop strategy health [--json]
${routesHelp('strategy', STRATEGY_ROUTES)}
Strategy documents (host-extension). \`context\`/\`health\` read the strategy context +
its health. \`create\` needs the owning --org. The host is the authority; the CLI relays.`;

export async function runStrategy(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, STRATEGY_HELP); return 0; }
  const declared = await dispatchRoutes(ctx, 'strategy', STRATEGY_ROUTES, argv);
  if (declared !== undefined) return declared;
  const args = argv.slice(['list', 'get', 'create', 'health'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help'], value: ['--org', '--title'] });
  if (options.help) { write(ctx.io.stdout, STRATEGY_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.strategies) ? res.body.strategies : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((s: any) => ({ id: s.id ?? '', title: s.title ?? '', org: s.orgId ?? '' })), ['id', 'title', 'org']) : 'No strategies.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop strategy get <strategyId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'health': writeJson(ctx.io.stdout, (await requestJson(ctx, `${BASE}/health`)).body); return 0;
    case 'create': {
      if (!options.org || !options.title) { write(ctx.io.stderr, 'strategy create needs --org and --title.\n'); return 2; }
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { orgId: String(options.org), title: String(options.title) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created strategy ${res.body?.id ?? ''} (${String(options.title)}).`); return 0;
    }
    default: throw new CliError(`Unknown strategy command: ${sub}`);
  }
}

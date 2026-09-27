import type { Ctx } from '../context.js';
/** `openwop priority-matrix ...` — prioritization lists + ideas (feature: priority-matrix). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const LISTS = '/v1/host/openwop-app/priority-matrix/lists';

const PM = '/v1/host/openwop-app/priority-matrix';
const L = `${LISTS}/:listId`;
const I = `${L}/ideas/:cardId`;
const SS = `${L}/sessions/:sessionId`;

/**
 * Declared priority-matrix commands (routeKit), checked before the hand-written
 * switch. Paths/fields mirror features/priority-matrix/routes.ts and its service
 * parsers (priorityMatrixService / intake / scenarios / federationService).
 */
export const PRIORITY_MATRIX_ROUTES: RouteCmd[] = [
  { words: ['update'], method: 'PATCH', path: L, summary: 'Merge-patch a list. Criteria / voting changes need list-config authority (creator or org manager).',
    body: [
      { flag: '--name', key: 'name' },
      { flag: '--preset-id', key: 'presetId', help: 'weighted | wsjf | rice | ice | value-effort' },
      { flag: '--criteria-set', key: 'criteriaSet', type: 'json' },
      { flag: '--voting-mode', key: 'votingMode' },
      { flag: '--vote-aggregation', key: 'voteAggregation' },
      { flag: '--voter-weights', key: 'voterWeights', type: 'json' },
    ] },
  { words: ['ideas'], method: 'GET', path: `${L}/ideas`, summary: 'Ranked ideas in a list.',
    table: { key: 'ideas', columns: ['rank', 'card.id', 'card.title', 'status.columnName', 'computedPriority', 'completeness'], empty: 'No ideas.' } },
  { words: ['ideas', 'add'], method: 'POST', path: `${L}/ideas`, summary: 'Add an idea (lands in the "new" column).',
    body: [{ flag: '--title', key: 'title', required: true }, { flag: '--description', key: 'description' }] },
  { words: ['ideas', 'update'], method: 'PATCH', path: I, summary: 'Edit an idea\'s title / description ("" clears the description).',
    body: [{ flag: '--title', key: 'title' }, { flag: '--description', key: 'description' }] },
  { words: ['ideas', 'delete'], method: 'DELETE', path: I, summary: 'Delete an idea.' },
  { words: ['ideas', 'clone'], method: 'POST', path: `${I}/clone`, summary: 'Clone an idea (title defaults to "<title> (copy)").', body: [{ flag: '--title', key: 'title' }] },
  { words: ['ideas', 'merge'], method: 'POST', path: `${I}/merge`, summary: 'Merge a duplicate into this (canonical) idea; the duplicate is cancelled.',
    body: [{ flag: '--duplicate-card-id', key: 'duplicateCardId', required: true }] },
  { words: ['ideas', 'promote'], method: 'POST', path: `${I}/promote-to-project`, summary: 'Promote an idea to a new project (moves the card to done).' },
  { words: ['ideas', 'status'], method: 'PATCH', path: `${I}/status`, summary: 'Move an idea to a board column.', body: [{ flag: '--column-id', key: 'columnId', required: true }] },
  { words: ['ideas', 'score'], method: 'PUT', path: `${I}/scores`, summary: 'Score an idea. REPLACES the scores: criteria you omit are cleared (multi-voter lists write your own vote).',
    body: [{ flag: '--score', key: 'scores', type: 'map', required: true, help: 'criterionId=1..10, repeatable' }] },
  { words: ['ideas', 'score-history'], method: 'GET', path: `${I}/score-history`, summary: 'Score changes + the per-criterion breakdown.',
    table: { key: 'history', columns: ['changeId', 'priorPriority', 'newPriority', 'actor', 'source', 'createdAt'], empty: 'No score history.' } },
  { words: ['ideas', 'votes'], method: 'GET', path: `${I}/votes`, summary: 'Per-voter scores on a multi-voter list (list-config authority).',
    table: { key: 'votes', columns: ['voterId', 'scores', 'source', 'updatedAt'], empty: 'No votes.' } },
  { words: ['ideas', 'intake'], method: 'GET', path: `${I}/intake`, summary: 'Intake details + evidence links for an idea.' },
  { words: ['ideas', 'intake', 'set'], method: 'PATCH', path: `${I}/intake`, summary: 'Merge-patch intake details ("" clears a text field).',
    body: [
      { flag: '--requester', key: 'requester' },
      { flag: '--source-channel', key: 'sourceChannel', help: 'form | chat | api | manual' },
      { flag: '--estimated-value', key: 'estimatedValue', type: 'number' },
      { flag: '--estimated-value-unit', key: 'estimatedValueUnit' },
      { flag: '--notes', key: 'notes' },
      { flag: '--source-submission-id', key: 'sourceSubmissionId' },
    ] },
  { words: ['ideas', 'evidence', 'add'], method: 'POST', path: `${I}/evidence`, summary: 'Link evidence (document | kb | url) to an idea.',
    body: [{ flag: '--kind', key: 'kind', required: true }, { flag: '--ref', key: 'ref', required: true }, { flag: '--label', key: 'label' }] },
  { words: ['ideas', 'evidence', 'remove'], method: 'DELETE', path: `${I}/evidence/:evidenceId`, summary: 'Remove an evidence link.' },
  { words: ['ideas', 'schedule', 'set'], method: 'PUT', path: `${I}/schedule`, summary: 'Set an idea\'s target (and optional start) date — replaces the schedule.',
    body: [{ flag: '--target-date', key: 'targetDate', required: true }, { flag: '--start-date', key: 'startDate' }] },
  { words: ['ideas', 'schedule', 'clear'], method: 'DELETE', path: `${I}/schedule`, summary: 'Clear an idea\'s schedule.' },
  { words: ['schedule'], method: 'GET', path: `${L}/schedule`, summary: 'Delivery schedule for every idea + a rollup (on-track / at-risk / behind ...).',
    table: { key: 'ideas', columns: ['cardId', 'title', 'status', 'state', 'targetDate', 'dueInDays', 'overdueByDays'], empty: 'No ideas.' } },
  { words: ['sessions'], method: 'GET', path: `${L}/sessions`, summary: 'Planning sessions for a list.',
    table: { key: 'sessions', columns: ['id', 'name', 'selection.mode', 'createdBy', 'createdAt'], empty: 'No planning sessions.' } },
  { words: ['sessions', 'create'], method: 'POST', path: `${L}/sessions`, summary: 'Start a planning session (top-n | manual | both selection; writes an agenda document when documents is on).',
    body: [
      { flag: '--name', key: 'name' }, { flag: '--mode', key: 'mode' }, { flag: '--n', key: 'n', type: 'number' },
      { flag: '--card-ids', key: 'cardIds', type: 'csv' }, { flag: '--sort', key: 'sort' }, { flag: '--sort-dir', key: 'sortDir' }, { flag: '--rationale', key: 'rationale' },
    ] },
  { words: ['sessions', 'update'], method: 'PATCH', path: SS, summary: 'Re-sort a session\'s agenda or edit its rationale.',
    body: [{ flag: '--sort', key: 'sort' }, { flag: '--sort-dir', key: 'sortDir' }, { flag: '--rationale', key: 'rationale' }] },
  { words: ['scenarios'], method: 'GET', path: `${SS}/scenarios`, summary: 'What-if scenarios in a session (above / below the line).',
    table: { key: 'scenarios', columns: ['scenarioId', 'name', 'totalEstimatedValue', 'planOfRecord', 'approvalStatus', 'proposedBy'], empty: 'No scenarios.' } },
  { words: ['scenarios', 'create'], method: 'POST', path: `${SS}/scenarios`, summary: 'Add a scenario: --mode top-n --n <k>, or --mode manual --card-ids a,b; optional --max-items / --max-budget.',
    body: [
      { flag: '--name', key: 'name', required: true },
      { flag: '--mode', key: 'selection.mode' }, { flag: '--n', key: 'selection.n', type: 'number' }, { flag: '--card-ids', key: 'selection.cardIds', type: 'csv' },
      { flag: '--max-items', key: 'constraints.maxItems', type: 'number' }, { flag: '--max-budget', key: 'constraints.maxBudget', type: 'number' },
    ] },
  { words: ['scenarios', 'compare'], method: 'GET', path: `${SS}/scenarios/compare`, summary: 'Diff two scenarios (what B gains / drops vs A).',
    query: [{ flag: '--a', key: 'a', required: true }, { flag: '--b', key: 'b', required: true }] },
  { words: ['scenarios', 'select'], method: 'POST', path: `${SS}/scenarios/:scenarioId/select`, summary: 'Make a scenario the plan of record (an agent-proposed one is decided through its approval).' },
  { words: ['scenarios', 'reject'], method: 'POST', path: `${SS}/scenarios/:scenarioId/reject`, summary: 'Reject an agent-proposed scenario.' },
  { words: ['portfolio'], method: 'GET', path: `${PM}/portfolio`, summary: 'Top ideas across every list you can read.',
    query: [{ flag: '--org', key: 'orgId' }, { flag: '--top-n', key: 'topN', type: 'number' }, { flag: '--normalize', key: 'normalize', help: 'none | list-relative | percentile' }],
    table: { key: 'items', columns: ['listName', 'title', 'status', 'computedPriority', 'normalizedPriority', 'inListRank'], empty: 'No ideas.' } },
  { words: ['portfolio', 'federated'], method: 'GET', path: `${PM}/portfolio/federated`, summary: 'Portfolio merged with every federated peer host (each peer fails soft).',
    query: [{ flag: '--top-n', key: 'topN', type: 'number' }],
    table: { key: 'items', columns: ['source', 'listName', 'title', 'computedPriority', 'inListRank'], empty: 'No ideas.' } },
  { words: ['presets'], method: 'GET', path: `${PM}/presets`, summary: 'Built-in scoring presets (weighted, WSJF, RICE, ICE, value-effort).',
    table: { key: 'presets', columns: ['presetId', 'aggregation', 'criteria'], empty: 'No presets.' } },
  { words: ['peers'], method: 'GET', path: `${PM}/peers`, summary: 'Federated peer hosts.',
    table: { key: 'peers', columns: ['id', 'label', 'baseUrl', 'createdBy', 'createdAt'], empty: 'No peers.' } },
  { words: ['peers', 'add'], method: 'POST', path: `${PM}/peers`, summary: 'Add a federated peer (https only; superadmin).',
    body: [{ flag: '--label', key: 'label', required: true }, { flag: '--peer-url', key: 'baseUrl', required: true, help: 'sent as baseUrl (--base-url is the global host flag)' }] },
  { words: ['peers', 'remove'], method: 'DELETE', path: `${PM}/peers/:peerId`, summary: 'Remove a peer and its shared credential (superadmin).' },
  { words: ['peers', 'credential'], method: 'PUT', path: `${PM}/peers/:peerId/credential`,
    summary: 'Store the bearer for a peer (sealed host-side, never echoed). Read from a file so it never lands in shell history. --scope tenant (superadmin) | user.',
    body: [{ flag: '--token-file', key: 'token', type: 'file', required: true }, { flag: '--scope', key: 'scope' }] },
  { words: ['reindex-kb'], method: 'POST', path: `${PM}/reindex-kb`, summary: 'Re-index an org\'s priority lists into the knowledge base.',
    body: [{ flag: '--org', key: 'orgId', required: true }] },
];

export const PRIORITY_MATRIX_HELP = `Usage:
  openwop priority-matrix lists [--json]
  openwop priority-matrix get <listId> [--json]
  openwop priority-matrix create --org <orgId> --name <n> [--json]
  openwop priority-matrix delete <listId> [--yes]
${routesHelp('priority-matrix', PRIORITY_MATRIX_ROUTES)}
Prioritization boards (host-extension). A list holds scored/voted ideas; \`ideas\` reads
a list's ideas. \`create\` needs the owning --org. The host is the authority.`;

export async function runPriorityMatrix(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'lists';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PRIORITY_MATRIX_HELP); return 0; }
  const declared = await dispatchRoutes(ctx, 'priority-matrix', PRIORITY_MATRIX_ROUTES, argv);
  if (declared !== undefined) return declared;
  const args = argv.slice(['lists', 'get', 'create', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name'] });
  if (options.help) { write(ctx.io.stdout, PRIORITY_MATRIX_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'lists': {
      const res = await requestJson(ctx, LISTS);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.lists) ? res.body.lists : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((l: any) => ({ id: l.id ?? l.listId ?? '', name: l.name ?? '', ideas: l.ideaCount ?? '' })), ['id', 'name', 'ideas']) : 'No lists.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop priority-matrix get <listId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${LISTS}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.org || !options.name) { write(ctx.io.stderr, 'priority-matrix create needs --org and --name.\n'); return 2; }
      const res = await requestJson(ctx, LISTS, { method: 'POST', body: { orgId: String(options.org), name: String(options.name) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created list ${res.body?.id ?? ''} (${String(options.name)}).`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop priority-matrix delete <listId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete list ${id} without --yes.`, 2);
      await requestJson(ctx, `${LISTS}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted list ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown priority-matrix command: ${sub}`);
  }
}

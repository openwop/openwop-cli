import type { Ctx } from '../context.js';
/**
 * `openwop intent-ledger ...` — a conversation's intent ledger (ADR 0136): the
 * goal, the allowed / forbidden / approval-gated tools, and the success criteria
 * a user signs off before an agent acts; plus the reckoning of what runs actually
 * did against it. You must be able to see the conversation (404) and own it to
 * write (403).
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const C = '/v1/host/openwop-app/intent-ledger/conversations/:conversationId';

export const INTENT_LEDGER_ROUTES: RouteCmd[] = [
  { words: ['draft'], method: 'POST', path: `${C}/draft`, summary: 'Draft (or REPLACE) the ledger: a new draft the user then approves.',
    body: [
      { flag: '--goal', key: 'goal', required: true },
      { flag: '--allowed', key: 'allowed', type: 'csv' },
      { flag: '--forbidden', key: 'forbidden', type: 'csv' },
      { flag: '--require-approval', key: 'requireApproval', type: 'csv' },
      { flag: '--success-criterion', key: 'successCriteria', type: 'list' },
      { flag: '--expires-at-rel-ms', key: 'expiresAtRelMs', type: 'number' },
    ] },
  { words: ['approve'], method: 'POST', path: `${C}/approve`, summary: 'Approve the drafted ledger (you become approvedBy).' },
  { words: ['reject'], method: 'POST', path: `${C}/reject`, summary: 'Reject the drafted ledger.' },
  { words: ['reckoning'], method: 'GET', path: `${C}/reckoning`, summary: 'What runs did vs. the mandate: used / blocked tools, within-mandate verdict (null before any stamped run).' },
];

export const INTENT_LEDGER_HELP = `Usage:
${routesHelp('intent-ledger', INTENT_LEDGER_ROUTES)}
Intent ledger (ADR 0136). The host enforces the ledger at tool-call time; the CLI
only records your intent and reads the host's reckoning.

Exit codes: 0 ok · 1 server error · 2 usage / not found · 4 not signed in or not the owner.

Examples:
  openwop intent-ledger draft conv_1 --goal "Book travel" --allowed travel.search,travel.book --require-approval travel.book
  openwop intent-ledger approve conv_1
  openwop intent-ledger reckoning conv_1 --json
`;

export async function runIntentLedger(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'intent-ledger', INTENT_LEDGER_HELP, INTENT_LEDGER_ROUTES, argv);
}

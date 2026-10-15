import type { Ctx } from '../context.js';
/**
 * `openwop intent-ledger ...` — a conversation's intent ledger (ADR 0136): the
 * goal, the allowed / forbidden / approval-gated tools, and the success criteria
 * a user signs off before an agent acts; plus the reckoning of what runs actually
 * did against it. You must be able to see the conversation (404) and own it to
 * write (403).
 *
 * `approve` / `reject` are DECISIONS (openwop-app ADR 0896): the host requires the
 * `{ ledgerId, revision, digest }` of the contract the person reviewed, so an
 * approve can never land on text the chat agent rewrote after you looked. The CLI
 * therefore reads the ledger, prints the contract, and only decides with `--yes`
 * plus the `--digest` it printed (a host that predates ADR 0896 returns no digest;
 * then `--yes` alone decides, and the extra body fields are ignored by it).
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeJson, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { hostError, routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const C = '/v1/host/openwop-app/intent-ledger/conversations/:conversationId';

export const INTENT_LEDGER_ROUTES: RouteCmd[] = [
  { words: ['draft'], method: 'POST', path: `${C}/draft`, summary: 'Draft the ledger (replaces a draft; an approved mission must be rejected first): a new draft the user then approves.',
    body: [
      { flag: '--goal', key: 'goal', required: true },
      { flag: '--allowed', key: 'allowed', type: 'csv' },
      { flag: '--forbidden', key: 'forbidden', type: 'csv' },
      { flag: '--require-approval', key: 'requireApproval', type: 'csv' },
      { flag: '--success-criterion', key: 'successCriteria', type: 'list' },
      { flag: '--expires-at-rel-ms', key: 'expiresAtRelMs', type: 'number' },
    ] },
  { words: ['reckoning'], method: 'GET', path: `${C}/reckoning`, summary: 'What runs did vs. the mandate: used / blocked tools, within-mandate verdict (null before any stamped run).' },
];

export const INTENT_LEDGER_HELP = `Usage:
${routesHelp('intent-ledger', INTENT_LEDGER_ROUTES)}
Decisions (read, review, then decide exactly what you reviewed — openwop-app ADR 0896):
  openwop intent-ledger approve <conversationId> [--yes --digest <digest>] [--json]
  openwop intent-ledger reject <conversationId> [--yes --digest <digest>] [--json]
      Prints the contract; with --yes and the printed --digest, approves (or
      rejects/revokes) exactly that version. POST ${C}/approve|reject

Intent ledger (ADR 0136). The host enforces the ledger at tool-call time; the CLI
only records your intent and reads the host's reckoning.

Exit codes: 0 ok · 1 server error · 2 usage / not found · 4 not signed in or not the owner.

Examples:
  openwop intent-ledger draft conv_1 --goal "Book travel" --allowed travel.search,travel.book --require-approval travel.book
  openwop intent-ledger approve conv_1                      # prints the contract + its digest
  openwop intent-ledger approve conv_1 --yes --digest sha256:…
  openwop intent-ledger reckoning conv_1 --json
`;

interface Ledger {
  ledgerId?: string; revision?: number; digest?: string; status?: string; goal?: string;
  allowed?: string[]; forbidden?: string[]; requireApproval?: string[]; successCriteria?: string[]; expiresAtRelMs?: number;
}

function contractLines(l: Ledger): string[] {
  const list = (xs: string[] | undefined): string => (xs && xs.length ? xs.join(', ') : '(none)');
  return [
    `Mission ${l.ledgerId ?? '?'} — ${l.status ?? '?'}${l.revision !== undefined ? ` (revision ${l.revision})` : ''}`,
    `  goal:             ${l.goal ?? ''}`,
    `  allowed:          ${l.allowed && l.allowed.length ? l.allowed.join(', ') : '(none — the agent may talk but not act)'}`,
    `  forbidden:        ${list(l.forbidden)}`,
    `  needs approval:   ${list(l.requireApproval)}`,
    `  success criteria: ${list(l.successCriteria)}`,
    ...(l.expiresAtRelMs !== undefined ? [`  ends:             ${Math.round(l.expiresAtRelMs / 60000)} min after the agent starts working under it`] : []),
    ...(l.digest ? [`  digest:           ${l.digest}`] : []),
  ];
}

/** ADR 0896 — read, show, then decide exactly the version shown. */
async function decide(ctx: Ctx, verb: 'approve' | 'reject', argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--yes', '-y', '--json', '--help', '-h'], value: ['--digest'] });
  if (options.help || options.h) { write(ctx.io.stdout, INTENT_LEDGER_HELP); return 0; }
  const conversationId = positionals[0];
  if (!conversationId || positionals.length > 1) throw new CliError(`Usage: openwop intent-ledger ${verb} <conversationId> [--yes --digest <digest>]`, 2);
  const path = C.replace(':conversationId', encodeURIComponent(conversationId));
  try {
    const got = await requestJson(ctx, path);
    const ledger = (got.body as { ledger?: Ledger | null } | null)?.ledger ?? null;
    if (!ledger) throw new CliError(`No mission ledger on conversation ${conversationId}.`, 2);
    if (!options.yes && !options.y) {
      if (options.json) writeJson(ctx.io.stdout, got.body);
      else for (const line of contractLines(ledger)) writeLine(ctx.io.stdout, line);
      writeLine(ctx.io.stderr, `Review the contract above, then re-run: openwop intent-ledger ${verb} ${conversationId} --yes${ledger.digest ? ` --digest ${ledger.digest}` : ''}`);
      return 2;
    }
    if (ledger.digest) {
      if (!options.digest) {
        for (const line of contractLines(ledger)) writeLine(ctx.io.stderr, line);
        throw new CliError(`Pass --digest ${ledger.digest} to ${verb} exactly this contract.`, 2);
      }
      if (options.digest !== ledger.digest) {
        for (const line of contractLines(ledger)) writeLine(ctx.io.stderr, line);
        throw new CliError(`The mission changed since you reviewed it (digest ${options.digest} → ${ledger.digest}). Review the version above and re-run with its digest.`, 2);
      }
    }
    const body: Record<string, unknown> = {};
    if (ledger.ledgerId !== undefined) body.ledgerId = ledger.ledgerId;
    if (ledger.revision !== undefined) body.revision = ledger.revision;
    if (ledger.digest !== undefined) body.digest = ledger.digest;
    const res = await requestJson(ctx, `${path}/${verb}`, { method: 'POST', body });
    if (options.json) writeJson(ctx.io.stdout, res.body);
    else {
      const out = (res.body as { ledger?: Ledger } | null)?.ledger;
      writeLine(ctx.io.stdout, `Mission ${out?.ledgerId ?? ledger.ledgerId ?? ''} ${out?.status ?? (verb === 'approve' ? 'approved' : 'rejected')}.`);
    }
    return 0;
  } catch (err) {
    if (err instanceof HttpError) throw hostError(err);
    throw err;
  }
}

export async function runIntentLedger(ctx: Ctx, argv: string[]) {
  if (argv[0] === 'approve' || argv[0] === 'reject') return decide(ctx, argv[0], argv.slice(1));
  return runRouteGroup(ctx, 'intent-ledger', INTENT_LEDGER_HELP, INTENT_LEDGER_ROUTES, argv);
}

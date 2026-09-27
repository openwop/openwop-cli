import type { Ctx } from '../context.js';
/** `openwop reviews ...` — the unified review inbox (quorum voting, ADR 0068 / RFC 0070). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { parseJsonFlag } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/reviews';

export const REVIEWS_HELP = `Usage:
  openwop reviews list [--status <s>] [--conversation <id>] [--board <id>] [--json]
  openwop reviews get <reviewId> [--json]
  openwop reviews action <reviewId> <action> [--note <t>] [--value-json '{...}'] [--expected-hash <h>] [--json]

The unified review inbox (ADR 0068 / RFC 0070) — one projection over run
interrupts and pending approvals (host-extension, /v1/host/openwop-app/reviews):

  list    GET  /v1/host/openwop-app/reviews[?status=&conversationId=&boardId=]
          (--status: pending | approved | rejected | expired | cancelled | resolved;
          omitted = the pending inbox)
  get     GET  /v1/host/openwop-app/reviews/{reviewId}
  action  POST /v1/host/openwop-app/reviews/{reviewId}/actions/{action}
          <action> must be one the review offers (see 'get' → actions[]); an
          approval review takes approve | reject (--note, --expected-hash); an
          interrupt review takes 'resolve' with --value-json as the resume value,
          or an approval-gate verb whose extra fields ride --value-json.

The host is the authority (a review you cannot see is a 404, never a 403); the
CLI renders its view and relays the action. Exit: 0 approved/resolved ·
3 pending · 1 rejected/error.`;

export async function runReviews(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, REVIEWS_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'action'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help'], value: ['--status', '--note', '--conversation', '--board', '--value-json', '--expected-hash'] });
  if (options.help) { write(ctx.io.stdout, REVIEWS_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const query = new URLSearchParams();
      if (options.status) query.set('status', String(options.status));
      if (options.conversation) query.set('conversationId', String(options.conversation));
      if (options.board) query.set('boardId', String(options.board));
      const q = query.toString() ? `?${query}` : '';
      const res = await requestJson(ctx, `${BASE}${q}`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      // The host answers { items }; older builds answered { reviews }.
      const items = Array.isArray(res.body?.items) ? res.body.items : Array.isArray(res.body?.reviews) ? res.body.reviews : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No reviews.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((r: any) => ({ id: r.reviewId ?? r.id ?? '', status: r.status ?? '', source: r.source ?? '', kind: r.kind ?? '', title: (r.title ?? '').slice(0, 50), actions: Array.isArray(r.actions) ? r.actions.map((a: any) => a.action ?? a).join(',') : '' })), ['id', 'status', 'source', 'kind', 'title', 'actions']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop reviews get <reviewId>\n'); return 2; }
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeJson(ctx.io.stdout, res.body);
      const st = res.body?.status;
      return st === 'approved' || st === 'resolved' ? 0 : st === 'rejected' ? 1 : 3;
    }
    case 'action': {
      if (positionals.length !== 2) { write(ctx.io.stderr, 'Usage: openwop reviews action <reviewId> <action> [--note <t>] [--json]\n'); return 2; }
      const body: Record<string, unknown> = {};
      if (options.note) body.note = String(options.note);
      if (options.valueJson !== undefined) body.value = parseJsonFlag('--value-json', options.valueJson);
      if (options.expectedHash) body.expectedDefinitionHash = String(options.expectedHash);
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}/actions/${encodeURIComponent(positionals[1])}`, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body);
      else writeLine(ctx.io.stdout, `Applied action '${positionals[1]}' to review ${positionals[0]}${res.body?.status ? ` → ${res.body.status}` : ''}${res.body?.runId ? ` (run ${res.body.runId})` : ''}.`);
      const st = res.body?.status;
      return st === 'rejected' ? 1 : st === 'pending' ? 3 : 0;
    }
    default: throw new CliError(`Unknown reviews command: ${sub}\nRun \`openwop reviews --help\` for usage.`);
  }
}

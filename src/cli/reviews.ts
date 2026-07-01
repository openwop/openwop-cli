import type { Ctx } from '../context.js';
/** `openwop reviews ...` — the unified review inbox (quorum voting, ADR 0068 / RFC 0070). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/reviews';

export const REVIEWS_HELP = `Usage:
  openwop reviews list [--status <s>] [--json]
  openwop reviews get <reviewId> [--json]
  openwop reviews action <reviewId> <action> [--note <t>] [--json]

The unified review inbox (ADR 0068 / RFC 0070). Reviewers act on a review via a named
<action> (e.g. approve | reject | comment) that the host defines + quorums. The host is
the authority; the CLI renders its resolved view and relays the action. Exit: 0 resolved
· 3 pending · 1 rejected/error.`;

export async function runReviews(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, REVIEWS_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'action'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help'], value: ['--status', '--note'] });
  if (options.help) { write(ctx.io.stdout, REVIEWS_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const q = options.status ? `?status=${encodeURIComponent(String(options.status))}` : '';
      const res = await requestJson(ctx, `${BASE}${q}`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.reviews) ? res.body.reviews : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No reviews.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((r: any) => ({ id: r.reviewId ?? r.id ?? '', status: r.status ?? '', kind: r.kind ?? '', title: (r.title ?? '').slice(0, 50) })), ['id', 'status', 'kind', 'title']));
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
      const body = options.note ? { note: String(options.note) } : {};
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}/actions/${encodeURIComponent(positionals[1])}`, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Applied action '${positionals[1]}' to review ${positionals[0]}.`);
      return 0;
    }
    default: throw new CliError(`Unknown reviews command: ${sub}\nRun \`openwop reviews --help\` for usage.`);
  }
}

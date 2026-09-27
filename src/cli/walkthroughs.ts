import type { Ctx } from '../context.js';
/**
 * `openwop walkthroughs ...` — product walkthrough progress + the run-derived
 * funnel (feature: walkthroughs, ADR 0368 / ADR 0378 P3).
 *
 * Hits `/v1/host/openwop-app/walkthroughs/{progress,funnel}` (host-extension,
 * toggle-gated by `walkthroughs`). Progress is per-caller and server-stamped;
 * the funnel is a tenant-wide aggregate that needs workspace read scope.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { renderDone, renderList, withQuery } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/walkthroughs';

export const WALKTHROUGHS_HELP = `Usage:
  openwop walkthroughs progress [--json]
  openwop walkthroughs progress set <walkthroughId> --status started|completed --run <runId> [--json]
  openwop walkthroughs funnel <walkthroughId> [--json]

\`progress\` reads your walkthrough progress (GET ${BASE}/progress); \`progress set\`
records one (POST ${BASE}/progress, body { walkthroughId, status, runId }).
\`funnel\` shows run-status counts + where runs stalled for one walkthrough
(GET ${BASE}/funnel?walkthroughId=…) — a recent-window view over the newest runs.

Exit codes: 0 ok · 2 usage / validation / feature off · 4 forbidden.

Examples:
  openwop walkthroughs progress
  openwop walkthroughs progress set campaign-studio --status completed --run run_123
  openwop walkthroughs funnel campaign-studio --json
`;

export async function runWalkthroughs(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'progress';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, WALKTHROUGHS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--status', '--run'] });
  if (options.help) { write(ctx.io.stdout, WALKTHROUGHS_HELP); return 0; }
  switch (sub) {
    case 'progress': {
      if (positionals[0] === 'set') {
        const walkthroughId = positionals[1];
        if (!walkthroughId || (options.status !== 'started' && options.status !== 'completed') || !options.run) {
          write(ctx.io.stderr, 'Usage: openwop walkthroughs progress set <walkthroughId> --status started|completed --run <runId>\n');
          return 2;
        }
        const res = await requestJson(ctx, `${BASE}/progress`, { method: 'POST', body: { walkthroughId, status: String(options.status), runId: String(options.run) } });
        return renderDone(ctx, res.body, `Recorded ${walkthroughId} as ${String(options.status)}.`);
      }
      const res = await requestJson(ctx, `${BASE}/progress`);
      const items = Array.isArray(res.body?.progress) ? res.body.progress : [];
      return renderList(ctx, res.body, items, ['walkthroughId', 'status', 'runId', 'updatedAt'], 'No walkthrough progress.');
    }
    case 'funnel': {
      const walkthroughId = positionals[0];
      if (!walkthroughId) { write(ctx.io.stderr, 'Usage: openwop walkthroughs funnel <walkthroughId>\n'); return 2; }
      const res = await requestJson(ctx, withQuery(`${BASE}/funnel`, { walkthroughId }));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const b = res.body ?? {};
      const rows = Object.entries(b)
        .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
        .map(([field, value]) => ({ field, value: String(value) }));
      writeLine(ctx.io.stdout, formatTable(rows, ['field', 'value']));
      if (b.stalledByNode && typeof b.stalledByNode === 'object' && Object.keys(b.stalledByNode).length > 0) {
        writeLine(ctx.io.stdout, '');
        writeLine(ctx.io.stdout, formatTable(Object.entries(b.stalledByNode).map(([node, count]) => ({ stalledAt: node, runs: String(count) })), ['stalledAt', 'runs']));
      }
      return 0;
    }
    default: throw new CliError(`Unknown walkthroughs command: ${sub}\nRun \`openwop walkthroughs --help\` for usage.`);
  }
}

import type { Ctx } from '../context.js';
/**
 * `openwop widgets ...` — the reference host-extension vertical slice
 * (white-label PRD §4; HOST-EXTENSIONS.md; src/host/examples/widgetService.ts).
 *
 * Hits `/v1/host/openwop-app/widgets*`. ENV-GATED on the host
 * (`OPENWOP_EXAMPLE_WIDGETS_ENABLED=true`) — a host without it 404s every route,
 * which this group reports as "not enabled on this host". A conflicting mutation
 * (e.g. archiving an archived widget) is a 409 with `details.reason`.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeJson, writeLine, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, renderDone, renderList } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/widgets';

export const WIDGETS_HELP = `Usage:
  openwop widgets list [--json]
  openwop widgets summary [--json]
  openwop widgets create --name <name> [--json]
  openwop widgets archive <widgetId> [--json]
  openwop widgets seed [--json]

The reference example domain (GET/POST ${BASE}, GET ${BASE}/summary,
POST ${BASE}/<id>/archive, POST ${BASE}/seed). Mounted only when the host sets
OPENWOP_EXAMPLE_WIDGETS_ENABLED=true. \`seed\` is idempotent (\`seeded: false\` on a
re-run). Archiving an already-archived widget is a conflict (exit 2), never a
silent success.

Exit codes: 0 ok · 2 usage / conflict / not enabled · 4 forbidden.

Examples:
  openwop widgets seed
  openwop widgets create --name "Blue widget"
  openwop widgets archive w_123 --json
`;

export async function runWidgets(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, WIDGETS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--name'] });
  if (options.help) { write(ctx.io.stdout, WIDGETS_HELP); return 0; }
  try {
    switch (sub) {
      case 'list': {
        const res = await requestJson(ctx, BASE);
        const items = Array.isArray(res.body?.widgets) ? res.body.widgets : [];
        return renderList(ctx, res.body, items, ['id', 'name', 'status'], 'No widgets.');
      }
      case 'summary': {
        const res = await requestJson(ctx, `${BASE}/summary`);
        if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
        const rows = Object.entries(res.body ?? {}).map(([field, value]) => ({ field, value: typeof value === 'object' ? JSON.stringify(value) : String(value) }));
        writeLine(ctx.io.stdout, formatTable(rows, ['field', 'value']));
        return 0;
      }
      case 'create': {
        if (!options.name) { write(ctx.io.stderr, 'widgets create needs --name.\n'); return 2; }
        const res = await requestJson(ctx, BASE, { method: 'POST', body: { name: String(options.name) } });
        return renderDone(ctx, res.body, `Created widget ${res.body?.id ?? ''} (${String(options.name)}).`);
      }
      case 'archive': {
        const id = positionals[0];
        if (!id) { write(ctx.io.stderr, 'Usage: openwop widgets archive <widgetId>\n'); return 2; }
        const res = await requestJson(ctx, `${BASE}/${enc(id)}/archive`, { method: 'POST', body: {} });
        return renderDone(ctx, res.body, `Archived widget ${id}.`);
      }
      case 'seed': {
        const res = await requestJson(ctx, `${BASE}/seed`, { method: 'POST', body: {} });
        return renderDone(ctx, res.body, res.body?.seeded === false ? 'Example widgets already seeded (no-op).' : 'Seeded example widgets.');
      }
      default: throw new CliError(`Unknown widgets command: ${sub}\nRun \`openwop widgets --help\` for usage.`);
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      const reason = (err.body as { details?: { reason?: string } } | null)?.details?.reason;
      throw new CliError(`Conflict: the widget is not in a state that allows this${reason ? ` (${reason})` : ''}.`, 2);
    }
    if (err instanceof HttpError && err.status === 404 && sub !== 'archive') {
      throw new CliError('The widgets example domain is not enabled on this host (OPENWOP_EXAMPLE_WIDGETS_ENABLED).', 2);
    }
    throw err;
  }
}

import type { Ctx } from '../context.js';
/** `openwop advisors ...` — advisory boards (feature: advisory-board). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const BOARDS = '/v1/host/openwop-app/advisors/boards';

/** Board strategy preview (ADR 0079 P5) + shared planning knowledge (ADR 0100 D2 / ADR 0277). */
export const ADVISORS_ROUTES: RouteCmd[] = [
  { words: ['strategy-context'], method: 'GET', path: `${BOARDS}/:boardId/strategy-context`, summary: 'Preview the strategy context the board would convene with.' },
  { words: ['shared-knowledge'], method: 'GET', path: `${BOARDS}/:boardId/shared-knowledge`, summary: 'Which planning knowledge kinds are shared with every advisor on the board.',
    table: { key: 'items', columns: ['kind', 'shared', 'shareable', 'count'], empty: 'No shareable knowledge.' } },
  { words: ['shared-knowledge', 'set'], method: 'POST', path: `${BOARDS}/:boardId/shared-knowledge`, summary: 'Share (--shared) or unshare (--no-shared) one knowledge kind with all advisors.',
    body: [{ flag: '--kind', key: 'kind', required: true }, { flag: '--shared', key: 'shared', type: 'boolean', required: true }] },
];

export const ADVISORS_HELP = `Usage:
  openwop advisors list [--json]
  openwop advisors get <boardId> [--json]
  openwop advisors by-handle <handle> [--json]
  openwop advisors create --org <orgId> --name <n> [--handle <h>] [--json]
  openwop advisors delete <boardId> [--yes]

Advisory boards (host-extension) — a panel of advisor agents. \`create\` needs the
owning --org. The host is the authority; the CLI mirrors + relays.

${routesHelp('advisors', ADVISORS_ROUTES)}
`;

export async function runAdvisors(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, ADVISORS_HELP); return 0; }
  const ext = await dispatchRoutes(ctx, 'advisors', ADVISORS_ROUTES, argv);
  if (ext !== undefined) return ext;
  const args = argv.slice(['list', 'get', 'by-handle', 'create', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name', '--handle'] });
  if (options.help) { write(ctx.io.stdout, ADVISORS_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BOARDS);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.boards) ? res.body.boards : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((b: any) => ({ id: b.id ?? b.boardId ?? '', name: b.name ?? '', handle: b.handle ?? '' })), ['id', 'name', 'handle']) : 'No advisory boards.');
      return 0;
    }
    case 'get': { if (!id) { write(ctx.io.stderr, 'Usage: openwop advisors get <boardId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BOARDS}/${encodeURIComponent(id)}`)).body); return 0; }
    case 'by-handle': { if (!id) { write(ctx.io.stderr, 'Usage: openwop advisors by-handle <handle>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, `${BOARDS}/by-handle/${encodeURIComponent(id)}`)).body); return 0; }
    case 'create': {
      if (!options.org || !options.name) { write(ctx.io.stderr, 'advisors create needs --org and --name.\n'); return 2; }
      const body: Record<string, string> = { orgId: String(options.org), name: String(options.name) };
      if (options.handle) body.handle = String(options.handle);
      const res = await requestJson(ctx, BOARDS, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created advisory board ${res.body?.id ?? ''} (${String(options.name)}).`); return 0;
    }
    case 'delete': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop advisors delete <boardId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete advisory board ${id} without --yes.`, 2);
      await requestJson(ctx, `${BOARDS}/${encodeURIComponent(id)}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Deleted advisory board ${id}.`); return 0;
    }
    default: throw new CliError(`Unknown advisors command: ${sub}`);
  }
}

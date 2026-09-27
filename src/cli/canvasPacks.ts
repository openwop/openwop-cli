import type { Ctx } from '../context.js';
/**
 * `openwop canvas-packs ...` — canvas types contributed by installed
 * artifact-type packs (ADR 0314 Documents creation gallery).
 *
 * Hits `GET /v1/host/openwop-app/canvas-packs/orgs/<orgId>/types` (host-extension,
 * gated by the `canvas-packs` toggle + workspace read scope). Only pack-owned
 * types with an editor are listed.
 */
import { CliError } from '../errors.js';
import { write } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { enc, renderList } from './contentHelpers.js';

export const CANVAS_PACKS_HELP = `Usage:
  openwop canvas-packs types --org <orgId> [--json]

Lists the editable canvas types served by installed canvas packs
(GET /v1/host/openwop-app/canvas-packs/orgs/<orgId>/types) → { canvasTypeId, title }.
Requires the canvas-packs toggle (off by default).

Exit codes: 0 ok · 2 usage / feature off · 4 forbidden.

Examples:
  openwop canvas-packs types --org org_1
`;

export async function runCanvasPacks(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] === undefined || (argv[0].startsWith('-') && argv[0] !== '--help' && argv[0] !== '-h') ? 'types' : argv[0];
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CANVAS_PACKS_HELP); return 0; }
  const { options } = parseOptions(argv.slice(argv[0] === 'types' ? 1 : 0), { bool: ['--help'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, CANVAS_PACKS_HELP); return 0; }
  if (sub !== 'types') throw new CliError(`Unknown canvas-packs command: ${sub}\nRun \`openwop canvas-packs --help\` for usage.`);
  const org = requireOrg(options.org);
  const res = await requestJson(ctx, `/v1/host/openwop-app/canvas-packs/orgs/${enc(org)}/types`);
  const items = Array.isArray(res.body?.types) ? res.body.types : [];
  return renderList(ctx, res.body, items, ['canvasTypeId', 'title'], 'No canvas pack types.');
}

import type { Ctx } from '../context.js';
/**
 * `openwop canvas-collab ...` — real-time canvas collaboration: mint a WebSocket
 * upgrade ticket, run the seeder election, and read the operator debug view
 * (ADR 0359 + its cross-origin ticket correction; ADR 0610 collab-lane member gate).
 *
 * Hits `/v1/host/openwop-app/canvas-collab/*` (host-extension). Gated by the
 * `realtime-collab` toggle + the canvas type's own toggle + tenant canvas
 * authorization — every miss is a uniform 404. A ticket is a short-lived
 * CREDENTIAL scoped to one canvas: it is printed once, never logged or saved.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, renderList } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/canvas-collab';

export const CANVAS_COLLAB_HELP = `Usage:
  openwop canvas-collab ticket <canvasId> [--json]
  openwop canvas-collab claim-seed <canvasId> [--json]
  openwop canvas-collab debug [--json]

\`ticket\` mints a short-lived collaboration ticket for one canvas
(POST ${BASE}/<canvasId>/ticket) — a credential for the collaboration socket's
?ticket= parameter; it is printed once and never stored. \`claim-seed\` runs the
seeder election (POST ${BASE}/<canvasId>/claim-seed) → { seed: true } for the one
caller that should seed a fresh room. \`debug\` lists this server instance's live
rooms (GET ${BASE}/_debug; super-admin only; lifecycle metadata, never content).

Exit codes: 0 ok · 2 usage / not found (uniform) · 4 forbidden (debug without super-admin).

Examples:
  openwop canvas-collab ticket canvas_123
  openwop canvas-collab claim-seed canvas_123 --json
  openwop canvas-collab debug
`;

/** Shared by canvas-collab + workflow-collab: print a ticket once with a warning. */
export function printTicketOnce(ctx: Ctx, body: any, subject: string): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); }
  else writeLine(ctx.io.stdout, String(body?.ticket ?? ''));
  writeLine(ctx.io.stderr, `Warning: this is a short-lived credential for ${subject} — shown once; do not log, share, or store it.`);
  return 0;
}

export async function runCanvasCollab(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, CANVAS_COLLAB_HELP); return sub ? 0 : 2; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, CANVAS_COLLAB_HELP); return 0; }
  const id = positionals[0];
  switch (sub) {
    case 'ticket': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop canvas-collab ticket <canvasId>\n'); return 2; }
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/ticket`, { method: 'POST', body: {} });
      return printTicketOnce(ctx, res.body, `canvas ${id}`);
    }
    case 'claim-seed': {
      if (!id) { write(ctx.io.stderr, 'Usage: openwop canvas-collab claim-seed <canvasId>\n'); return 2; }
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/claim-seed`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body);
      else writeLine(ctx.io.stdout, res.body?.seed ? `You won the seed election for ${id} — seed the room.` : `Another client seeds ${id} (seed: false).`);
      return 0;
    }
    case 'debug': {
      const res = await requestJson(ctx, `${BASE}/_debug`);
      const items = Array.isArray(res.body?.instanceRooms) ? res.body.instanceRooms : [];
      return renderList(ctx, res.body, items, ['roomId', 'tenantId', 'clients', 'openedAt'], 'No live collaboration rooms on this instance.');
    }
    default: throw new CliError(`Unknown canvas-collab command: ${sub}\nRun \`openwop canvas-collab --help\` for usage.`);
  }
}

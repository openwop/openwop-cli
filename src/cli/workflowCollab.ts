import type { Ctx } from '../context.js';
/**
 * `openwop workflow-collab ...` — workflow-builder multiplayer: mint a
 * collaboration ticket and run the seeder election for one workflow draft
 * (ADR 0481; rides the shared collab transport of ADR 0359).
 *
 * Hits `/v1/host/openwop-app/workflow-collab/<workflowId>/{ticket,claim-seed}`.
 * Live only when BOTH `workflow-collab` and `realtime-collab` are on; the ticket
 * is scoped to the namespaced workflow room. Tickets are credentials — printed
 * once, never logged or saved.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc } from './contentHelpers.js';
import { printTicketOnce } from './canvasCollab.js';

const BASE = '/v1/host/openwop-app/workflow-collab';

export const WORKFLOW_COLLAB_HELP = `Usage:
  openwop workflow-collab ticket <workflowId> [--json]
  openwop workflow-collab claim-seed <workflowId> [--json]

\`ticket\` mints a short-lived collaboration ticket for one workflow draft
(POST ${BASE}/<workflowId>/ticket) — shown once, never stored. \`claim-seed\` runs
the seeder election (POST ${BASE}/<workflowId>/claim-seed) → { seed }.

Exit codes: 0 ok · 2 usage / not found / feature off · 4 forbidden.

Examples:
  openwop workflow-collab ticket wf_123
  openwop workflow-collab claim-seed wf_123 --json
`;

export async function runWorkflowCollab(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, WORKFLOW_COLLAB_HELP); return sub ? 0 : 2; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, WORKFLOW_COLLAB_HELP); return 0; }
  const id = positionals[0];
  if ((sub === 'ticket' || sub === 'claim-seed') && !id) { write(ctx.io.stderr, `Usage: openwop workflow-collab ${sub} <workflowId>\n`); return 2; }
  switch (sub) {
    case 'ticket': {
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/ticket`, { method: 'POST', body: {} });
      return printTicketOnce(ctx, res.body, `workflow ${id}`);
    }
    case 'claim-seed': {
      const res = await requestJson(ctx, `${BASE}/${enc(id)}/claim-seed`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body);
      else writeLine(ctx.io.stdout, res.body?.seed ? `You won the seed election for ${id} — seed the room.` : `Another client seeds ${id} (seed: false).`);
      return 0;
    }
    default: throw new CliError(`Unknown workflow-collab command: ${sub}\nRun \`openwop workflow-collab --help\` for usage.`);
  }
}

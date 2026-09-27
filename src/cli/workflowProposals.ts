import type { Ctx } from '../context.js';
/**
 * `openwop workflow-proposals …` — server-operator administration of the
 * composed-workflow auto-approval policies (openwop-app ADR 0473 Phase 5).
 *
 * When an agent proposes a composed workflow, a policy lets proposals from ONE
 * agent profile in ONE tenant auto-approve — only for read-only-class nodes;
 * everything else still faces a human. Super-admin only, every change audited:
 *   GET    /v1/host/openwop-app/workflow-proposals/admin/policies?tenantId=…
 *   PUT    /v1/host/openwop-app/workflow-proposals/admin/policies/{tenantId}/{agentProfileId}
 *   DELETE /v1/host/openwop-app/workflow-proposals/admin/policies/{tenantId}/{agentProfileId}
 * Distinct from `openwop proposals` (the RFC 0096 proposal inbox itself).
 */
import { CliError } from '../errors.js';
import { write, writeLine, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, emit } from './chatShared.js';

const BASE = '/v1/host/openwop-app/workflow-proposals/admin/policies';

export const WORKFLOW_PROPOSALS_HELP = `Usage:
  openwop workflow-proposals policies --tenant <tenantId> [--json]
  openwop workflow-proposals enable --tenant <tenantId> --agent-profile <agentProfileId> [--json]
  openwop workflow-proposals disable --tenant <tenantId> --agent-profile <agentProfileId> [--json]

Auto-approval policies for agent-proposed workflows (server operators only):
GET /v1/host/openwop-app/workflow-proposals/admin/policies?tenantId=…,
PUT|DELETE …/policies/{tenantId}/{agentProfileId}. An enabled policy lets that
agent profile's proposals auto-approve when every node is read-only; anything
else still waits for a person. Every change is audited on the server.

Exit codes: 0 ok, 2 usage, 4 not a server operator.

Examples:
  openwop workflow-proposals policies --tenant ws_123
  openwop workflow-proposals enable --tenant ws_123 --agent-profile ap_researcher
`;

export async function runWorkflowProposals(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'policies';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, WORKFLOW_PROPOSALS_HELP); return 0; }
  const { options } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--tenant', '--agent-profile'] });
  if (options.help) { write(ctx.io.stdout, WORKFLOW_PROPOSALS_HELP); return 0; }
  if (!options.tenant) throw new CliError('workflow-proposals requires --tenant <tenantId>.', 2);
  if (sub === 'policies' || sub === 'list') {
    const res = await requestJson(ctx, `${BASE}?tenantId=${enc(options.tenant)}`);
    return emit(ctx, res.body, () => {
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      if (!items.length) { writeLine(ctx.io.stdout, `No auto-approval policies for ${options.tenant}.`); return; }
      writeLine(ctx.io.stdout, formatTable(items.map((p: any) => ({ agentProfileId: p.agentProfileId, createdBy: p.createdBy ?? '', createdAt: p.createdAt ?? '' })), ['agentProfileId', 'createdBy', 'createdAt']));
    });
  }
  if (sub === 'enable' || sub === 'disable') {
    if (!options.agentProfile) throw new CliError(`workflow-proposals ${sub} requires --agent-profile <agentProfileId>.`, 2);
    const path = `${BASE}/${enc(options.tenant)}/${enc(options.agentProfile)}`;
    const res = await requestJson(ctx, path, { method: sub === 'enable' ? 'PUT' : 'DELETE' });
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, sub === 'enable'
      ? `Auto-approval enabled for ${options.agentProfile} in ${options.tenant}.`
      : (res.body?.removed ? `Auto-approval disabled for ${options.agentProfile} in ${options.tenant}.` : `No policy was set for ${options.agentProfile} in ${options.tenant}.`)));
  }
  throw new CliError(`Unknown workflow-proposals command: ${sub}\nRun \`openwop workflow-proposals --help\` for usage.`, 2);
}

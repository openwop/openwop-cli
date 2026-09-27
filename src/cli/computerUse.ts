import type { Ctx } from '../context.js';
/**
 * `openwop computer-use …` — computer-use browser-agent sessions
 * (openwop-app computer-use feature; RFC 0065 computer-use tooling).
 *
 * Read-only, org-scoped host extension:
 *   GET /v1/host/openwop-app/computer-use/orgs/{orgId}/sessions
 *   GET /v1/host/openwop-app/computer-use/orgs/{orgId}/sessions/{sessionId}
 * Gated on the `computer-use` feature toggle and workspace read access; the
 * host answers 404 when the feature is off for the workspace.
 */
import { CliError } from '../errors.js';
import { write, writeLine, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { enc, emit, writeFields } from './chatShared.js';

export const COMPUTER_USE_HELP = `Usage:
  openwop computer-use sessions --org <orgId> [--json]
  openwop computer-use session <sessionId> --org <orgId> [--json]

Browser-agent (computer-use) sessions an org's agents ran:
GET /v1/host/openwop-app/computer-use/orgs/{orgId}/sessions[/{sessionId}].
'session' prints the full step log. Needs workspace read access and the
computer-use feature enabled for the workspace (404 otherwise).

Exit codes: 0 ok, 2 usage / not found / feature off, 4 not permitted.

Examples:
  openwop computer-use sessions --org org_1
  openwop computer-use session cu_123 --org org_1 --json
`;

export async function runComputerUse(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'sessions';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, COMPUTER_USE_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, COMPUTER_USE_HELP); return 0; }
  const base = `/v1/host/openwop-app/computer-use/orgs/${enc(requireOrg(options.org))}/sessions`;
  if (sub === 'sessions' || sub === 'list') {
    const res = await requestJson(ctx, base);
    return emit(ctx, res.body, () => {
      const rows = Array.isArray(res.body?.sessions) ? res.body.sessions : [];
      if (!rows.length) { writeLine(ctx.io.stdout, 'No computer-use sessions.'); return; }
      writeLine(ctx.io.stdout, formatTable(rows.map((s: any) => ({
        sessionId: s.sessionId, status: s.status ?? '', steps: String(s.steps ?? ''), startUrl: s.startUrl ?? '', updatedAt: s.updatedAt ?? '', task: String(s.task ?? '').slice(0, 40),
      })), ['sessionId', 'status', 'steps', 'startUrl', 'updatedAt', 'task']));
    });
  }
  if (sub === 'session' || sub === 'get') {
    if (!positionals[0]) throw new CliError('Usage: openwop computer-use session <sessionId> --org <orgId>', 2);
    const res = await requestJson(ctx, `${base}/${enc(positionals[0])}`);
    const s = res.body?.session ?? {};
    return emit(ctx, res.body, () => {
      writeFields(ctx, [['sessionId', s.sessionId], ['status', s.status], ['task', s.task], ['startUrl', s.startUrl], ['error', s.error], ['createdAt', s.createdAt], ['updatedAt', s.updatedAt]]);
      const steps = Array.isArray(s.steps) ? s.steps : [];
      steps.forEach((st: any, i: number) => writeLine(ctx.io.stdout, `  ${i + 1}. [${st.tier ?? ''}/${st.decidedBy ?? ''}] ${st.action?.kind ?? ''}${st.action?.url ? ` ${st.action.url}` : ''}${st.action?.description ? ` — ${st.action.description}` : ''}`));
    });
  }
  throw new CliError(`Unknown computer-use command: ${sub}\nRun \`openwop computer-use --help\` for usage.`, 2);
}

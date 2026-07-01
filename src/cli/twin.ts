import type { Ctx } from '../context.js';
/** `openwop twin ...` — agent digital-twin config + grants (feature: twin). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const twinPath = (id: string) => `/v1/host/sample/agents/${encodeURIComponent(id)}/twin`;
const GRANTS = '/v1/host/sample/profiles/me/twin-grants';

export const TWIN_HELP = `Usage:
  openwop twin get <agentId> [--json]
  openwop twin set <agentId> --scopes <a,b,...> [--json]
  openwop twin clear <agentId> [--yes]
  openwop twin grants [--json]
  openwop twin grant --agent <agentId> --scopes <a,b,...> [--json]
  openwop twin revoke <agentId> [--yes]

An agent's digital-twin config + your twin GRANTS (which agents may act as your twin,
with which scopes). \`set\` configures an agent's twin; \`grant\`/\`revoke\` manage grants.`;

export async function runTwin(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'get';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, TWIN_HELP); return 0; }
  const args = argv.slice(['get', 'set', 'clear', 'grants', 'grant', 'revoke'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--scopes', '--agent'] });
  if (options.help) { write(ctx.io.stdout, TWIN_HELP); return 0; }
  const scopes = options.scopes ? String(options.scopes).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  switch (sub) {
    case 'get': { if (!positionals[0]) { write(ctx.io.stderr, 'Usage: openwop twin get <agentId>\n'); return 2; } writeJson(ctx.io.stdout, (await requestJson(ctx, twinPath(positionals[0]))).body); return 0; }
    case 'set': {
      if (!positionals[0] || !scopes) { write(ctx.io.stderr, 'Usage: openwop twin set <agentId> --scopes <a,b,...>\n'); return 2; }
      const res = await requestJson(ctx, twinPath(positionals[0]), { method: 'PUT', body: { scopes } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Configured twin for agent ${positionals[0]}.`); return 0;
    }
    case 'clear': {
      if (!positionals[0]) { write(ctx.io.stderr, 'Usage: openwop twin clear <agentId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to clear the twin for ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, twinPath(positionals[0]), { method: 'DELETE' }); writeLine(ctx.io.stdout, `Cleared twin for ${positionals[0]}.`); return 0;
    }
    case 'grants': {
      const res = await requestJson(ctx, GRANTS);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.grants) ? res.body.grants : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((g: any) => ({ agentId: g.agentId ?? '', scopes: Array.isArray(g.scopes) ? g.scopes.join(',') : '' })), ['agentId', 'scopes']) : 'No twin grants.');
      return 0;
    }
    case 'grant': {
      if (!options.agent || !scopes) { write(ctx.io.stderr, 'Usage: openwop twin grant --agent <agentId> --scopes <a,b,...>\n'); return 2; }
      const res = await requestJson(ctx, GRANTS, { method: 'POST', body: { agentId: String(options.agent), scopes } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Granted twin scope to ${String(options.agent)}.`); return 0;
    }
    case 'revoke': {
      if (!positionals[0]) { write(ctx.io.stderr, 'Usage: openwop twin revoke <agentId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to revoke the twin grant for ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `${GRANTS}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' }); writeLine(ctx.io.stdout, `Revoked twin grant for ${positionals[0]}.`); return 0;
    }
    default: throw new CliError(`Unknown twin command: ${sub}`);
  }
}

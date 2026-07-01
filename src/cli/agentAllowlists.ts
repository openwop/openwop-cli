import type { Ctx } from '../context.js';
/** `openwop agent-allowlists ...` — super-admin per-agent tool-allowlist overrides (ADR 0104). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/agent-allowlists/admin/agents';

export const AGENT_ALLOWLISTS_HELP = `Usage:
  openwop agent-allowlists list [--json]
  openwop agent-allowlists get <agentId> [--json]
  openwop agent-allowlists set <agentId> --allowlist-json '[...]' [--json]
  openwop agent-allowlists clear <agentId> [--yes]

Super-admin per-agent tool-allowlist overrides (ADR 0104). \`set\` PUTs the override
(an array of tool ids); \`clear\` removes it. Requires super-admin (OPENWOP_SUPERADMIN_TENANTS).`;

async function req(ctx: Ctx, path: string, opts: Parameters<typeof requestJson>[2], action: string) {
  try {
    return await requestJson(ctx, path, opts);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new CliError(`${action} requires super-admin on this host (OPENWOP_SUPERADMIN_TENANTS).`, 4);
    }
    throw err;
  }
}

export async function runAgentAllowlists(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_ALLOWLISTS_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'set', 'clear'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--allowlist-json'] });
  if (options.help) { write(ctx.io.stdout, AGENT_ALLOWLISTS_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const res = await req(ctx, BASE, {}, 'Reading agent allowlists');
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.agents) ? res.body.agents : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((a: any) => ({ agentId: a.agentId ?? a.id ?? '', tools: Array.isArray(a.allowlist) ? a.allowlist.length : '' })), ['agentId', 'tools']) : 'No allowlist overrides.');
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop agent-allowlists get <agentId>\n'); return 2; }
      writeJson(ctx.io.stdout, (await req(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, {}, 'Reading the agent allowlist')).body); return 0;
    }
    case 'set': {
      if (positionals.length !== 1 || !options.allowlistJson) { write(ctx.io.stderr, "Usage: openwop agent-allowlists set <agentId> --allowlist-json '[...]'\n"); return 2; }
      let allowlist; try { allowlist = JSON.parse(String(options.allowlistJson)); } catch { throw new CliError('--allowlist-json must be valid JSON.', 2); }
      const res = await req(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'PUT', body: { allowlist } }, 'Setting the agent allowlist');
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Set allowlist override for ${positionals[0]}.`); return 0;
    }
    case 'clear': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop agent-allowlists clear <agentId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to clear the allowlist override for ${positionals[0]} without --yes.`, 2);
      await req(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' }, 'Clearing the agent allowlist');
      writeLine(ctx.io.stdout, `Cleared allowlist override for ${positionals[0]}.`); return 0;
    }
    default: throw new CliError(`Unknown agent-allowlists command: ${sub}`);
  }
}

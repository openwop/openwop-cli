import type { Ctx } from '../context.js';
/** `openwop agent-profile ...` — rich agent profile + connector readiness (ADR 0031). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const prof = (id: string) => `/v1/host/sample/agents/${encodeURIComponent(id)}/profile`;

export const AGENT_PROFILE_HELP = `Usage:
  openwop agent-profile get <agentId> [--json]
  openwop agent-profile set <agentId> --profile-json '{...}' [--json]
  openwop agent-profile readiness <agentId> [--json]

An agent's rich profile + its connector readiness (ADR 0031). \`set\` PUTs the full
profile object; \`readiness\` reports whether the connectors the agent needs are wired.`;

export async function runAgentProfile(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'get';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_PROFILE_HELP); return 0; }
  const args = argv.slice(['get', 'set', 'readiness'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help'], value: ['--profile-json'] });
  if (options.help) { write(ctx.io.stdout, AGENT_PROFILE_HELP); return 0; }
  if (positionals.length !== 1) { write(ctx.io.stderr, `Usage: openwop agent-profile ${sub} <agentId>\n`); return 2; }
  const agentId = positionals[0];
  switch (sub) {
    case 'get': writeJson(ctx.io.stdout, (await requestJson(ctx, prof(agentId))).body); return 0;
    case 'readiness': writeJson(ctx.io.stdout, (await requestJson(ctx, `/v1/host/sample/agents/${encodeURIComponent(agentId)}/connection-readiness`)).body); return 0;
    case 'set': {
      if (!options.profileJson) { write(ctx.io.stderr, "agent-profile set needs --profile-json '{...}'.\n"); return 2; }
      let profile;
      try { profile = JSON.parse(String(options.profileJson)); } catch { throw new CliError('--profile-json must be valid JSON.', 2); }
      const res = await requestJson(ctx, prof(agentId), { method: 'PUT', body: profile });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated profile for agent ${agentId}.`);
      return 0;
    }
    default: throw new CliError(`Unknown agent-profile command: ${sub}`);
  }
}

import type { Ctx } from '../context.js';
/** `openwop agent-packs ...` — the agent (persona) pack registry. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/registry/agent-packs';

export const AGENT_PACKS_HELP = `Usage:
  openwop agent-packs list [--json]
  openwop agent-packs install --name <core.openwop.agents.*> [--version <v>] [--json]

The agent (persona) pack registry. \`install\` provisions a signed agent pack (its name
MUST start with 'core.openwop.agents.'). Distinct from the node-pack 'packs' registry.`;

export async function runAgentPacks(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, AGENT_PACKS_HELP); return 0; }
  const args = argv.slice(['list', 'install'].includes(sub) ? 1 : 0);
  const { options } = parseOptions(args, { bool: ['--help'], value: ['--name', '--version'] });
  if (options.help) { write(ctx.io.stdout, AGENT_PACKS_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.packs) ? res.body.packs : Array.isArray(res.body) ? res.body : [];
      writeLine(ctx.io.stdout, items.length ? formatTable(items.map((p: any) => ({ name: p.name ?? '', version: p.version ?? p.latestVersion ?? '', agents: Array.isArray(p.agents) ? p.agents.length : '' })), ['name', 'version', 'agents']) : 'No agent packs.');
      return 0;
    }
    case 'install': {
      if (!options.name) { write(ctx.io.stderr, 'Usage: openwop agent-packs install --name <core.openwop.agents.*> [--version <v>]\n'); return 2; }
      const body: Record<string, string> = { name: String(options.name) };
      if (options.version) body.version = String(options.version);
      const res = await requestJson(ctx, `${BASE}/install`, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Installed agent pack ${String(options.name)}.`);
      return 0;
    }
    default: throw new CliError(`Unknown agent-packs command: ${sub}`);
  }
}

import type { Ctx } from '../context.js';
/** `openwop workflows ...` — list/get/register/delete demo workflows. */
import { resolve as resolvePath } from 'node:path';
import { readFile } from 'node:fs/promises';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

export const WORKFLOWS_HELP = `Usage:
  openwop workflows list [--json]
  openwop workflows get <workflowId> [--json]
  openwop workflows register <workflow.json> [--json]
  openwop workflows delete <workflowId> [--json]
  openwop workflows chains [--json]
  openwop workflows from-chain <chainId> [--params-json '{...}'] [--json]
  openwop workflows chain-pack-install --name <pack> [--version <v>] [--json]

\`chains\` lists the host's workflow-chain templates (ADR 0163 / RFC 0013);
\`from-chain\` expands one into a registered workflow you can run; \`chain-pack-install\`
installs a signed workflow-chain pack.
`;

export async function runWorkflows(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'register', 'delete', 'rm', 'chains', 'from-chain', 'chain-pack-install'].includes(sub) ? 1 : 0);
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, WORKFLOWS_HELP);
    return 0;
  }
  switch (sub) {
    case 'list':
      return runWorkflowsList(ctx, args);
    case 'get':
      return runWorkflowsGet(ctx, args);
    case 'register':
      return runWorkflowsRegister(ctx, args);
    case 'delete':
    case 'rm':
      return runWorkflowsDelete(ctx, args);
    case 'chains':
      return runWorkflowsChains(ctx, args);
    case 'from-chain':
      return runWorkflowsFromChain(ctx, args);
    case 'chain-pack-install':
      return runWorkflowsChainPackInstall(ctx, args);
    default:
      throw new CliError(`Unknown workflows command: ${sub}`);
  }
}

/** GET /v1/host/sample/workflow-chains — the host's workflow-chain templates. */
async function runWorkflowsChains(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, WORKFLOWS_HELP); return 0; }
  const res = await requestJson(ctx, '/v1/host/sample/workflow-chains');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const chains = Array.isArray(res.body?.chains) ? res.body.chains : [];
  if (chains.length === 0) { writeLine(ctx.io.stdout, 'No workflow chains.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    chains.map((c: any) => ({ chainId: c.chainId ?? '', name: c.name ?? '', steps: Array.isArray(c.steps) ? c.steps.length : (c.stepCount ?? '') })),
    ['chainId', 'name', 'steps'],
  ));
  return 0;
}

/** POST /v1/host/sample/workflows/from-chain — expand a chain into a registered workflow. */
async function runWorkflowsFromChain(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--chain', '--params-json'] });
  const chainId = options.chain ?? positionals[0];
  if (!chainId) { write(ctx.io.stderr, "Usage: openwop workflows from-chain <chainId> [--params-json '{...}'] [--json]\n"); return 2; }
  let params: unknown = {};
  if (options.paramsJson) {
    try { params = JSON.parse(String(options.paramsJson)); } catch { throw new CliError('--params-json must be valid JSON.', 2); }
  }
  const res = await requestJson(ctx, '/v1/host/sample/workflows/from-chain', { method: 'POST', body: { chainId, params } });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Registered workflow ${res.body?.workflowId ?? ''} from chain ${chainId}.`);
  return 0;
}

/** POST /v1/host/sample/workflow-chain-packs/install — install a signed chain pack. */
async function runWorkflowsChainPackInstall(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--name', '--version'] });
  if (!options.name) { write(ctx.io.stderr, 'Usage: openwop workflows chain-pack-install --name <pack> [--version <v>] [--json]\n'); return 2; }
  const body: Record<string, unknown> = { name: String(options.name) };
  if (options.version) body.version = String(options.version);
  const res = await requestJson(ctx, '/v1/host/sample/workflow-chain-packs/install', { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Installed workflow-chain pack ${options.name}.`);
  return 0;
}

async function runWorkflowsList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, WORKFLOWS_HELP);
    return 0;
  }
  const res = await requestJson(ctx, '/v1/host/sample/workflows');
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const workflows = res.body.workflows ?? [];
  const rows = workflows.map((w: any) => ({ workflowId: w.workflowId, nodes: Array.isArray(w.nodes) ? w.nodes.length : 0 }));
  writeLine(ctx.io.stdout, rows.length ? formatTable(rows, ['workflowId', 'nodes']) : 'No registered sample workflows.');
  return 0;
}

async function runWorkflowsGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop workflows get <workflowId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const workflowId = encodeURIComponent(positionals[0]);
  const res = await requestJson(ctx, `/v1/workflows/${workflowId}`);
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else {
    writeLine(ctx.io.stdout, `workflowId: ${res.body.workflowId ?? positionals[0]}`);
    writeLine(ctx.io.stdout, `nodes: ${Array.isArray(res.body.nodes) ? res.body.nodes.length : 0}`);
    if (Array.isArray(res.body.edges)) writeLine(ctx.io.stdout, `edges: ${res.body.edges.length}`);
  }
  return 0;
}

async function runWorkflowsRegister(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop workflows register <workflow.json> [--json]\n');
    return options.help ? 0 : 2;
  }
  const file = resolvePath(ctx.cwd, positionals[0]);
  const body = JSON.parse(await readFile(file, 'utf8'));
  const res = await requestJson(ctx, '/v1/host/sample/workflows', { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Registered workflow ${res.body.workflowId} (${res.body.nodeCount} nodes)`);
  return 0;
}

async function runWorkflowsDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop workflows delete <workflowId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const workflowId = encodeURIComponent(positionals[0]);
  const res = await requestJson(ctx, `/v1/host/sample/workflows/${workflowId}`, { method: 'DELETE' });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `${res.body.removed ? 'Deleted' : 'No matching workflow'}: ${res.body.workflowId}`);
  return 0;
}

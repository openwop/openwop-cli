import type { Ctx } from '../context.js';
/** `openwop csm ...` — Customer-Success accounts (feature: csm). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/sample/csm/accounts';

export const CSM_HELP = `Usage:
  openwop csm list [--json]
  openwop csm get <accountId> [--json]
  openwop csm create --name <name> [--health-score <0-100>] [--json]
  openwop csm update <accountId> [--name n] [--health-score <0-100>] [--json]
  openwop csm delete <accountId> [--yes]

Customer-Success accounts (host-extension ${BASE}). An account has a name and a
health score. The host is the authority; the CLI mirrors + relays.
`;

export async function runCsm(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CSM_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list': return csmList(ctx, args);
    case 'get': return csmGet(ctx, args);
    case 'create': return csmCreate(ctx, args);
    case 'update': return csmUpdate(ctx, args);
    case 'delete': return csmDelete(ctx, args);
    default: throw new CliError(`Unknown csm command: ${sub}\nRun \`openwop csm --help\` for usage.`);
  }
}

async function csmList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, CSM_HELP); return 0; }
  const res = await requestJson(ctx, BASE);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.accounts) ? res.body.accounts : Array.isArray(res.body) ? res.body : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No accounts.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    items.map((a: any) => ({ id: a.id ?? '', name: a.name ?? '', healthScore: a.healthScore ?? '' })),
    ['id', 'name', 'healthScore'],
  ));
  return 0;
}

async function csmGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop csm get <accountId> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`);
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

async function csmCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--name', '--health-score'] });
  if (!options.name) { write(ctx.io.stderr, 'Usage: openwop csm create --name <name> [--health-score <0-100>] [--json]\n'); return 2; }
  const body: Record<string, unknown> = { name: String(options.name) };
  if (options.healthScore !== undefined) body.healthScore = Number(options.healthScore);
  const res = await requestJson(ctx, BASE, { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Created account ${res.body?.id ?? ''} (${String(options.name)}).`);
  return 0;
}

async function csmUpdate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--name', '--health-score'] });
  if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop csm update <accountId> [--name n] [--health-score <0-100>] [--json]\n'); return 2; }
  const body: Record<string, unknown> = {};
  if (options.name) body.name = String(options.name);
  if (options.healthScore !== undefined) body.healthScore = Number(options.healthScore);
  const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Updated account ${positionals[0]}.`);
  return 0;
}

async function csmDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop csm delete <accountId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) throw new CliError(`Refusing to delete account ${positionals[0]} without --yes.`, 2);
  await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted account ${positionals[0]}.`);
  return 0;
}

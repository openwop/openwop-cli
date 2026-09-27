import type { Ctx } from '../context.js';
/** `openwop crm ...` — CRM contacts (feature: crm, ADR 0008). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { buildGroupHelp, runResourceGroup } from './resourceCommands.js';
import { CRM_EXT_SPECS, CRM_EXT_INTRO } from './crmExt.js';

const BASE = '/v1/host/openwop-app/crm/contacts';

export const CRM_HELP = `Usage:
  openwop crm list [--stage <s>] [--json]
  openwop crm get <contactId> [--json]
  openwop crm create --name <name> [--email <e>] [--company <c>] [--stage <s>] [--owner o] [--title t] [--address a] [--lead-source s] [--phone p] [--custom-fields <json>] [--json]
  openwop crm update <contactId> [--name n] [--email e] [--company c] [--stage s] [--owner o] [--title t] [--address a] [--lead-source s] [--phone p] [--custom-fields <json>] [--json]
  openwop crm delete <contactId> [--yes]
  openwop crm triage <contactId> [--workflow-id <id>] [--json]

CRM contacts (host-extension ${BASE}). A contact has a name, optional email /
company, and a pipeline stage. \`triage\` runs the host's triage workflow over a
contact and returns the run. The host is the authority; the CLI mirrors + relays.

${buildGroupHelp('crm', CRM_EXT_INTRO || 'CRM extensions.', CRM_EXT_SPECS)}`;

export async function runCrm(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CRM_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete', 'triage'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list': return crmList(ctx, args);
    case 'get': return crmGet(ctx, args);
    case 'create': return crmCreate(ctx, args);
    case 'update': return crmUpdate(ctx, args);
    case 'delete': return crmDelete(ctx, args);
    case 'triage': return crmTriage(ctx, args);
    default: return runResourceGroup(ctx, 'crm', CRM_HELP, CRM_EXT_SPECS, argv);
  }
}

// Contact body fields the host's POST/PATCH /crm/contacts accept (besides name).
const CONTACT_FLAGS = ['--name', '--email', '--company', '--stage', '--owner', '--title', '--address', '--lead-source', '--phone', '--custom-fields'];
const CONTACT_USAGE = '[--email e] [--company c] [--stage lead|qualified|customer|churned] [--owner o] [--title t] [--address a] [--lead-source s] [--phone p] [--custom-fields <json>]';

function contactFields(options: Record<string, any>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of ['email', 'company', 'stage', 'owner', 'title', 'address', 'leadSource', 'phone'] as const) if (options[k]) body[k] = String(options[k]);
  if (options.customFields !== undefined) {
    try { body.customFields = JSON.parse(String(options.customFields)); } catch { throw new CliError('--custom-fields must be a JSON object'); }
  }
  return body;
}

async function crmList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--stage'] });
  if (options.help) { write(ctx.io.stdout, CRM_HELP); return 0; }
  const q = options.stage ? `?stage=${encodeURIComponent(String(options.stage))}` : '';
  const res = await requestJson(ctx, `${BASE}${q}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.contacts) ? res.body.contacts : Array.isArray(res.body) ? res.body : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No contacts.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    items.map((c: any) => ({ id: c.id ?? '', name: c.name ?? '', stage: c.stage ?? '', email: c.email ?? '', company: c.company ?? '' })),
    ['id', 'name', 'stage', 'email', 'company'],
  ));
  return 0;
}

async function crmGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop crm get <contactId> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`);
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

async function crmCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: CONTACT_FLAGS });
  if (!options.name) { write(ctx.io.stderr, `Usage: openwop crm create --name <name> ${CONTACT_USAGE} [--json]\n`); return 2; }
  const body: Record<string, unknown> = { name: String(options.name), ...contactFields(options) };
  const res = await requestJson(ctx, BASE, { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Created contact ${res.body?.id ?? ''} (${body.name}).`);
  return 0;
}

async function crmUpdate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: CONTACT_FLAGS });
  if (positionals.length !== 1) { write(ctx.io.stderr, `Usage: openwop crm update <contactId> [--name n] ${CONTACT_USAGE} [--json]\n`); return 2; }
  const body: Record<string, unknown> = { ...(options.name ? { name: String(options.name) } : {}), ...contactFields(options) };
  const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Updated contact ${positionals[0]}.`);
  return 0;
}

async function crmDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop crm delete <contactId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) throw new CliError(`Refusing to delete contact ${positionals[0]} without --yes.`, 2);
  await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted contact ${positionals[0]}.`);
  return 0;
}

async function crmTriage(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--workflow-id'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop crm triage <contactId> [--workflow-id <id>] [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}/triage`, { method: 'POST', body: options.workflowId ? { workflowId: String(options.workflowId) } : {} });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Triaged contact ${positionals[0]} → run ${res.body?.runId ?? '(see --json)'}.`);
  return 0;
}

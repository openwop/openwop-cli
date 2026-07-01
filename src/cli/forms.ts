import type { Ctx } from '../context.js';
/** `openwop forms ...` — form builder + intake (feature: forms). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const base = (org: string) => `/v1/host/sample/forms/orgs/${encodeURIComponent(org)}/forms`;

export const FORMS_HELP = `Usage:
  openwop forms list --org <orgId> [--json]
  openwop forms get <formId> --org <orgId> [--json]
  openwop forms create --org <orgId> --title <t> [--fields-json '[...]'] [--json]
  openwop forms update <formId> --org <orgId> [--title <t>] [--fields-json '[...]'] [--json]
  openwop forms status <formId> --org <orgId> --status <draft|published|closed> [--json]
  openwop forms delete <formId> --org <orgId> [--yes]
  openwop forms submissions <formId> --org <orgId> [--json]

Form builder + intake (host-extension, org-scoped). Every command needs --org.
A form has a title + fields[]; \`status\` publishes/closes it; \`submissions\` reads
the collected responses. The host is the authority; the CLI mirrors + relays.
`;

function requireOrg(org: unknown): string {
  if (!org) throw new CliError('This command is org-scoped — pass --org <orgId>.', 2);
  return String(org);
}
function parseFields(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  try { return JSON.parse(String(raw)); } catch { throw new CliError('--fields-json must be valid JSON.', 2); }
}

export async function runForms(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, FORMS_HELP); return 0; }
  const args = argv.slice(['list', 'get', 'create', 'update', 'status', 'delete', 'submissions'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list': return formsList(ctx, args);
    case 'get': return formsGet(ctx, args);
    case 'create': return formsCreate(ctx, args);
    case 'update': return formsUpdate(ctx, args);
    case 'status': return formsStatus(ctx, args);
    case 'delete': return formsDelete(ctx, args);
    case 'submissions': return formsSubmissions(ctx, args);
    default: throw new CliError(`Unknown forms command: ${sub}\nRun \`openwop forms --help\` for usage.`);
  }
}

async function formsList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, FORMS_HELP); return 0; }
  const org = requireOrg(options.org);
  const res = await requestJson(ctx, base(org));
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.forms) ? res.body.forms : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No forms.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    items.map((f: any) => ({ id: f.id ?? '', title: f.title ?? '', status: f.status ?? '', fields: Array.isArray(f.fields) ? f.fields.length : '' })),
    ['id', 'title', 'status', 'fields'],
  ));
  return 0;
}

async function formsGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop forms get <formId> --org <orgId> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`);
  writeJson(ctx.io.stdout, res.body);
  return 0;
}

async function formsCreate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--org', '--title', '--fields-json'] });
  const org = requireOrg(options.org);
  if (!options.title) { write(ctx.io.stderr, "Usage: openwop forms create --org <orgId> --title <t> [--fields-json '[...]'] [--json]\n"); return 2; }
  const body: Record<string, unknown> = { title: String(options.title) };
  const fields = parseFields(options.fieldsJson);
  if (fields !== undefined) body.fields = fields;
  const res = await requestJson(ctx, base(org), { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Created form ${res.body?.id ?? ''} (${String(options.title)}).`);
  return 0;
}

async function formsUpdate(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--org', '--title', '--fields-json'] });
  const org = requireOrg(options.org);
  if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop forms update <formId> --org <orgId> [--title <t>] [--fields-json ...] [--json]\n'); return 2; }
  const body: Record<string, unknown> = {};
  if (options.title) body.title = String(options.title);
  const fields = parseFields(options.fieldsJson);
  if (fields !== undefined) body.fields = fields;
  const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Updated form ${positionals[0]}.`);
  return 0;
}

async function formsStatus(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--org', '--status'] });
  const org = requireOrg(options.org);
  if (positionals.length !== 1 || !options.status) { write(ctx.io.stderr, 'Usage: openwop forms status <formId> --org <orgId> --status <draft|published|closed> [--json]\n'); return 2; }
  const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}/status`, { method: 'POST', body: { status: String(options.status) } });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Form ${positionals[0]} → status ${options.status}.`);
  return 0;
}

async function formsDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop forms delete <formId> --org <orgId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) throw new CliError(`Refusing to delete form ${positionals[0]} without --yes.`, 2);
  await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted form ${positionals[0]}.`);
  return 0;
}

async function formsSubmissions(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop forms submissions <formId> --org <orgId> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}/submissions`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const subs = Array.isArray(res.body?.submissions) ? res.body.submissions : [];
  writeLine(ctx.io.stdout, `${subs.length} submission(s).`);
  if (subs.length) writeJson(ctx.io.stdout, subs);
  return 0;
}

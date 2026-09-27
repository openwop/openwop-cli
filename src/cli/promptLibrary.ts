import type { Ctx } from '../context.js';
/**
 * `openwop prompts library ...` — an org's curated prompt library
 * (openwop-app ADR 0116; host-extension, org-scoped + RBAC).
 *
 * Library entries are named, tagged pointers (`promptRef`) at a prompt-store
 * template (`openwop prompts`, RFC 0029). Driven through
 * /v1/host/openwop-app/prompts/orgs/{orgId}/entries[/{entryId}[/render]]:
 * list/get/render need workspace:read, create/update/delete workspace:write.
 * A foreign or unknown entry is a uniform 404; a `promptRef` that names no
 * template is refused by the host.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { parseJsonFlag } from './contentHelpers.js';

const entries = (org: string) => `/v1/host/openwop-app/prompts/orgs/${encodeURIComponent(org)}/entries`;

export const PROMPT_LIBRARY_HELP = `Usage:
  openwop prompts library list --org <orgId> [--json]
  openwop prompts library get <entryId> --org <orgId> [--json]
  openwop prompts library create --org <orgId> --name <n> --prompt-ref <templateId[@version]> [--description <t>] [--tag <t>]... [--visibility private|org|shared] [--json]
  openwop prompts library update <entryId> --org <orgId> [--name <n>] [--prompt-ref <ref>] [--description <t>] [--tag <t>]... [--visibility private|org|shared] [--json]
  openwop prompts library delete <entryId> --org <orgId> [--yes]
  openwop prompts library render <entryId> --org <orgId> [--variables-json '{...}'] [--json]

An org's prompt library (ADR 0116, host-extension). Every command hits
/v1/host/openwop-app/prompts/orgs/{orgId}/entries[/{entryId}]:

  list    GET    …/entries
  get     GET    …/entries/{entryId}
  create  POST   …/entries                 { name, promptRef, description?, tags?, visibility? }
  update  PATCH  …/entries/{entryId}       (only the fields you pass)
  delete  DELETE …/entries/{entryId}
  render  POST   …/entries/{entryId}/render { variables } — resolves the entry's
          template and substitutes the variables (untrusted values are fenced).

A --tag list on update replaces the entry's tags. For the protocol prompt store
itself (templates, PromptRefs, /v1/prompts:render) use \`openwop prompts\`.

Examples:
  openwop prompts library list --org org_1
  openwop prompts library create --org org_1 --name "Weekly summary" --prompt-ref summary.weekly --tag reporting
  openwop prompts library render pe_123 --org org_1 --variables-json '{"team":"growth"}'
`;

export async function runPromptLibrary(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PROMPT_LIBRARY_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--org', '--name', '--prompt-ref', '--description', '--visibility', '--variables-json'],
    multi: ['--tag'],
  });
  if (options.help) { write(ctx.io.stdout, PROMPT_LIBRARY_HELP); return 0; }
  const org = requireOrg(options.org);
  const one = (usage: string) => {
    if (positionals.length !== 1) throw new CliError(`Usage: openwop prompts library ${sub} ${usage}`, 2);
    return `${entries(org)}/${encodeURIComponent(positionals[0])}`;
  };
  if (options.visibility !== undefined && !['private', 'org', 'shared'].includes(options.visibility)) {
    throw new CliError('--visibility must be private, org or shared.', 2);
  }
  const fields = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (options.name !== undefined) body.name = options.name;
    if (options.promptRef !== undefined) body.promptRef = options.promptRef;
    if (options.description !== undefined) body.description = options.description;
    if (Array.isArray(options.tag)) body.tags = options.tag;
    if (options.visibility !== undefined) body.visibility = options.visibility;
    return body;
  };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, entries(org));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.entries) ? res.body.entries : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, `No prompt-library entries in org ${org}.`); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((e: any) => ({
        entryId: e.entryId, name: e.name ?? '', promptRef: e.promptRef ?? '', visibility: e.visibility ?? '', tags: Array.isArray(e.tags) ? e.tags.join(',') : '',
      })), ['entryId', 'name', 'promptRef', 'visibility', 'tags']));
      return 0;
    }
    case 'get': {
      const res = await requestJson(ctx, one('<entryId> --org <orgId> [--json]'));
      writeJson(ctx.io.stdout, ctx.json ? res.body : res.body?.entry ?? res.body);
      return 0;
    }
    case 'create': {
      if (!options.name || !options.promptRef) throw new CliError('create needs --name <n> and --prompt-ref <ref>.', 2);
      const res = await requestJson(ctx, entries(org), { method: 'POST', body: fields() });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Created prompt-library entry ${res.body?.entry?.entryId ?? ''} (${options.name}).`);
      return 0;
    }
    case 'update': {
      const path = one('<entryId> --org <orgId> [--name <n>] [--prompt-ref <ref>] [--description <t>] [--tag <t>]... [--visibility v] [--json]');
      const body = fields();
      if (Object.keys(body).length === 0) throw new CliError('Nothing to update — pass at least one field.', 2);
      const res = await requestJson(ctx, path, { method: 'PATCH', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Updated prompt-library entry ${positionals[0]}.`);
      return 0;
    }
    case 'delete': {
      const path = one('<entryId> --org <orgId> [--yes]');
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete prompt-library entry ${positionals[0]} without --yes.`); return 2; }
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted prompt-library entry ${positionals[0]}.`);
      return 0;
    }
    case 'render': {
      const path = one("<entryId> --org <orgId> [--variables-json '{...}'] [--json]");
      const variables = options.variablesJson !== undefined ? parseJsonFlag('--variables-json', options.variablesJson) : {};
      const res = await requestJson(ctx, `${path}/render`, { method: 'POST', body: { variables } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const text = res.body?.composed;
      if (typeof text === 'string') writeLine(ctx.io.stdout, text);
      else writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    default:
      throw new CliError(`Unknown prompts library command: ${sub}\nRun \`openwop prompts library --help\` for usage.`);
  }
}

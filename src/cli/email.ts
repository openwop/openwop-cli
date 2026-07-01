import type { Ctx } from '../context.js';
/** `openwop email ...` — email templates + campaigns (feature: email). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const base = (org: string) => `/v1/host/sample/email/orgs/${encodeURIComponent(org)}`;

export const EMAIL_HELP = `Usage:
  openwop email templates list --org <orgId> [--json]
  openwop email templates get <templateId> --org <orgId> [--json]
  openwop email templates create --org <orgId> --name <n> --subject <s> --body <b> [--json]
  openwop email templates update <templateId> --org <orgId> [--name n] [--subject s] [--body b] [--json]
  openwop email templates delete <templateId> --org <orgId> [--yes]
  openwop email campaigns list --org <orgId> [--json]
  openwop email campaigns get <campaignId> --org <orgId> [--json]
  openwop email campaigns create --org <orgId> --template <templateId> [--name <n>] [--json]
  openwop email campaigns delete <campaignId> --org <orgId> [--yes]
  openwop email campaigns send <campaignId> --org <orgId> [--yes] [--json]
  openwop email campaigns sends <campaignId> --org <orgId> [--json]

Outbound email (host-extension, org-scoped). Templates hold a name/subject/body;
a campaign binds a template + audience; \`send\` dispatches it and \`sends\` reads the
delivery log. Every command needs --org. The host is the authority; the CLI relays.
`;


export async function runEmail(ctx: Ctx, argv: string[]) {
  const group = argv[0];
  if (group === '--help' || group === '-h' || group === undefined) { write(ctx.io.stdout, EMAIL_HELP); return group === undefined ? 2 : 0; }
  const rest = argv.slice(1);
  if (group === 'templates') return emailTemplates(ctx, rest);
  if (group === 'campaigns') return emailCampaigns(ctx, rest);
  throw new CliError(`Unknown email command: ${group}. Use 'templates' or 'campaigns'.`);
}

// ── templates ────────────────────────────────────────────────────────────────
async function emailTemplates(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name', '--subject', '--body'] });
  if (options.help) { write(ctx.io.stdout, EMAIL_HELP); return 0; }
  const org = requireOrg(options.org);
  const url = `${base(org)}/templates`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, url);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.templates) ? res.body.templates : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No templates.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((t: any) => ({ id: t.id ?? '', name: t.name ?? '', subject: t.subject ?? '' })), ['id', 'name', 'subject']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email templates get <templateId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      if (!options.name || !options.subject || !options.body) { write(ctx.io.stderr, 'email templates create needs --name, --subject, --body.\n'); return 2; }
      const res = await requestJson(ctx, url, { method: 'POST', body: { name: String(options.name), subject: String(options.subject), body: String(options.body) } });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created template ${res.body?.id ?? ''} (${String(options.name)}).`);
      return 0;
    }
    case 'update': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email templates update <templateId> --org <orgId> [--name n] [--subject s] [--body b]\n'); return 2; }
      const patch: Record<string, string> = {};
      for (const k of ['name', 'subject', 'body'] as const) if (options[k]) patch[k] = String(options[k]);
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated template ${positionals[0]}.`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email templates delete <templateId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete template ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted template ${positionals[0]}.`); return 0;
    }
    default: throw new CliError(`Unknown email templates command: ${sub}`);
  }
}

// ── campaigns ────────────────────────────────────────────────────────────────
async function emailCampaigns(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'get', 'create', 'delete', 'send', 'sends'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--template', '--name'] });
  if (options.help) { write(ctx.io.stdout, EMAIL_HELP); return 0; }
  const org = requireOrg(options.org);
  const url = `${base(org)}/campaigns`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, url);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.campaigns) ? res.body.campaigns : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No campaigns.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((c: any) => ({ id: c.id ?? '', name: c.name ?? '', status: c.status ?? '', template: c.templateId ?? '' })), ['id', 'name', 'status', 'template']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email campaigns get <campaignId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      if (!options.template) { write(ctx.io.stderr, 'email campaigns create needs --template <templateId>.\n'); return 2; }
      const body: Record<string, string> = { templateId: String(options.template) };
      if (options.name) body.name = String(options.name);
      const res = await requestJson(ctx, url, { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created campaign ${res.body?.id ?? ''}.`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email campaigns delete <campaignId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete campaign ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted campaign ${positionals[0]}.`); return 0;
    }
    case 'send': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email campaigns send <campaignId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to SEND campaign ${positionals[0]} without --yes (this dispatches real email).`, 2);
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}/send`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Sent campaign ${positionals[0]}.`);
      return 0;
    }
    case 'sends': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop email campaigns sends <campaignId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${url}/${encodeURIComponent(positionals[0])}/sends`);
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    default: throw new CliError(`Unknown email campaigns command: ${sub}`);
  }
}

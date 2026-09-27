import type { Ctx } from '../context.js';
/** `openwop email ...` — email templates + campaigns (feature: email). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { dispatchSpecs, specsUsage, type CommandSpec } from './resourceCommands.js';
import { APP, enc, dispatchTable, requestRaw, readText, writeText, rawJson, type Cmd, type RawResponse } from './marketingShared.js';

const base = (org: string) => `/v1/host/openwop-app/email/orgs/${encodeURIComponent(org)}`;

const EO = '/v1/host/openwop-app/email/orgs/:org';

/** Sender identity, provider status, bounce-webhook configs (ADR 0241) and campaign engagement (ADR 0218 C4). */
export const EMAIL_EXT_SPECS: CommandSpec[] = [
  { cmd: ['settings'], method: 'GET', route: `${EO}/settings`, summary: 'The org\'s sender identity (campaigns cannot send until it is set).' },
  { cmd: ['settings', 'set'], method: 'PUT', route: `${EO}/settings`, body: ['senderAddress!'], summary: 'Set the sender address.' },
  { cmd: ['provider-status'], method: 'GET', route: `${EO}/provider-status`, summary: 'Which email providers you can send through, the host default, and the sender (no secrets).',
    list: { key: 'providers', columns: ['provider', 'connected'], empty: 'No email providers.' } },
  { cmd: ['webhooks'], method: 'GET', route: `${EO}/webhook-configs`, summary: 'Bounce/complaint webhook configs + the ingest path to point the provider at (secrets never returned).',
    list: { key: 'configs', columns: ['webhookId', 'provider', 'enabled', 'ingestPath', 'updatedAt'], empty: 'No webhook configs.' } },
  { cmd: ['webhooks', 'add'], method: 'POST', route: `${EO}/webhook-configs`, body: ['provider!', 'verificationSecret:file!=verification-secret-file', 'webhookId'],
    summary: 'Configure a provider webhook (provider: sendgrid | postmark). The verification secret is read from a file and never echoed.' },
  { cmd: ['webhooks', 'remove'], method: 'DELETE', route: `${EO}/webhook-configs/:webhookId`, confirm: true, summary: 'Remove a webhook config.' },
  { cmd: ['campaigns', 'engagement'], method: 'GET', route: `${EO}/campaigns/:campaignId/engagement`, summary: 'Click + unsubscribe stats and the latest 200 events for one campaign.' },
];

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
${specsUsage('email', EMAIL_EXT_SPECS)}

Outbound email (host-extension, org-scoped). Templates hold a name/subject/body;
a campaign binds a template + audience; \`send\` dispatches it and \`sends\` reads the
delivery log. Every command needs --org. The host is the authority; the CLI relays.

Public recipient legs (UNAUTHENTICATED — the links a recipient's mail client follows,
under /v1/host/openwop-app/public-email/…; use them to test a campaign's links):
  openwop email public open <token> [--json]                open pixel  GET  …/o/{token}
  openwop email public click <token> [--json]               click link  GET  …/c/{token} (redirect NOT followed; prints the target)
  openwop email public unsubscribe <token> [--html] [--confirm --yes] [--json]
                                                            GET …/u/{token} shows the page status; --confirm POSTs the
                                                            one-click unsubscribe (a REAL recipient opt-out — needs --yes)
  openwop email public preferences <token> [--html] [--set email=on,sms=off,push=off --yes] [--json]
                                                            GET …/p/{token}; --set POSTs the recipient's channel choices
  openwop email public event <webhookId> --body-file <raw.json> [--header name:value]... [--json]
                                                            POST …/events/{webhookId} — replay a provider bounce/complaint
                                                            batch byte-for-byte (so its signature header still verifies)
The unsubscribe/preferences pages are HTML: the CLI prints the status + content type
(add --html for the page). Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown
token/webhook, 409 = re-grant refused); 4 = 'event' signature rejected (401); 1 server error.
`;


export async function runEmail(ctx: Ctx, argv: string[]) {
  const group = argv[0];
  if (group === '--help' || group === '-h' || group === undefined) { write(ctx.io.stdout, EMAIL_HELP); return group === undefined ? 2 : 0; }
  const rest = argv.slice(1);
  const ext = await dispatchSpecs(ctx, 'email', EMAIL_EXT_SPECS, argv);
  if (ext !== undefined) return ext;
  if (group === 'templates') return emailTemplates(ctx, rest);
  if (group === 'campaigns') return emailCampaigns(ctx, rest);
  if (group === 'public') return dispatchTable(ctx, 'email public', EMAIL_HELP, EMAIL_PUBLIC, rest, '--help');
  throw new CliError(`Unknown email command: ${group}. Use 'templates', 'campaigns', 'settings', 'provider-status', 'webhooks' or 'public'.`);
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

// ── public recipient legs (/v1/host/openwop-app/public-email/*) ──────────────
const PUB_EMAIL = `${APP}/public-email`;

function pageResult(ctx: Ctx, res: RawResponse, html: boolean, extra: Record<string, unknown> = {}): number {
  if (ctx.json) { writeJson(ctx.io.stdout, rawJson(res, extra)); return res.status >= 400 ? 2 : 0; }
  writeLine(ctx.io.stdout, `status: ${res.status}`);
  writeLine(ctx.io.stdout, `contentType: ${res.contentType || '(none)'}`);
  for (const [k, v] of Object.entries(extra)) writeLine(ctx.io.stdout, `${k}: ${v}`);
  if (html) writeText(ctx, res.text());
  return res.status >= 400 ? 2 : 0;
}

const CHANNELS = ['email', 'sms', 'push'];

function parseChannelSet(raw: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!CHANNELS.includes(k)) throw new CliError(`--set channel must be one of: ${CHANNELS.join(', ')} (got ${k}).`, 2);
    if (v !== 'on' && v !== 'off') throw new CliError(`--set ${k} must be on or off.`, 2);
    out[k] = v === 'on';
  }
  return out;
}

const EMAIL_PUBLIC: Record<string, Cmd> = {
  open: {
    usage: 'open <token> [--json]', args: 1,
    run: async (ctx, a) => {
      const res = await requestRaw(ctx, `${PUB_EMAIL}/o/${enc(a.positionals[0])}`, { auth: false });
      return pageResult(ctx, res, false, { bytes: res.bytes.length });
    },
  },
  click: {
    usage: 'click <token> [--json]', args: 1,
    run: async (ctx, a) => {
      const res = await requestRaw(ctx, `${PUB_EMAIL}/c/${enc(a.positionals[0])}`, { auth: false, redirect: 'manual', throwOnError: false });
      const location = res.headers.get('location') ?? '';
      if (ctx.json) { writeJson(ctx.io.stdout, { status: res.status, location: location || null }); return res.status >= 400 ? 2 : 0; }
      if (res.status >= 300 && res.status < 400) { writeLine(ctx.io.stdout, `redirect: ${res.status} -> ${location}`); return 0; }
      writeLine(ctx.io.stderr, `openwop: HTTP ${res.status}: ${res.text().trim() || 'no redirect'}`);
      return res.status >= 500 ? 1 : 2;
    },
  },
  unsubscribe: {
    usage: 'unsubscribe <token> [--html] [--confirm --yes] [--json]', args: 1, bool: ['--html', '--confirm', '--yes'],
    run: async (ctx, a) => {
      const path = `${PUB_EMAIL}/u/${enc(a.positionals[0])}`;
      if (!a.options.confirm) return pageResult(ctx, await requestRaw(ctx, path, { auth: false, throwOnError: false }), !!a.options.html);
      if (!a.options.yes) { writeLine(ctx.io.stderr, 'Refusing to unsubscribe this recipient without --yes.'); return 2; }
      const res = await requestRaw(ctx, path, { method: 'POST', auth: false, throwOnError: false, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
      return pageResult(ctx, res, !!a.options.html, { unsubscribed: res.status === 200 });
    },
  },
  preferences: {
    usage: 'preferences <token> [--html] [--set email=on,sms=off,push=off --yes] [--json]', args: 1, bool: ['--html', '--yes'], value: ['--set'],
    run: async (ctx, a) => {
      const path = `${PUB_EMAIL}/p/${enc(a.positionals[0])}`;
      if (a.options.set === undefined) return pageResult(ctx, await requestRaw(ctx, path, { auth: false, throwOnError: false }), !!a.options.html);
      const choice = parseChannelSet(String(a.options.set));
      if (!a.options.yes) { writeLine(ctx.io.stderr, "Refusing to change this recipient's preferences without --yes."); return 2; }
      const form = new URLSearchParams();
      for (const [ch, on] of Object.entries(choice)) if (on) form.set(ch, 'on');
      const res = await requestRaw(ctx, path, { method: 'POST', auth: false, throwOnError: false, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      return pageResult(ctx, res, !!a.options.html, { saved: res.status === 200 });
    },
  },
  event: {
    usage: 'event <webhookId> --body-file <raw.json> [--header name:value]... [--json]', args: 1, value: ['--body-file'], multi: ['--header'], requires: ['bodyFile'],
    run: async (ctx, a) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      for (const h of a.options.header ?? []) {
        const i = String(h).indexOf(':');
        if (i <= 0) throw new CliError(`--header must be name:value (got ${h}).`, 2);
        headers[String(h).slice(0, i).trim().toLowerCase()] = String(h).slice(i + 1).trim();
      }
      const raw = readText(ctx, String(a.options.bodyFile), '--body-file');
      const res = await requestRaw(ctx, `${PUB_EMAIL}/events/${enc(a.positionals[0])}`, { method: 'POST', auth: false, headers, body: raw, throwOnError: false });
      let parsed: any = null;
      try { parsed = JSON.parse(res.text()); } catch { parsed = { status: res.status, body: res.text() }; }
      if (ctx.json) writeJson(ctx.io.stdout, parsed);
      else if (res.status < 400 || res.status === 503) writeLine(ctx.io.stdout, `received: ${parsed?.received} suppressed: ${parsed?.suppressed ?? 0} escalated: ${parsed?.escalated ?? 0} failed: ${parsed?.failed ?? 0}`);
      else writeLine(ctx.io.stderr, `openwop: HTTP ${res.status}: ${res.text().trim()}`);
      if (res.status === 401 || res.status === 403) return 4;
      return res.status >= 500 ? 1 : res.status >= 400 ? 2 : 0;
    },
  },
};

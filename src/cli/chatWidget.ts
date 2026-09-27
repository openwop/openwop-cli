import type { Ctx } from '../context.js';
/** `openwop chat-widget ...` — embeddable chat widgets (feature: chat-widget). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { dispatchSpecs, specsUsage, type CommandSpec } from './resourceCommands.js';

/** ADR 0469 Phase B — the workspace tool catalog the anonymous-visitor grant editor picks from. */
export const CHAT_WIDGET_EXT_SPECS: CommandSpec[] = [
  { cmd: ['tool-catalog'], method: 'GET', route: '/v1/host/openwop-app/chat-widget/orgs/:org/tool-catalog', summary: 'Tools a widget can grant to anonymous visitors (read-only).' },
];
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { APP, dispatchTable, detail, qs, requestRaw, writeText, type Cmd } from './marketingShared.js';

const base = (org: string) => `/v1/host/openwop-app/chat-widget/orgs/${encodeURIComponent(org)}/widgets`;

export const CHAT_WIDGET_HELP = `Usage:
  openwop chat-widget list --org <orgId> [--json]
  openwop chat-widget get <widgetId> --org <orgId> [--json]
  openwop chat-widget create --org <orgId> [--name <n>] [--json]
  openwop chat-widget update <widgetId> --org <orgId> [--name <n>] [--json]
  openwop chat-widget delete <widgetId> --org <orgId> [--yes]
  openwop chat-widget rotate-token <widgetId> --org <orgId> [--json]
${specsUsage('chat-widget', CHAT_WIDGET_EXT_SPECS)}

Embeddable chat widgets (host-extension, org-scoped). Each widget carries an embed
token; \`rotate-token\` invalidates the old one. Every command needs --org.

Public visitor legs (UNAUTHENTICATED — exactly what the embedded widget calls; no --org):
  openwop chat-widget public config --token <t> --origin <https://site> [--json]
      GET /v1/host/openwop-app/public/widget/config?token=… — the public projection
      (widgetId, agentId, caps, businessName, privacyUrl).
  openwop chat-widget public message --token <t> --origin <https://site> --message <text> [--session <id>] [--json]
      POST /v1/host/openwop-app/public/widget/message — one visitor turn; prints the reply.
      Counts against the widget's per-session/day caps (429 when exhausted).
  openwop chat-widget public embed [--out <file>]
      GET /v1/host/openwop-app/public/widget/embed.js — the served embed script.
--origin is sent as the Origin header and must be on the widget's allowed-domain
list (403 otherwise); the token is the embed token from 'create'/'rotate-token'.
Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown token, 429 = cap hit);
4 = origin not allowed (403); 1 server error.
`;


export async function runChatWidget(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CHAT_WIDGET_HELP); return 0; }
  const ext = await dispatchSpecs(ctx, 'chat-widget', CHAT_WIDGET_EXT_SPECS, argv);
  if (ext !== undefined) return ext;
  if (sub === 'public') return dispatchTable(ctx, 'chat-widget public', CHAT_WIDGET_HELP, WIDGET_PUBLIC, argv.slice(1), '--help');
  const args = argv.slice(['list', 'get', 'create', 'update', 'delete', 'rotate-token'].includes(sub) ? 1 : 0);
  const { options, positionals } = parseOptions(args, { bool: ['--help', '--yes'], value: ['--org', '--name'] });
  if (options.help) { write(ctx.io.stdout, CHAT_WIDGET_HELP); return 0; }
  const org = requireOrg(options.org);
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, base(org));
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.widgets) ? res.body.widgets : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No widgets.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((w: any) => ({ id: w.id ?? w.widgetId ?? '', name: w.name ?? '', createdAt: w.createdAt ?? '' })), ['id', 'name', 'createdAt']));
      return 0;
    }
    case 'get': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop chat-widget get <widgetId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`); writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      const body: Record<string, string> = {};
      if (options.name) body.name = String(options.name);
      const res = await requestJson(ctx, base(org), { method: 'POST', body });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Created widget ${res.body?.widget?.id ?? res.body?.id ?? ''}.`);
      return 0;
    }
    case 'update': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop chat-widget update <widgetId> --org <orgId> [--name n]\n'); return 2; }
      const patch: Record<string, string> = {};
      if (options.name) patch.name = String(options.name);
      const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body: patch });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Updated widget ${positionals[0]}.`);
      return 0;
    }
    case 'delete': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop chat-widget delete <widgetId> --org <orgId> [--yes]\n'); return 2; }
      if (!options.yes) throw new CliError(`Refusing to delete widget ${positionals[0]} without --yes.`, 2);
      await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted widget ${positionals[0]}.`); return 0;
    }
    case 'rotate-token': {
      if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop chat-widget rotate-token <widgetId> --org <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `${base(org)}/${encodeURIComponent(positionals[0])}/rotate-token`, { method: 'POST', body: {} });
      if (ctx.json) writeJson(ctx.io.stdout, res.body); else writeLine(ctx.io.stdout, `Rotated token for widget ${positionals[0]}.`);
      return 0;
    }
    default: throw new CliError(`Unknown chat-widget command: ${sub}\nRun \`openwop chat-widget --help\` for usage.`);
  }
}

// ── public visitor legs (/v1/host/openwop-app/public/widget/*) ───────────────
const PUB_WIDGET = `${APP}/public/widget`;

const WIDGET_PUBLIC: Record<string, Cmd> = {
  config: {
    usage: 'config --token <t> --origin <https://site> [--json]', args: 0, value: ['--token', '--origin'], requires: ['token', 'origin'],
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${PUB_WIDGET}/config${qs({ token: a.options.token })}`, { auth: false, headers: { origin: String(a.options.origin) } })).body),
  },
  message: {
    usage: 'message --token <t> --origin <https://site> --message <text> [--session <id>] [--json]',
    args: 0, value: ['--token', '--origin', '--message', '--session'], requires: ['token', 'origin', 'message'],
    run: async (ctx, a) => {
      const o = a.options;
      const body: Record<string, unknown> = { token: String(o.token), message: String(o.message), hp: '' };
      if (o.session !== undefined) body.sessionId = String(o.session);
      const res = (await requestJson(ctx, `${PUB_WIDGET}/message`, { method: 'POST', body, auth: false, headers: { origin: String(o.origin) } })).body;
      if (ctx.json) { writeJson(ctx.io.stdout, res); return 0; }
      writeLine(ctx.io.stdout, String(res?.reply ?? ''));
      return 0;
    },
  },
  embed: {
    usage: 'embed [--out <file>]', args: 0, value: ['--out'],
    run: async (ctx, a) => {
      const res = await requestRaw(ctx, `${PUB_WIDGET}/embed.js`, { auth: false });
      if (a.options.out) {
        const file = resolvePath(ctx.cwd, String(a.options.out));
        writeFileSync(file, res.bytes);
        writeLine(ctx.io.stdout, `Saved the embed script (${res.bytes.length} bytes) to ${file}.`);
        return 0;
      }
      writeText(ctx, res.text());
      return 0;
    },
  },
};

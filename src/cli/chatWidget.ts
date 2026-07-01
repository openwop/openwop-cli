import type { Ctx } from '../context.js';
/** `openwop chat-widget ...` — embeddable chat widgets (feature: chat-widget). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const base = (org: string) => `/v1/host/sample/chat-widget/orgs/${encodeURIComponent(org)}/widgets`;

export const CHAT_WIDGET_HELP = `Usage:
  openwop chat-widget list --org <orgId> [--json]
  openwop chat-widget get <widgetId> --org <orgId> [--json]
  openwop chat-widget create --org <orgId> [--name <n>] [--json]
  openwop chat-widget update <widgetId> --org <orgId> [--name <n>] [--json]
  openwop chat-widget delete <widgetId> --org <orgId> [--yes]
  openwop chat-widget rotate-token <widgetId> --org <orgId> [--json]

Embeddable chat widgets (host-extension, org-scoped). Each widget carries an embed
token; \`rotate-token\` invalidates the old one. Every command needs --org.
`;

function requireOrg(org: unknown): string {
  if (!org) throw new CliError('This command is org-scoped — pass --org <orgId>.', 2);
  return String(org);
}

export async function runChatWidget(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CHAT_WIDGET_HELP); return 0; }
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

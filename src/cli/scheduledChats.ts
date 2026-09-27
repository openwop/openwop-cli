import type { Ctx } from '../context.js';
/**
 * `openwop scheduled-chats …` — scheduled agent chats (openwop-app ADR 0125
 * scheduled agent chats; ADR 0202 D3 channel scope + D6 target validation).
 *
 * An agent is prompted on a cron schedule and replies into a conversation. Two
 * scopes share ONE host service + scheduler:
 *   ORG     /v1/host/openwop-app/scheduled-chats/orgs/{orgId}/chats      (workspace RBAC)
 *   CHANNEL /v1/host/openwop-app/scheduled-chats/channels/{channelId}/chats
 *           (channel owner manages; members list; replies always post in-channel)
 * The host validates the agent + the target conversation and the cron
 * expression; the CLI forwards the fields and renders the host's answer.
 */
import { CliError } from '../errors.js';
import { write, writeLine, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, emit, writeFields } from './chatShared.js';

export const SCHEDULED_CHATS_HELP = `Usage:
  openwop scheduled-chats list (--org <orgId> | --channel <channelId>) [--json]
  openwop scheduled-chats get <chatId> --org <orgId> [--json]
  openwop scheduled-chats create (--org <orgId> --conversation <id> | --channel <channelId>)
                                 --agent <agentId> --prompt <text> --cron <expr>
                                 [--timezone <tz>] [--workflow <workflowId>] [--json]
  openwop scheduled-chats pause|resume <chatId> (--org <orgId> | --channel <channelId>) [--json]
  openwop scheduled-chats delete <chatId> (--org <orgId> | --channel <channelId>) --yes

Schedule an agent to be prompted on a cron and reply into a conversation.
Org scope: /v1/host/openwop-app/scheduled-chats/orgs/{orgId}/chats[/{chatId}[/pause]]
(needs workspace read/write). Channel scope:
/v1/host/openwop-app/scheduled-chats/channels/{channelId}/chats[/{chatId}[/pause]]
(the channel owner creates and manages; the agent must be a channel member; the
reply always posts in the channel). 'pause' sends { enabled: false },
'resume' { enabled: true }. The server has no single-chat read on the channel
scope, so 'get' is org-only (use 'list --channel').

Exit codes: 0 ok, 2 usage / not found / invalid cron, 4 not permitted.

Examples:
  openwop scheduled-chats create --org org_1 --conversation conv_1 --agent core.openwop.agents.planner.default \\
      --prompt "Post the weekly status" --cron "0 9 * * 1" --timezone America/New_York
  openwop scheduled-chats list --channel chan_1
  openwop scheduled-chats pause sch_1 --org org_1
`;

function scopeBase(options: Record<string, any>): string {
  if (options.org && options.channel) throw new CliError('Pass --org OR --channel, not both.', 2);
  if (options.org) return `/v1/host/openwop-app/scheduled-chats/orgs/${enc(options.org)}/chats`;
  if (options.channel) return `/v1/host/openwop-app/scheduled-chats/channels/${enc(options.channel)}/chats`;
  throw new CliError('Scheduled chats are scoped — pass --org <orgId> or --channel <channelId>.', 2);
}

const row = (c: any) => ({
  chatId: c.chatId, agent: c.agentId ?? '', cron: c.cronExpr ?? '', enabled: c.enabled ? 'yes' : 'no',
  nextRunAt: c.nextRunAt ?? '', lastRunAt: c.lastRunAt ?? '', prompt: String(c.prompt ?? '').slice(0, 40),
});

export async function runScheduledChats(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, SCHEDULED_CHATS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--org', '--channel', '--conversation', '--agent', '--prompt', '--cron', '--timezone', '--workflow'],
  });
  if (options.help) { write(ctx.io.stdout, SCHEDULED_CHATS_HELP); return 0; }
  const chatId = positionals[0];
  const needChat = (base: string) => {
    if (!chatId) throw new CliError(`scheduled-chats ${sub} requires <chatId>.`, 2);
    return `${base}/${enc(chatId)}`;
  };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, scopeBase(options));
      return emit(ctx, res.body, () => {
        const chats = Array.isArray(res.body?.chats) ? res.body.chats : [];
        if (!chats.length) { writeLine(ctx.io.stdout, 'No scheduled chats.'); return; }
        writeLine(ctx.io.stdout, formatTable(chats.map(row), ['chatId', 'agent', 'cron', 'enabled', 'nextRunAt', 'lastRunAt', 'prompt']));
      });
    }
    case 'get': {
      if (!options.org) throw new CliError('scheduled-chats get is org-scoped — pass --org <orgId> (use `list --channel` for a channel).', 2);
      const res = await requestJson(ctx, needChat(scopeBase(options)));
      const c = res.body?.chat ?? {};
      return emit(ctx, res.body, () => writeFields(ctx, [
        ['chatId', c.chatId], ['agentId', c.agentId], ['conversationId', c.conversationId], ['prompt', c.prompt],
        ['cronExpr', c.cronExpr], ['timezone', c.timezone], ['workflowId', c.workflowId], ['enabled', c.enabled ? 'yes' : 'no'],
        ['createdBy', c.createdBy], ['createdAt', c.createdAt], ['updatedAt', c.updatedAt],
      ]));
    }
    case 'create': {
      const base = scopeBase(options);
      if (!options.agent || !options.prompt || !options.cron) throw new CliError('scheduled-chats create requires --agent, --prompt, and --cron.', 2);
      if (options.org && !options.conversation) throw new CliError('An org-scoped scheduled chat needs --conversation <id> (the conversation the agent replies into).', 2);
      const body: Record<string, any> = { agentId: options.agent, prompt: options.prompt, cronExpr: options.cron };
      if (options.conversation) body.conversationId = options.conversation;
      if (options.timezone) body.timezone = options.timezone;
      if (options.workflow) body.workflowId = options.workflow;
      const res = await requestJson(ctx, base, { method: 'POST', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Scheduled chat ${res.body?.chat?.chatId} (${options.cron}) for ${options.agent}.`));
    }
    case 'pause': case 'resume': {
      const enabled = sub === 'resume';
      const res = await requestJson(ctx, `${needChat(scopeBase(options))}/pause`, { method: 'POST', body: { enabled } });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `${enabled ? 'Resumed' : 'Paused'} scheduled chat ${chatId}.`));
    }
    case 'delete': case 'rm': {
      const path = needChat(scopeBase(options));
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete scheduled chat ${chatId} without --yes.`); return 2; }
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted scheduled chat ${chatId}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown scheduled-chats command: ${sub}\nRun \`openwop scheduled-chats --help\` for usage.`, 2);
  }
}

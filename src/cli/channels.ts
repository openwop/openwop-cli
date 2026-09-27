import type { Ctx } from '../context.js';
/**
 * `openwop channels …` — team channels (openwop-app ADR 0126 team channels,
 * ADR 0154 discovery/agents/live stream, ADR 0192 membership + display
 * identities, ADR 0202 agent reply policy + AI catch-up, RFC 0110 channel
 * presence).
 *
 * Host-extension surface under /v1/host/openwop-app/channels/*. Membership is
 * enforced by the host (a private channel you are not in is a 404; owner-only
 * management answers 403). Distinct from `openwop relay` / `messaging`, which
 * drive external chat networks (Signal, WhatsApp, iMessage) — this is the
 * server's own Slack-style channels.
 */
import { CliError } from '../errors.js';
import { write, writeLine, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, emit, intFlag, renderFrame, streamHostSse, writeFields } from './chatShared.js';

const BASE = '/v1/host/openwop-app/channels';

export const CHANNELS_HELP = `Usage:
  openwop channels list [--json]
  openwop channels create --name <n> [--description d] [--private] [--member <userId>]... [--agent <agentId>]... [--json]
  openwop channels get <channelId> [--json]
  openwop channels update <channelId> [--name n] [--description d] [--json]
  openwop channels archive <channelId> --yes
  openwop channels join <channelId> [--json]
  openwop channels leave <channelId>
  openwop channels messages <channelId> [--limit n] [--before <cursor>] [--json]
  openwop channels post <channelId> --content <text> [--json]
  openwop channels stream <channelId> [--max-events n] [--timeout-ms ms] [--json]
  openwop channels members add <channelId> (--user <userId> | --agent <agentId>) [--json]
  openwop channels members remove <channelId> <userId> [--json]
  openwop channels agents remove <channelId> <agentId> [--json]
  openwop channels agents policy <channelId> <agentId> all|mention [--json]
  openwop channels catchup <channelId> [--json]
  openwop channels presence <channelId> [--max-events n] [--timeout-ms ms] [--json]
  openwop channels presence-snapshot <channelId> [--json]
  openwop channels typing <channelId> [--stop]

The server's team channels (/v1/host/openwop-app/channels/*):

  list/create        GET|POST /channels (public channels + your private ones)
  get/update         GET|PATCH /channels/{id} (rename / describe: owner only)
  archive            POST /channels/{id}/archive (owner only)
  join/leave         POST /channels/{id}/join, DELETE /channels/{id}/members/me
  messages/post      GET|POST /channels/{id}/messages (--limit pages newest first;
                     pass nextCursor as --before for older pages)
  stream             GET /channels/{id}/stream — live new-message ids (server-sent events)
  members            POST /channels/{id}/members, DELETE /channels/{id}/members/{userId}
  agents             DELETE /channels/{id}/agents/{agentId},
                     PUT /channels/{id}/agents/{agentId}/policy { policy: all|mention }
  catchup            POST /channels/{id}/catchup — an agent summarizes what you missed;
                     returns a runId (follow it with \`openwop runs events <runId>\`)
  presence           GET /channels/{id}/presence (live stream; only when the operator enabled presence)
  presence-snapshot  GET /channels/{id}/presence/snapshot
  typing             POST /channels/{id}/presence/typing { typing }

Streams stop after --max-events frames or --timeout-ms (default 30000 ms).
Exit codes: 0 ok, 2 usage / not found, 4 not a member or not the owner.

Examples:
  openwop channels create --name launch --agent core.openwop.agents.planner.default
  openwop channels post <channelId> --content "@planner draft the agenda"
  openwop channels agents policy <channelId> core.openwop.agents.planner.default mention
  openwop channels stream <channelId> --max-events 5
`;

export async function runChannels(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': return await runList(ctx, rest);
    case 'create': return await runCreate(ctx, rest);
    case 'get': case 'show': return await runGet(ctx, rest);
    case 'update': return await runUpdate(ctx, rest);
    case 'archive': return await runArchive(ctx, rest);
    case 'join': return await runJoin(ctx, rest);
    case 'leave': return await runLeave(ctx, rest);
    case 'messages': return await runMessages(ctx, rest);
    case 'post': case 'send': return await runPost(ctx, rest);
    case 'stream': return await runStream(ctx, rest, 'stream');
    case 'members': return await runMembers(ctx, rest);
    case 'agents': return await runAgents(ctx, rest);
    case 'catchup': return await runCatchup(ctx, rest);
    case 'presence': return await runStream(ctx, rest, 'presence');
    case 'presence-snapshot': return await runPresenceSnapshot(ctx, rest);
    case 'typing': return await runTyping(ctx, rest);
    default:
      throw new CliError(`Unknown channels command: ${sub}\nRun \`openwop channels --help\` for usage.`, 2);
  }
}

function oneId(argv: string[], usage: string, spec: { bool?: string[]; value?: string[]; multi?: string[] } = {}) {
  const { options, positionals } = parseOptions(argv, { ...spec, bool: ['--help', ...(spec.bool ?? [])] });
  if (options.help) return { help: true as const, options, positionals };
  if (!positionals[0]) throw new CliError(`Usage: openwop channels ${usage}`, 2);
  return { help: false as const, options, positionals, path: `${BASE}/${enc(positionals[0])}` };
}

function channelSummary(res: any): string {
  const c = res?.channel ?? {};
  const name = c.channel?.name ?? c.name ?? '';
  return `${c.conversationId ?? ''}${name ? ` (#${name})` : ''}`;
}

async function runList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const res = await requestJson(ctx, BASE);
  return emit(ctx, res.body, () => {
    const rows = Array.isArray(res.body?.channels) ? res.body.channels : [];
    if (!rows.length) { writeLine(ctx.io.stdout, 'No channels. Create one with `openwop channels create --name <n>`.'); return; }
    writeLine(ctx.io.stdout, formatTable(rows.map((c: any) => ({
      channelId: c.conversationId, name: c.channel?.name ?? '', visibility: c.channel?.visibility ?? '', joined: c.joined ? 'yes' : 'no',
      members: String(c.memberCount ?? ''), agents: String(c.agentCount ?? ''), unread: c.unreadCount === undefined ? '' : String(c.unreadCount),
      lastActivityAt: c.lastActivityAt ?? '',
    })), ['channelId', 'name', 'visibility', 'joined', 'members', 'agents', 'unread', 'lastActivityAt']));
  });
}

async function runCreate(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, {
    bool: ['--help', '--private'],
    value: ['--name', '--description'],
    multi: ['--member', '--agent'],
  });
  if (options.help || !options.name) {
    write(ctx.io.stdout, 'Usage: openwop channels create --name <n> [--description d] [--private] [--member <userId>]... [--agent <agentId>]... [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = { name: options.name, visibility: options.private ? 'private' : 'public' };
  if (options.description) body.description = options.description;
  if (Array.isArray(options.member) && options.member.length) body.memberUserIds = options.member;
  if (Array.isArray(options.agent) && options.agent.length) body.agentIds = options.agent;
  const res = await requestJson(ctx, BASE, { method: 'POST', body });
  return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Created channel ${channelSummary(res.body)}.`));
}

async function runGet(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'get <channelId> [--json]');
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const res = await requestJson(ctx, p.path);
  const c = res.body?.channel ?? {};
  return emit(ctx, res.body, () => {
    writeFields(ctx, [
      ['channelId', c.conversationId], ['name', c.channel?.name], ['description', c.channel?.description],
      ['visibility', c.channel?.visibility], ['archived', c.channel?.archived ? 'yes' : undefined], ['owner', c.ownerUserId],
      ['youAreOwner', c.viewerIsOwner ? 'yes' : 'no'], ['you', c.viewerSubjectRef],
    ]);
    const roster = Array.isArray(c.roster) ? c.roster : [];
    if (roster.length) {
      writeLine(ctx.io.stdout, 'roster:');
      writeLine(ctx.io.stdout, formatTable(roster.map((r: any) => ({ subjectRef: r.subjectRef, name: r.displayName ?? '', kind: r.kind ?? '', role: r.role ?? '', replyPolicy: r.responsePolicy ?? '' })), ['subjectRef', 'name', 'kind', 'role', 'replyPolicy']));
    }
  });
}

async function runUpdate(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'update <channelId> [--name n] [--description d]', { value: ['--name', '--description'] });
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const body: Record<string, any> = {};
  if (typeof p.options.name === 'string') body.name = p.options.name;
  if (typeof p.options.description === 'string') body.description = p.options.description;
  if (!Object.keys(body).length) throw new CliError('Nothing to update — pass --name and/or --description.', 2);
  const res = await requestJson(ctx, p.path, { method: 'PATCH', body });
  return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Updated channel ${channelSummary(res.body)}.`));
}

async function runArchive(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'archive <channelId> --yes', { bool: ['--yes'] });
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  if (!p.options.yes) { writeLine(ctx.io.stderr, `Refusing to archive channel ${p.positionals[0]} without --yes.`); return 2; }
  await requestJson(ctx, `${p.path}/archive`, { method: 'POST', body: {} });
  writeLine(ctx.io.stdout, `Archived channel ${p.positionals[0]}.`);
  return 0;
}

async function runJoin(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'join <channelId>');
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const res = await requestJson(ctx, `${p.path}/join`, { method: 'POST', body: {} });
  return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Joined channel ${channelSummary(res.body) || p.positionals[0]}.`));
}

async function runLeave(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'leave <channelId>');
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  await requestJson(ctx, `${p.path}/members/me`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Left channel ${p.positionals[0]}.`);
  return 0;
}

async function runMessages(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'messages <channelId> [--limit n] [--before <cursor>]', { value: ['--limit', '--before'] });
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const q = new URLSearchParams();
  if (p.options.limit !== undefined) q.set('limit', String(p.options.limit));
  if (p.options.before) q.set('before', p.options.before);
  const res = await requestJson(ctx, `${p.path}/messages${q.size ? `?${q}` : ''}`);
  return emit(ctx, res.body, () => {
    const msgs = Array.isArray(res.body?.messages) ? res.body.messages : [];
    if (!msgs.length) { writeLine(ctx.io.stdout, 'No messages.'); return; }
    for (const m of msgs) {
      const who = m.authorDisplayName ?? m.authorSubject ?? m.role;
      const reactions = Array.isArray(m.reactions) && m.reactions.length ? `  [${m.reactions.map((r: any) => `${r.emoji}${r.count ?? ''}`).join(' ')}]` : '';
      writeLine(ctx.io.stdout, `${m.createdAt ?? ''} ${who}: ${m.content}${reactions}`);
    }
    if (res.body?.nextCursor) writeLine(ctx.io.stdout, `(older messages: --before ${res.body.nextCursor})`);
  });
}

async function runPost(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'post <channelId> --content <text>', { value: ['--content'] });
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  if (typeof p.options.content !== 'string') throw new CliError('channels post requires --content <text>.', 2);
  const res = await requestJson(ctx, `${p.path}/messages`, { method: 'POST', body: { content: p.options.content } });
  return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Posted ${res.body?.messageId} to ${p.positionals[0]}.`));
}

async function runStream(ctx: Ctx, argv: string[], which: 'stream' | 'presence'): Promise<number> {
  const p = oneId(argv, `${which} <channelId> [--max-events n] [--timeout-ms ms]`, { value: ['--max-events', '--timeout-ms'] });
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const maxFrames = intFlag(p.options.maxEvents, '--max-events');
  const timeoutMs = intFlag(p.options.timeoutMs, '--timeout-ms') ?? 30000;
  const frames = await streamHostSse(ctx, `${p.path}/${which}`, {
    maxFrames,
    timeoutMs,
    onFrame: (frame) => writeLine(ctx.io.stdout, ctx.json ? JSON.stringify(frame) : renderFrame(frame)),
  });
  if (!ctx.json && frames === 0) writeLine(ctx.io.stdout, `No ${which === 'stream' ? 'new messages' : 'presence frames'} within ${timeoutMs} ms.`);
  return 0;
}

async function runMembers(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, CHANNELS_HELP); return sub ? 0 : 2; }
  if (sub === 'add') {
    const p = oneId(argv.slice(1), 'members add <channelId> (--user <userId> | --agent <agentId>)', { value: ['--user', '--agent'] });
    if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
    const body: Record<string, any> = {};
    if (p.options.agent) body.agentId = p.options.agent;
    else if (p.options.user) body.userId = p.options.user;
    else throw new CliError('channels members add requires --user <userId> or --agent <agentId>.', 2);
    const res = await requestJson(ctx, `${p.path}/members`, { method: 'POST', body });
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Added ${body.agentId ? `agent ${body.agentId}` : `user ${body.userId}`} to ${p.positionals[0]}.`));
  }
  if (sub === 'remove') {
    const p = oneId(argv.slice(1), 'members remove <channelId> <userId>');
    if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
    const userId = p.positionals[1];
    if (!userId) throw new CliError('Usage: openwop channels members remove <channelId> <userId>', 2);
    const res = await requestJson(ctx, `${p.path}/members/${enc(userId)}`, { method: 'DELETE' });
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Removed user ${userId} from ${p.positionals[0]}.`));
  }
  throw new CliError(`Unknown channels members command: ${sub}\nRun \`openwop channels --help\` for usage.`, 2);
}

async function runAgents(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, CHANNELS_HELP); return sub ? 0 : 2; }
  const p = oneId(argv.slice(1), `agents ${sub} <channelId> <agentId>${sub === 'policy' ? ' all|mention' : ''}`);
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const agentId = p.positionals[1];
  if (!agentId) throw new CliError(`Usage: openwop channels agents ${sub} <channelId> <agentId>`, 2);
  if (sub === 'remove') {
    const res = await requestJson(ctx, `${p.path}/agents/${enc(agentId)}`, { method: 'DELETE' });
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Removed agent ${agentId} from ${p.positionals[0]}.`));
  }
  if (sub === 'policy') {
    const policy = p.positionals[2];
    if (policy !== 'all' && policy !== 'mention') throw new CliError('channels agents policy takes all or mention.', 2);
    const res = await requestJson(ctx, `${p.path}/agents/${enc(agentId)}/policy`, { method: 'PUT', body: { policy } });
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Agent ${agentId} now replies to ${policy === 'all' ? 'every message' : 'mentions only'} in ${p.positionals[0]}.`));
  }
  throw new CliError(`Unknown channels agents command: ${sub}\nRun \`openwop channels --help\` for usage.`, 2);
}

async function runCatchup(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'catchup <channelId>');
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const res = await requestJson(ctx, `${p.path}/catchup`, { method: 'POST', body: {} });
  return emit(ctx, res.body, () => {
    writeLine(ctx.io.stdout, `Catch-up started: run ${res.body?.runId} (${res.body?.unreadCount ?? 0} unread message(s)).`);
    writeLine(ctx.io.stdout, `Follow it: openwop runs events ${res.body?.runId}`);
  });
}

async function runPresenceSnapshot(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'presence-snapshot <channelId>');
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const res = await requestJson(ctx, `${p.path}/presence/snapshot`);
  return emit(ctx, res.body, () => {
    const present = Array.isArray(res.body?.present) ? res.body.present : [];
    const typing = Array.isArray(res.body?.typing) ? res.body.typing : [];
    writeLine(ctx.io.stdout, `present: ${present.length ? present.join(', ') : '(none)'}`);
    writeLine(ctx.io.stdout, `typing: ${typing.length ? typing.join(', ') : '(none)'}`);
  });
}

async function runTyping(ctx: Ctx, argv: string[]): Promise<number> {
  const p = oneId(argv, 'typing <channelId> [--stop]', { bool: ['--stop'] });
  if (p.help) { write(ctx.io.stdout, CHANNELS_HELP); return 0; }
  const typing = !p.options.stop;
  await requestJson(ctx, `${p.path}/presence/typing`, { method: 'POST', body: { typing } });
  return emit(ctx, { channelId: p.positionals[0], typing }, () => writeLine(ctx.io.stdout, `${typing ? 'Typing' : 'Stopped typing'} in ${p.positionals[0]}.`));
}

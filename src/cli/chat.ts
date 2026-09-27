import type { Ctx } from '../context.js';
/**
 * `openwop chat …` — the ONE chat group.
 *
 *  - `openwop chat <workflowId>` (or `chat repl <workflowId>`) — the interactive
 *    streaming REPL over the normative run surface (POST /v1/runs + the run event
 *    stream).
 *  - `openwop chat sessions|messages|participants|open|feedback|models|search|
 *    export|import|tools …` — the host's persistent conversation primitive
 *    (RFC 0005 conversations; openwop-app ADR 0043 conversations, ADR 0071/0102
 *    feedback, ADR 0112 search, ADR 0119 export/import, ADR 0124 model
 *    capabilities, ADR 0132 per-conversation tool scope, ADR 0195 reactions) under
 *    /v1/host/openwop-app/chat/*, /chat-export/* and /conversation-tools/*.
 *    Host-extension surfaces: non-normative, tenant-scoped, visibility-gated by
 *    the host (a conversation you cannot see is a 404).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { buildInputs } from './shared.js';
import { submitTurn, streamRunEvents, renderEvent, extractAssistantText, defaultReadTurn } from '../sse.js';
import { enc, emit, intFlag, writeFields } from './chatShared.js';
import { idempotencyHeaders } from '../wire.js';

const CHAT_BASE = '/v1/host/openwop-app/chat';
const CHAT_SUBCOMMANDS = ['repl', 'sessions', 'session', 'messages', 'message', 'participants', 'open', 'feedback', 'models', 'search', 'export', 'import', 'tools'];

export const CHAT_HELP = `Usage:
  openwop chat <workflowId> [REPL options]          Interactive streaming REPL (below)
  openwop chat repl <workflowId> [REPL options]     Same, explicit
  openwop chat sessions list|get|create|update|delete|branch|read|board|bind-run ...
  openwop chat messages list|send|edit|delete|react|unreact ...
  openwop chat participants list|add|remove <sessionId> [<subjectRef>]
  openwop chat open --subject <ref> [--type agent|person] [--title t]
  openwop chat feedback set|get <messageId> --conversation <id> ... | feedback list <sessionId>
  openwop chat models
  openwop chat search <query> [--type t] [--role r] [--limit n] [--post]
  openwop chat export <sessionId> [--format md|json] [--output path]
  openwop chat import --file <path> [--format openwop|chatgpt]
  openwop chat tools get|set|approve|deny <sessionId> ...

Run \`openwop chat <subcommand> --help\` for each family's flags. Conversation
commands hit the host's persistent conversations (host extension, not the
normative wire): /v1/host/openwop-app/chat/*, /chat-export/*, and
/conversation-tools/sessions/*. Every read takes --json. Exit codes: 0 ok,
2 usage / not found, 4 not signed in or not permitted, 1 server error.

REPL: openwop chat <workflowId> [options]

Interactive streaming chat REPL. Each message you type creates a run for
<workflowId> carrying the running conversation as a \`messages\` array, then
streams that run's events to the terminal as they arrive. Type /exit (or
/quit, or press Ctrl-D) to leave.

Streaming:
  Prefers Server-Sent Events (GET /v1/runs/{runId}/events). If the host does
  not stream, it falls back to polling GET /v1/runs/{runId}/events/poll.

Options:
  --input k=v        Extra input carried on every turn (JSON-parsed like runs create).
  --inputs-json J    Seed the whole \`inputs\` object (e.g. credentialRef, model, prior messages).
  --role <role>      Role to tag your turns with (default: user).
  --tenant-id <id>   Tenant id for each run.
  --scope-id <id>    Scope id for each run.
  --timeout-ms <ms>  Per-turn stream timeout (default: 120000).
  --no-stream        Skip SSE and poll for events instead.
  --no-history       Send only the latest turn instead of the full conversation.
  --json             Emit raw event records (one JSON object per event) instead of pretty text.

Examples:
  openwop chat sample.chat.turn
  openwop chat sample.chat.turn --inputs-json '{"credentialRef":"anthropic-default"}'
  openwop chat sample.chat.turn --no-stream --json
  openwop chat sessions list
  openwop chat sessions create --title "Launch plan" --type group --participant agent:core.openwop.agents.planner
  openwop chat messages send <sessionId> --content "Summarize the thread"
  openwop chat messages react <sessionId> <messageId> 👍
  openwop chat search "pricing" --limit 5 --json
  openwop chat export <sessionId> --format md --output thread.md
  openwop chat tools set <sessionId> --mode restricted --enable openwop:fs.read
`;

export async function runChat(ctx: Ctx, argv: string[]) {
  const sub = argv[0];
  if (sub && CHAT_SUBCOMMANDS.includes(sub)) {
    const rest = argv.slice(1);
    switch (sub) {
      case 'repl': return await runChatRepl(ctx, rest);
      case 'sessions': case 'session': return await runChatSessions(ctx, rest);
      case 'messages': case 'message': return await runChatMessages(ctx, rest);
      case 'participants': return await runChatParticipants(ctx, rest);
      case 'open': return await runChatOpen(ctx, rest);
      case 'feedback': return await runChatFeedback(ctx, rest);
      case 'models': return await runChatModels(ctx, rest);
      case 'search': return await runChatSearch(ctx, rest);
      case 'export': return await runChatExport(ctx, rest);
      case 'import': return await runChatImport(ctx, rest);
      case 'tools': return await runChatTools(ctx, rest);
    }
  }
  return await runChatRepl(ctx, argv);
}

async function runChatRepl(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--no-stream', '--no-history'],
    value: ['--tenant-id', '--scope-id', '--inputs-json', '--timeout-ms', '--role'],
    multi: ['--input'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, CHAT_HELP);
    return options.help ? 0 : 2;
  }
  const workflowId = positionals[0];
  const timeoutMs = Number(options.timeoutMs ?? 120000);
  const useStream = !options.noStream;
  const keepHistory = !options.noHistory;
  const role = options.role ?? 'user';

  // Seed inputs that ride along on every turn (e.g. credentialRef, model).
  // `--input k=v` / `--inputs-json` carry over so the workflow gets the
  // same configurable shape `runs create` would have produced.
  const baseInputs = buildInputs(options);
  // Conversation history threaded as the `messages` array across turns.
  const messages = Array.isArray(baseInputs.messages) ? [...baseInputs.messages] : [];

  if (!ctx.json) {
    writeLine(ctx.io.stdout, `OpenWOP chat — workflow ${workflowId} @ ${ctx.baseUrl}`);
    writeLine(ctx.io.stdout, 'Type a message and press Enter. /exit or Ctrl-D to quit.');
    writeLine(ctx.io.stdout, '');
  }

  const readTurn = ctx.readTurn ?? defaultReadTurn(ctx);
  while (true) {
    const line = await readTurn('you> ');
    if (line === null) {
      // EOF (Ctrl-D) — graceful exit.
      if (!ctx.json) writeLine(ctx.io.stdout, '');
      break;
    }
    const text = line.trim();
    if (text === '') continue;
    if (text === '/exit' || text === '/quit') break;

    messages.push({ role, content: text });
    const inputs = { ...baseInputs, messages: keepHistory ? messages : [{ role, content: text }] };

    let runId;
    try {
      runId = await submitTurn(ctx, { workflowId, inputs, tenantId: options.tenantId, scopeId: options.scopeId });
    } catch (err) {
      writeLine(ctx.io.stderr, `openwop: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const assistantParts: string[] = [];
    const onEvent = (ev: any) => {
      if (ctx.json) {
        writeJson(ctx.io.stdout, ev);
      } else {
        const rendered = renderEvent(ev);
        if (rendered) writeLine(ctx.io.stdout, rendered);
      }
      const reply = extractAssistantText(ev);
      if (reply) assistantParts.push(reply);
    };

    try {
      await streamRunEvents(ctx, runId, { onEvent, useStream, timeoutMs });
    } catch (err) {
      writeLine(ctx.io.stderr, `openwop: stream error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Thread the assistant reply back into history so the next turn has context.
    if (keepHistory && assistantParts.length > 0) {
      messages.push({ role: 'assistant', content: assistantParts.join('') });
    }
    if (!ctx.json) writeLine(ctx.io.stdout, '');
  }
  return 0;
}

// ── conversation primitive (host extension) ─────────────────────────────────

const SESSIONS_HELP = `Usage:
  openwop chat sessions list [--json]
  openwop chat sessions get <sessionId> [--json]
  openwop chat sessions create [--title t] [--session-id id] [--type agent|person|group|workspace]
                               [--participant <subjectRef>]... [--board-id id] [--json]
  openwop chat sessions update <sessionId> --title t [--json]
  openwop chat sessions delete <sessionId> --yes
  openwop chat sessions branch <sessionId> [--from-seq n] [--json]
  openwop chat sessions read <sessionId>
  openwop chat sessions board <sessionId> --board-id <id> [--json]
  openwop chat sessions bind-run <sessionId> --run-id <runId>

Persistent conversations: GET|POST /v1/host/openwop-app/chat/sessions,
GET|PATCH|DELETE …/chat/sessions/{id}, POST …/{id}/branch (fork at message
--from-seq), POST …/{id}/read (mark read), POST …/{id}/board (convene a board's
cohort), PUT …/{id}/conversation-run (bind the conversation's run).
A subjectRef looks like agent:<id>, user:<id>, project:<id>, or workspace:<id>.
`;

function conversationRow(s: any) {
  return {
    sessionId: s.sessionId,
    type: s.type ?? '',
    title: s.title ?? '',
    messages: String(s.messageCount ?? ''),
    participants: String(Array.isArray(s.participants) ? s.participants.length : 0),
    updatedAt: s.updatedAt ?? '',
  };
}

function writeConversation(ctx: Ctx, c: any) {
  writeFields(ctx, [
    ['sessionId', c.sessionId], ['title', c.title], ['type', c.type], ['messageCount', c.messageCount],
    ['ownerUserId', c.ownerUserId], ['ownerSubject', c.ownerSubject], ['boardId', c.boardId],
    ['branchedFrom', c.branchedFrom], ['createdAt', c.createdAt], ['updatedAt', c.updatedAt],
  ]);
  const parts = Array.isArray(c.participants) ? c.participants : [];
  if (parts.length) writeLine(ctx.io.stdout, `participants: ${parts.map((p: any) => `${p.subjectRef}${p.role ? ` (${p.role})` : ''}`).join(', ')}`);
}

async function runChatSessions(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, SESSIONS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--title', '--session-id', '--type', '--board-id', '--from-seq', '--run-id'],
    multi: ['--participant'],
  });
  if (options.help) { write(ctx.io.stdout, SESSIONS_HELP); return 0; }
  const id = positionals[0];
  const needId = () => {
    if (!id) throw new CliError(`chat sessions ${sub} requires <sessionId>.\nRun \`openwop chat sessions --help\` for usage.`, 2);
    return `${CHAT_BASE}/sessions/${enc(id)}`;
  };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, `${CHAT_BASE}/sessions`);
      return emit(ctx, res.body, () => {
        const rows = Array.isArray(res.body?.sessions) ? res.body.sessions : [];
        if (!rows.length) { writeLine(ctx.io.stdout, 'No conversations. Start one with `openwop chat sessions create --title <t>`.'); return; }
        writeLine(ctx.io.stdout, formatTable(rows.map(conversationRow), ['sessionId', 'type', 'title', 'messages', 'participants', 'updatedAt']));
      });
    }
    case 'get': {
      const res = await requestJson(ctx, needId());
      return emit(ctx, res.body, () => writeConversation(ctx, res.body ?? {}));
    }
    case 'create': {
      const body: Record<string, any> = {};
      if (options.title) body.title = options.title;
      if (options.sessionId) body.sessionId = options.sessionId;
      if (options.type) body.type = options.type;
      if (Array.isArray(options.participant) && options.participant.length) body.participants = options.participant;
      if (options.boardId) body.boardId = options.boardId;
      const res = await requestJson(ctx, `${CHAT_BASE}/sessions`, { method: 'POST', body, headers: idempotencyHeaders() });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Created conversation ${res.body?.sessionId} (${res.body?.title ?? ''}).`));
    }
    case 'update': {
      if (!options.title) throw new CliError('chat sessions update requires --title <t>.', 2);
      const res = await requestJson(ctx, needId(), { method: 'PATCH', body: { title: options.title } });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Renamed ${id} → ${res.body?.title ?? options.title}.`));
    }
    case 'delete': case 'rm': {
      const path = needId();
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete conversation ${id} without --yes.`); return 2; }
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted conversation ${id}.`);
      return 0;
    }
    case 'branch': {
      const body: Record<string, any> = {};
      const fromSeq = intFlag(options.fromSeq, '--from-seq');
      if (fromSeq !== undefined) body.fromSeq = fromSeq;
      const res = await requestJson(ctx, `${needId()}/branch`, { method: 'POST', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Branched ${id} → ${res.body?.sessionId} (${res.body?.messageCount ?? 0} message(s) carried over).`));
    }
    case 'read': {
      await requestJson(ctx, `${needId()}/read`, { method: 'POST', body: {} });
      return emit(ctx, { sessionId: id, read: true }, () => writeLine(ctx.io.stdout, `Marked ${id} read.`));
    }
    case 'board': {
      if (!options.boardId) throw new CliError('chat sessions board requires --board-id <id>.', 2);
      const res = await requestJson(ctx, `${needId()}/board`, { method: 'POST', body: { boardId: options.boardId } });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Convened board ${options.boardId} in ${id} (${Array.isArray(res.body?.participants) ? res.body.participants.length : 0} participant(s)).`));
    }
    case 'bind-run': {
      if (!options.runId) throw new CliError('chat sessions bind-run requires --run-id <runId>.', 2);
      await requestJson(ctx, `${needId()}/conversation-run`, { method: 'PUT', body: { conversationRunId: options.runId } });
      return emit(ctx, { sessionId: id, conversationRunId: options.runId }, () => writeLine(ctx.io.stdout, `Bound run ${options.runId} to ${id}.`));
    }
    default:
      throw new CliError(`Unknown chat sessions command: ${sub}\nRun \`openwop chat sessions --help\` for usage.`, 2);
  }
}

const MESSAGES_HELP = `Usage:
  openwop chat messages list <sessionId> [--limit n] [--before <cursor>] [--json]
  openwop chat messages send <sessionId> --content <text> [--role user|assistant|system|workflow_run]
                             [--message-id id] [--meta <string>] [--json]
  openwop chat messages edit <sessionId> <messageId> --content <text> [--meta <string>] [--json]
  openwop chat messages delete <sessionId> <messageId> --yes
  openwop chat messages react|unreact <sessionId> <messageId> <emoji> [--json]

GET|POST /v1/host/openwop-app/chat/sessions/{id}/messages (--limit pages newest
first; pass the returned nextCursor as --before for older pages),
PUT|DELETE …/messages/{messageId} (edit / tombstone), and
PUT|DELETE …/messages/{messageId}/reactions/{emoji}. The host accepts the
reaction set 👍 ✅ 👀 🎉 ❤️ 😄 🚀 🤔. --message-id defaults to a fresh UUID.
`;

async function runChatMessages(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, MESSAGES_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--limit', '--before', '--content', '--role', '--message-id', '--meta'],
  });
  if (options.help) { write(ctx.io.stdout, MESSAGES_HELP); return 0; }
  const [sessionId, messageId, emoji] = positionals;
  if (!sessionId) throw new CliError(`chat messages ${sub} requires <sessionId>.\nRun \`openwop chat messages --help\` for usage.`, 2);
  const base = `${CHAT_BASE}/sessions/${enc(sessionId)}/messages`;
  const needMsg = () => {
    if (!messageId) throw new CliError(`chat messages ${sub} requires <sessionId> <messageId>.`, 2);
    return `${base}/${enc(messageId)}`;
  };
  switch (sub) {
    case 'list': {
      const q = new URLSearchParams();
      if (options.limit !== undefined) q.set('limit', String(options.limit));
      if (options.before) q.set('before', options.before);
      const res = await requestJson(ctx, `${base}${q.size ? `?${q}` : ''}`);
      return emit(ctx, res.body, () => {
        const msgs = Array.isArray(res.body?.messages) ? res.body.messages : [];
        if (!msgs.length) { writeLine(ctx.io.stdout, 'No messages.'); return; }
        for (const m of msgs) {
          const reactions = Array.isArray(m.reactions) && m.reactions.length ? `  [${m.reactions.map((r: any) => `${r.emoji}${r.count ?? ''}`).join(' ')}]` : '';
          writeLine(ctx.io.stdout, `${m.createdAt ?? ''} ${m.role}${m.authorSubject ? ` (${m.authorSubject})` : ''} ${m.messageId}: ${m.content}${reactions}`);
        }
        if (res.body?.nextCursor) writeLine(ctx.io.stdout, `(older messages: --before ${res.body.nextCursor})`);
      });
    }
    case 'send': {
      if (typeof options.content !== 'string') throw new CliError('chat messages send requires --content <text>.', 2);
      const body: Record<string, any> = {
        messageId: options.messageId ?? randomUUID(),
        role: options.role ?? 'user',
        content: options.content,
      };
      if (options.meta !== undefined) body.meta = options.meta;
      const res = await requestJson(ctx, base, { method: 'POST', body, headers: idempotencyHeaders() });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Sent ${res.body?.messageId ?? body.messageId} to ${sessionId}.`));
    }
    case 'edit': {
      const path = needMsg();
      if (typeof options.content !== 'string') throw new CliError('chat messages edit requires --content <text>.', 2);
      const body: Record<string, any> = { content: options.content };
      if (options.meta !== undefined) body.meta = options.meta;
      const res = await requestJson(ctx, path, { method: 'PUT', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Edited ${messageId}.`));
    }
    case 'delete': case 'rm': {
      const path = needMsg();
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete message ${messageId} without --yes.`); return 2; }
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted message ${messageId}.`);
      return 0;
    }
    case 'react': case 'unreact': {
      const path = needMsg();
      if (!emoji) throw new CliError(`chat messages ${sub} requires <sessionId> <messageId> <emoji>.`, 2);
      const res = await requestJson(ctx, `${path}/reactions/${enc(emoji)}`, { method: sub === 'react' ? 'PUT' : 'DELETE' });
      return emit(ctx, res.body, () => {
        const rs = Array.isArray(res.body?.reactions) ? res.body.reactions : [];
        writeLine(ctx.io.stdout, `${sub === 'react' ? 'Reacted' : 'Removed reaction'} ${emoji} on ${messageId}. Now: ${rs.length ? rs.map((r: any) => `${r.emoji}${r.count ?? ''}`).join(' ') : '(none)'}`);
      });
    }
    default:
      throw new CliError(`Unknown chat messages command: ${sub}\nRun \`openwop chat messages --help\` for usage.`, 2);
  }
}

const PARTICIPANTS_HELP = `Usage:
  openwop chat participants list <sessionId> [--json]
  openwop chat participants add <sessionId> <subjectRef> [--json]
  openwop chat participants remove <sessionId> <subjectRef> [--json]

GET|PUT /v1/host/openwop-app/chat/sessions/{id}/participants and
DELETE …/participants/{subjectRef}. Owner-gated on the host; channel
membership is managed with \`openwop channels members\` instead.
`;

async function runChatParticipants(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, PARTICIPANTS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, PARTICIPANTS_HELP); return 0; }
  const [sessionId, subjectRef] = positionals;
  if (!sessionId) throw new CliError(`chat participants ${sub} requires <sessionId>.`, 2);
  const base = `${CHAT_BASE}/sessions/${enc(sessionId)}/participants`;
  let res;
  if (sub === 'list') {
    res = await requestJson(ctx, base);
  } else if (sub === 'add' || sub === 'remove') {
    if (!subjectRef) throw new CliError(`chat participants ${sub} requires <sessionId> <subjectRef>.`, 2);
    res = sub === 'add'
      ? await requestJson(ctx, base, { method: 'PUT', body: { subjectRef } })
      : await requestJson(ctx, `${base}/${enc(subjectRef)}`, { method: 'DELETE' });
  } else {
    throw new CliError(`Unknown chat participants command: ${sub}\nRun \`openwop chat participants --help\` for usage.`, 2);
  }
  return emit(ctx, res.body, () => {
    const parts = Array.isArray(res.body?.participants) ? res.body.participants : [];
    if (!parts.length) { writeLine(ctx.io.stdout, 'No participants.'); return; }
    writeLine(ctx.io.stdout, formatTable(parts.map((p: any) => ({ subjectRef: p.subjectRef, role: p.role ?? '', lastReadAt: p.lastReadAt ?? '' })), ['subjectRef', 'role', 'lastReadAt']));
  });
}

async function runChatOpen(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--subject', '--type', '--title'] });
  if (options.help || !options.subject) {
    write(ctx.io.stdout, `Usage: openwop chat open --subject <subjectRef> [--type agent|person] [--title t] [--json]

Open (or resume) the persistent 1:1 conversation with an agent or person —
POST /v1/host/openwop-app/chat/conversations/open. Idempotent: a second open
returns the SAME conversation.
`);
    return options.help ? 0 : 2;
  }
  const body: Record<string, any> = { subjectRef: options.subject };
  if (options.type) body.type = options.type;
  if (options.title) body.title = options.title;
  const res = await requestJson(ctx, `${CHAT_BASE}/conversations/open`, { method: 'POST', body });
  return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `${res.status === 201 ? 'Opened' : 'Resumed'} conversation ${res.body?.sessionId} with ${options.subject}.`));
}

const FEEDBACK_HELP = `Usage:
  openwop chat feedback set <messageId> --conversation <sessionId> --rating up|down|neutral [--reason t] [--json]
  openwop chat feedback get <messageId> --conversation <sessionId> [--json]
  openwop chat feedback list <sessionId> [--json]

Your own thumbs on a chat message: POST|GET
/v1/host/openwop-app/chat/messages/{messageId}/feedback and, for a whole
conversation in one read, GET …/chat/sessions/{id}/feedback.
`;

async function runChatFeedback(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, FEEDBACK_HELP); return sub ? 0 : 2; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--conversation', '--rating', '--reason'] });
  if (options.help) { write(ctx.io.stdout, FEEDBACK_HELP); return 0; }
  const target = positionals[0];
  if (!target) throw new CliError(`chat feedback ${sub} requires an id.\nRun \`openwop chat feedback --help\` for usage.`, 2);
  switch (sub) {
    case 'set': {
      if (!options.conversation || !options.rating) throw new CliError('chat feedback set requires --conversation <sessionId> and --rating up|down|neutral.', 2);
      const body: Record<string, any> = { conversationId: options.conversation, rating: options.rating };
      if (options.reason) body.reason = options.reason;
      const res = await requestJson(ctx, `${CHAT_BASE}/messages/${enc(target)}/feedback`, { method: 'POST', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Rated ${target} ${res.body?.rating ?? options.rating}.`));
    }
    case 'get': {
      if (!options.conversation) throw new CliError('chat feedback get requires --conversation <sessionId>.', 2);
      const res = await requestJson(ctx, `${CHAT_BASE}/messages/${enc(target)}/feedback?conversationId=${enc(options.conversation)}`);
      return emit(ctx, res.body, () => {
        const f = res.body?.feedback;
        writeLine(ctx.io.stdout, f ? `${target}: ${f.rating}${f.reason ? ` — ${f.reason}` : ''}` : `No feedback from you on ${target}.`);
      });
    }
    case 'list': {
      const res = await requestJson(ctx, `${CHAT_BASE}/sessions/${enc(target)}/feedback`);
      return emit(ctx, res.body, () => {
        const entries = Object.entries(res.body?.feedback ?? {});
        if (!entries.length) { writeLine(ctx.io.stdout, 'No feedback from you in this conversation.'); return; }
        writeLine(ctx.io.stdout, formatTable(entries.map(([messageId, rating]) => ({ messageId, rating })), ['messageId', 'rating']));
      });
    }
    default:
      throw new CliError(`Unknown chat feedback command: ${sub}\nRun \`openwop chat feedback --help\` for usage.`, 2);
  }
}

async function runChatModels(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, 'Usage: openwop chat models [--json]\n\nThe chat model picker: selectable providers + models with their capabilities —\nGET /v1/host/openwop-app/chat/model-capabilities.\n');
    return 0;
  }
  const res = await requestJson(ctx, `${CHAT_BASE}/model-capabilities`);
  return emit(ctx, res.body, () => {
    const rows: any[] = [];
    for (const p of Array.isArray(res.body?.providers) ? res.body.providers : []) {
      for (const m of Array.isArray(p.models) ? p.models : []) {
        // The host sends a string list; tolerate a { cap: true } map too.
        const caps = Array.isArray(m.capabilities)
          ? m.capabilities.join(',')
          : m.capabilities && typeof m.capabilities === 'object'
            ? Object.entries(m.capabilities).filter(([, v]) => v === true).map(([k]) => k).join(',')
            : '';
        rows.push({ provider: p.provider, model: m.id, label: m.label ?? '', recommended: m.recommended ? 'yes' : '', capabilities: caps });
      }
    }
    if (!rows.length) { writeLine(ctx.io.stdout, 'No selectable chat models on this server.'); return; }
    writeLine(ctx.io.stdout, formatTable(rows, ['provider', 'model', 'label', 'recommended', 'capabilities']));
  });
}

async function runChatSearch(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--post'], value: ['--type', '--role', '--limit'] });
  if (options.help || positionals.length === 0) {
    write(ctx.io.stdout, `Usage: openwop chat search <query> [--type agent|person|group|workspace] [--role r] [--limit n] [--post] [--json]

Full-text search over the conversations you can see —
GET /v1/host/openwop-app/chat/search?q=… (or POST with a JSON body via --post).
`);
    return options.help ? 0 : 2;
  }
  const params: Record<string, string> = { q: positionals.join(' ') };
  if (options.type) params.type = options.type;
  if (options.role) params.role = options.role;
  if (options.limit !== undefined) params.limit = String(options.limit);
  const res = options.post
    ? await requestJson(ctx, `${CHAT_BASE}/search`, { method: 'POST', body: params })
    : await requestJson(ctx, `${CHAT_BASE}/search?${new URLSearchParams(params)}`);
  return emit(ctx, res.body, () => {
    const hits = Array.isArray(res.body?.hits) ? res.body.hits : [];
    if (!hits.length) { writeLine(ctx.io.stdout, 'No matches.'); return; }
    writeLine(ctx.io.stdout, formatTable(hits.map((h: any) => ({
      conversationId: h.conversationId, title: h.title ?? '', role: h.role ?? '', matchedAt: h.matchedAt ?? '', snippet: String(h.snippet ?? '').replace(/\s+/g, ' ').slice(0, 80),
    })), ['conversationId', 'title', 'role', 'matchedAt', 'snippet']));
  });
}

async function runChatExport(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--format', '--output'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop chat export <sessionId> [--format md|json] [--output path]

Export a conversation transcript — GET /v1/host/openwop-app/chat-export/{id}?format=md|json.
Markdown is the default; --output writes the transcript to a file instead of stdout.
`);
    return options.help ? 0 : 2;
  }
  const format = options.format ?? (ctx.json ? 'json' : 'md');
  if (format !== 'md' && format !== 'json') throw new CliError('--format must be md or json', 2);
  const res = await requestJson(ctx, `/v1/host/openwop-app/chat-export/${enc(positionals[0])}?format=${format}`);
  const text = format === 'json'
    ? JSON.stringify(res.body, null, 2)
    : (typeof res.body?.raw === 'string' ? res.body.raw : typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2));
  if (options.output) {
    writeFileSync(String(options.output), text.endsWith('\n') ? text : `${text}\n`);
    writeLine(ctx.io.stdout, `Wrote ${format} transcript of ${positionals[0]} to ${options.output}.`);
    return 0;
  }
  writeLine(ctx.io.stdout, text);
  return 0;
}

async function runChatImport(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--file', '--format'] });
  if (options.help || !options.file) {
    write(ctx.io.stdout, `Usage: openwop chat import --file <export.json> [--format openwop|chatgpt] [--json]

Import a transcript as a NEW conversation you own —
POST /v1/host/openwop-app/chat-export/import { format, data }. Accepts an
\`openwop chat export --format json\` file (default) or a ChatGPT export.
Requires a signed-in account.
`);
    return options.help ? 0 : 2;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(String(options.file), 'utf8'));
  } catch (err) {
    throw new CliError(`--file: cannot read JSON from ${options.file} (${err instanceof Error ? err.message : String(err)})`, 2);
  }
  const body: Record<string, any> = { data };
  if (options.format) body.format = options.format;
  const res = await requestJson(ctx, '/v1/host/openwop-app/chat-export/import', { method: 'POST', body });
  return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Imported ${res.body?.imported ?? '?'} message(s) into conversation ${res.body?.sessionId}.`));
}

const TOOLS_HELP = `Usage:
  openwop chat tools get <sessionId> [--json]
  openwop chat tools set <sessionId> [--mode agent-default|restricted] [--enable <toolId>]...
                         [--disable <toolId>]... [--require-approval <toolId>]... [--json]
  openwop chat tools set <sessionId> --clear
  openwop chat tools approve|deny <sessionId> <toolName> [--json]

Per-conversation tool scope (narrows, never widens, the agent's tools):
GET|PUT /v1/host/openwop-app/conversation-tools/sessions/{id}/capability-scope and
POST …/approvals/{toolName} { decision: approved|denied }. 'set' reads the
current scope first and changes only the lists you pass (the host replaces the
whole scope on write). Owner-gated on the host.
`;

async function runChatTools(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'get';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, TOOLS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--clear'],
    value: ['--mode'],
    multi: ['--enable', '--disable', '--require-approval'],
  });
  if (options.help) { write(ctx.io.stdout, TOOLS_HELP); return 0; }
  const [sessionId, toolName] = positionals;
  if (!sessionId) throw new CliError(`chat tools ${sub} requires <sessionId>.\nRun \`openwop chat tools --help\` for usage.`, 2);
  const base = `/v1/host/openwop-app/conversation-tools/sessions/${enc(sessionId)}`;
  const renderScope = (scope: any) => {
    writeLine(ctx.io.stdout, `mode: ${scope?.mode ?? 'agent-default'}`);
    for (const k of ['enabled', 'disabled', 'requireApproval']) {
      if (Array.isArray(scope?.[k])) writeLine(ctx.io.stdout, `${k}: ${scope[k].length ? scope[k].join(', ') : '(none)'}`);
    }
    if (scope?.setBy) writeLine(ctx.io.stdout, `setBy: ${scope.setBy}${scope.setAt ? ` at ${scope.setAt}` : ''}`);
  };
  switch (sub) {
    case 'get': {
      const res = await requestJson(ctx, `${base}/capability-scope`);
      return emit(ctx, res.body, () => {
        renderScope(res.body?.scope);
        const approvals = Array.isArray(res.body?.approvals) ? res.body.approvals : [];
        if (approvals.length) {
          writeLine(ctx.io.stdout, 'approvals:');
          writeLine(ctx.io.stdout, formatTable(approvals.map((a: any) => ({ tool: a.toolName ?? '', status: a.status ?? '', requestedAt: a.requestedAt ?? '', resolvedBy: a.resolvedBy ?? '', resolvedAt: a.resolvedAt ?? '' })), ['tool', 'status', 'requestedAt', 'resolvedBy', 'resolvedAt']));
        }
      });
    }
    case 'set': {
      let scope: Record<string, any> | null;
      if (options.clear) {
        scope = null;
      } else {
        const current = (await requestJson(ctx, `${base}/capability-scope`)).body?.scope ?? { mode: 'agent-default' };
        scope = { mode: options.mode ?? current.mode ?? 'agent-default' };
        const pick = (flag: string, key: string) => {
          if (Array.isArray(options[flag])) scope![key] = options[flag];
          else if (Array.isArray(current[key])) scope![key] = current[key];
        };
        pick('enable', 'enabled');
        pick('disable', 'disabled');
        pick('requireApproval', 'requireApproval');
      }
      const res = await requestJson(ctx, `${base}/capability-scope`, { method: 'PUT', body: { scope } });
      return emit(ctx, res.body, () => { writeLine(ctx.io.stdout, `Updated tool scope for ${sessionId}.`); renderScope(res.body?.scope); });
    }
    case 'approve': case 'deny': {
      if (!toolName) throw new CliError(`chat tools ${sub} requires <sessionId> <toolName>.`, 2);
      const res = await requestJson(ctx, `${base}/approvals/${enc(toolName)}`, { method: 'POST', body: { decision: sub === 'approve' ? 'approved' : 'denied' } });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `${sub === 'approve' ? 'Approved' : 'Denied'} ${toolName} in ${sessionId}.`));
    }
    default:
      throw new CliError(`Unknown chat tools command: ${sub}\nRun \`openwop chat tools --help\` for usage.`, 2);
  }
}

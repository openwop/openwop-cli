import type { Ctx } from '../context.js';
/**
 * `openwop voice …` — voice mode on the server (RFC 0106 realtime voice /
 * RFC 0105 speech; openwop-app ADR 0138 voice sessions, ADR 0109 barge-in,
 * ADR 0324/0467 realtime voice).
 *
 * Two host-extension surfaces:
 *  - the walkie-talkie session  /v1/host/openwop-app/voice/session[/{id}/audio|commit|speak|barge-in]
 *    — append audio chunks, commit an utterance (transcribe), speak a reply;
 *  - the realtime bridge        /v1/host/openwop-app/voice/realtime/*
 *    — mint a provider session, exchange a WebRTC offer, bridge tool calls,
 *      resolve a held approval, read/set the provider config (operators), and
 *      stream the conversation's new-message ids.
 * Plus the scripted barge-in demonstration seam POST /v1/host/openwop-app/voice/barge-in.
 *
 * Secrets: the realtime session carries an EPHEMERAL provider token. The CLI
 * redacts it unless --reveal-token is passed (then prints it once, with a
 * warning on stderr); the BYOK key itself never leaves the server — the config
 * read returns only its reference name.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { write, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, emit, intFlag, renderFrame, streamHostSse, writeFields } from './chatShared.js';
import { parseJsonFlag } from './contentHelpers.js';

const SESSION = '/v1/host/openwop-app/voice/session';
const REALTIME = '/v1/host/openwop-app/voice/realtime';
/** Audio is appended in base64 chunks of at most this many raw bytes. */
const AUDIO_CHUNK_BYTES = 192 * 1024;

export const VOICE_HELP = `Usage:
  openwop voice session start [--conversation <id>] [--agent <agentId>] [--mime-type <t>] [--json]
  openwop voice session audio <sessionId> (--file <audio> | --chunk <base64>) [--json]
  openwop voice session commit <sessionId> [--language <code>] [--json]
  openwop voice session speak <sessionId> --text <reply> [--voice-id v] [--provider p]
                              [--credential-ref r] [--agent <agentId>] [--output <file>] [--json]
  openwop voice session barge-in <sessionId> [--at-ms n] [--json]
  openwop voice session close <sessionId>
  openwop voice barge-in-demo [--chunks n] [--barge-in-at-seq n] [--json]
  openwop voice realtime capability [--json]
  openwop voice realtime config get [--json]
  openwop voice realtime config set [--provider off|openai-realtime|gemini-live] [--credential-ref r] [--model m] [--json]
  openwop voice realtime session [--agent <agentId>] [--conversation <id>] [--reveal-token] [--json]
  openwop voice realtime connect --sdp-file <offer.sdp> [--agent <agentId>] [--conversation <id>] [--output <answer.sdp>] [--json]
  openwop voice realtime tool-call --session <hostSessionId> --name <tool> [--call-id id]
                                   [--arguments <json>] [--user-approved] [--json]
  openwop voice realtime resolve-approval --call-id <id> --fc-id <id> (--approve | --deny) [--json]
  openwop voice realtime transcript --conversation <id> [--max-events n] [--timeout-ms ms] [--json]

Voice mode on the server. Walkie-talkie sessions (/v1/host/openwop-app/voice/session):
'start' opens a session, 'audio' appends audio (a file is sent as base64 chunks),
'commit' transcribes the utterance, 'speak' synthesizes a reply (the agent's own
voice wins when it has one), 'barge-in' cancels an in-flight reply, 'close' ends it.

Realtime (/v1/host/openwop-app/voice/realtime/*): 'capability' names the configured
provider; 'config' reads/sets it (server operators only — 'set' reads the current
config first and changes only what you pass); 'session' mints a provider session
(its ephemeral token is redacted unless --reveal-token); 'connect' exchanges a
WebRTC SDP offer for the answer; 'tool-call' runs one tool the model asked for;
'resolve-approval' decides a held tool approval; 'transcript' streams the
conversation's new-message ids (server-sent events, stops after --max-events or
--timeout-ms, default 30000 ms).

'barge-in-demo' drives POST /v1/host/openwop-app/voice/barge-in — a scripted
demonstration that a barge-in cancels synthesis with no partial audio leaked.

Exit codes: 0 ok, 2 usage / not found / voice mode off, 4 not permitted, 1 provider error.

Examples:
  openwop voice session start --agent core.openwop.agents.concierge.default
  openwop voice session audio <sessionId> --file hello.webm
  openwop voice session commit <sessionId> --language en
  openwop voice realtime config set --provider openai-realtime --credential-ref openai-realtime-key
`;

export async function runVoice(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, VOICE_HELP); return sub ? 0 : 2; }
  switch (sub) {
    case 'session': return await runSession(ctx, argv.slice(1));
    case 'realtime': return await runRealtime(ctx, argv.slice(1));
    case 'barge-in-demo': return await runBargeInDemo(ctx, argv.slice(1));
    default:
      throw new CliError(`Unknown voice command: ${sub}\nRun \`openwop voice --help\` for usage.`, 2);
  }
}

function renderEvents(ctx: Ctx, events: unknown) {
  for (const e of Array.isArray(events) ? events : []) writeLine(ctx.io.stdout, `  · ${e.type}${e.payload ? ` ${JSON.stringify(e.payload)}` : ''}`);
}

async function runSession(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, VOICE_HELP); return sub ? 0 : 2; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help'],
    value: ['--conversation', '--agent', '--mime-type', '--file', '--chunk', '--language', '--text', '--voice-id', '--provider', '--credential-ref', '--output', '--at-ms'],
  });
  if (options.help) { write(ctx.io.stdout, VOICE_HELP); return 0; }
  if (sub === 'start') {
    const body: Record<string, any> = {};
    if (options.conversation) body.conversationId = options.conversation;
    if (options.agent) body.agentId = options.agent;
    if (options.mimeType) body.mimeType = options.mimeType;
    const res = await requestJson(ctx, SESSION, { method: 'POST', body });
    return emit(ctx, res.body, () => {
      const s = res.body?.session ?? {};
      writeLine(ctx.io.stdout, `Voice session ${s.sessionId} open (${s.transport ?? res.body?.transport?.kind ?? 'http-chunked'}).`);
      writeFields(ctx, [['agentId', s.agentId], ['conversationId', s.conversationId], ['streamRef', s.streamRef]]);
    });
  }
  const id = positionals[0];
  if (!id) throw new CliError(`voice session ${sub} requires <sessionId>.\nRun \`openwop voice --help\` for usage.`, 2);
  const path = `${SESSION}/${enc(id)}`;
  switch (sub) {
    case 'audio': {
      let chunks: string[];
      if (options.file) {
        let bytes: Buffer;
        try { bytes = readFileSync(String(options.file)); } catch (err) {
          throw new CliError(`--file: cannot read ${options.file} (${err instanceof Error ? err.message : String(err)})`, 2);
        }
        chunks = [];
        for (let i = 0; i < bytes.length; i += AUDIO_CHUNK_BYTES) chunks.push(bytes.subarray(i, i + AUDIO_CHUNK_BYTES).toString('base64'));
      } else if (options.chunk) {
        chunks = [String(options.chunk)];
      } else {
        throw new CliError('voice session audio requires --file <audio> or --chunk <base64>.', 2);
      }
      let last: any = null;
      for (const audioChunk of chunks) {
        last = (await requestJson(ctx, `${path}/audio`, { method: 'POST', body: { audioChunk } })).body;
      }
      return emit(ctx, last, () => writeLine(ctx.io.stdout, `Appended ${chunks.length} chunk(s); utterance buffer is ${last?.bytes ?? '?'} bytes. Commit it with \`openwop voice session commit ${id}\`.`));
    }
    case 'commit': {
      const body: Record<string, any> = {};
      if (options.language) body.languageCode = options.language;
      const res = await requestJson(ctx, `${path}/commit`, { method: 'POST', body });
      return emit(ctx, res.body, () => {
        writeLine(ctx.io.stdout, `transcript: ${res.body?.finalText ?? ''}`);
        writeFields(ctx, [['language', res.body?.language], ['turns', res.body?.turns]]);
        renderEvents(ctx, res.body?.events);
      });
    }
    case 'speak': {
      if (!options.text) throw new CliError('voice session speak requires --text <reply>.', 2);
      const body: Record<string, any> = { text: options.text };
      if (options.voiceId) body.voiceId = options.voiceId;
      if (options.provider) body.provider = options.provider;
      if (options.credentialRef) body.credentialRef = options.credentialRef;
      if (options.agent) body.agentId = options.agent;
      const res = await requestJson(ctx, `${path}/speak`, { method: 'POST', body });
      return emit(ctx, res.body, () => {
        if (res.body?.cancelled) { writeLine(ctx.io.stdout, `Turn ${res.body.turnId} was cancelled by a barge-in.`); return; }
        const audio = res.body?.audio ?? {};
        writeFields(ctx, [['turnId', res.body?.turnId], ['url', audio.url], ['mimeType', audio.mimeType], ['durationSeconds', audio.durationSeconds]]);
        if (options.output && typeof audio.base64 === 'string') {
          writeFileSync(String(options.output), Buffer.from(audio.base64, 'base64'));
          writeLine(ctx.io.stdout, `Wrote audio to ${options.output}.`);
        }
      });
    }
    case 'barge-in': {
      const body: Record<string, any> = {};
      const atMs = intFlag(options.atMs, '--at-ms');
      if (atMs !== undefined) body.atMs = atMs;
      const res = await requestJson(ctx, `${path}/barge-in`, { method: 'POST', body });
      return emit(ctx, res.body, () => {
        writeLine(ctx.io.stdout, res.body?.cancelledTurn ? `Cancelled turn ${res.body.cancelledTurn}.` : 'Nothing was speaking.');
        renderEvents(ctx, res.body?.events);
      });
    }
    case 'close': case 'end': {
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Closed voice session ${id}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown voice session command: ${sub}\nRun \`openwop voice --help\` for usage.`, 2);
  }
}

async function runBargeInDemo(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--chunks', '--barge-in-at-seq'] });
  if (options.help) { write(ctx.io.stdout, VOICE_HELP); return 0; }
  const body: Record<string, any> = {};
  const chunks = intFlag(options.chunks, '--chunks');
  const at = intFlag(options.bargeInAtSeq, '--barge-in-at-seq');
  if (chunks !== undefined) body.chunks = chunks;
  if (at !== undefined) body.bargeInAtSeq = at;
  const res = await requestJson(ctx, '/v1/host/openwop-app/voice/barge-in', { method: 'POST', body });
  return emit(ctx, res.body, () => {
    renderEvents(ctx, res.body?.events);
    writeLine(ctx.io.stdout, `droppedChunks: ${res.body?.droppedChunks ?? 0} (halted, never sent)`);
  });
}

function redactRealtime(body: any, reveal: boolean): any {
  if (reveal || !body?.realtime || typeof body.realtime !== 'object' || typeof body.realtime.token !== 'string') return body;
  return { ...body, realtime: { ...body.realtime, token: '[redacted — pass --reveal-token]' } };
}

async function runRealtime(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, VOICE_HELP); return sub ? 0 : 2; }
  if (sub === 'config') return await runRealtimeConfig(ctx, argv.slice(1));
  const { options } = parseOptions(argv.slice(1), {
    bool: ['--help', '--reveal-token', '--user-approved', '--approve', '--deny'],
    value: ['--agent', '--conversation', '--sdp-file', '--output', '--session', '--name', '--call-id', '--arguments', '--fc-id', '--max-events', '--timeout-ms'],
  });
  if (options.help) { write(ctx.io.stdout, VOICE_HELP); return 0; }
  switch (sub) {
    case 'capability': {
      const res = await requestJson(ctx, `${REALTIME}/capability`);
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `realtime provider: ${res.body?.provider ?? 'off'}${res.body?.provider === 'off' ? ' (walkie-talkie fallback only)' : ''}`));
    }
    case 'session': {
      const body: Record<string, any> = {};
      if (options.agent) body.agentId = options.agent;
      if (options.conversation) body.conversationId = options.conversation;
      const res = await requestJson(ctx, `${REALTIME}/session`, { method: 'POST', body });
      if (options.revealToken && res.body?.realtime?.token) {
        writeLine(ctx.io.stderr, 'openwop: warning — printing the ephemeral realtime token once. It grants a live provider session until it expires; do not log or share it.');
      }
      const shown = redactRealtime(res.body, options.revealToken === true);
      return emit(ctx, shown, () => {
        const r = shown?.realtime;
        if (!r) { writeLine(ctx.io.stdout, 'Realtime voice is not configured on this server — use `openwop voice session start` (walkie-talkie).'); return; }
        writeFields(ctx, [
          ['hostSessionId', shown.hostSessionId], ['provider', r.provider], ['model', r.model], ['voice', r.voice],
          ['connect', r.connect ? `${r.connect.kind} ${r.connect.url}` : undefined], ['expiresAt', r.expiresAt],
          ['tools', Array.isArray(r.tools) ? r.tools.length : undefined], ['token', r.token],
          ['degraded', Array.isArray(shown.degraded) && shown.degraded.length ? shown.degraded.join(', ') : undefined],
        ]);
      });
    }
    case 'connect': {
      if (!options.sdpFile) throw new CliError('voice realtime connect requires --sdp-file <offer.sdp>.', 2);
      let sdp: string;
      try { sdp = readFileSync(String(options.sdpFile), 'utf8'); } catch (err) {
        throw new CliError(`--sdp-file: cannot read ${options.sdpFile} (${err instanceof Error ? err.message : String(err)})`, 2);
      }
      const body: Record<string, any> = { sdp };
      if (options.agent) body.agentId = options.agent;
      if (options.conversation) body.conversationId = options.conversation;
      const res = await requestJson(ctx, `${REALTIME}/openai/connect`, { method: 'POST', body });
      if (options.output && typeof res.body?.sdp === 'string') writeFileSync(String(options.output), res.body.sdp);
      return emit(ctx, res.body, () => {
        writeLine(ctx.io.stdout, `Realtime call ${res.body?.sessionId} answered.`);
        if (options.output) writeLine(ctx.io.stdout, `Wrote the SDP answer to ${options.output}.`);
        else writeLine(ctx.io.stdout, String(res.body?.sdp ?? ''));
      });
    }
    case 'tool-call': {
      if (!options.session || !options.name) throw new CliError('voice realtime tool-call requires --session <hostSessionId> and --name <tool>.', 2);
      const body: Record<string, any> = { sessionId: options.session, name: options.name };
      if (options.callId) body.callId = options.callId;
      if (options.arguments !== undefined) body.arguments = parseJsonFlag('--arguments', options.arguments);
      if (options.userApproved) body.userApproved = true;
      const res = await requestJson(ctx, `${REALTIME}/tool-call`, { method: 'POST', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, JSON.stringify(res.body, null, 2)));
    }
    case 'resolve-approval': {
      if (!options.callId || !options.fcId || (options.approve === options.deny)) {
        throw new CliError('voice realtime resolve-approval requires --call-id, --fc-id, and exactly one of --approve / --deny.', 2);
      }
      const res = await requestJson(ctx, `${REALTIME}/held-approvals/resolve`, { method: 'POST', body: { callId: options.callId, fcId: options.fcId, approve: options.approve === true } });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Held approval ${options.fcId}: ${res.body?.status ?? ''}.`));
    }
    case 'transcript': case 'messages': {
      if (!options.conversation) throw new CliError('voice realtime transcript requires --conversation <id>.', 2);
      const timeoutMs = intFlag(options.timeoutMs, '--timeout-ms') ?? 30000;
      const frames = await streamHostSse(ctx, `${REALTIME}/messages/stream?conversationId=${enc(options.conversation)}`, {
        maxFrames: intFlag(options.maxEvents, '--max-events'),
        timeoutMs,
        onFrame: (frame) => writeLine(ctx.io.stdout, ctx.json ? JSON.stringify(frame) : renderFrame(frame)),
      });
      if (!ctx.json && frames === 0) writeLine(ctx.io.stdout, `No new messages within ${timeoutMs} ms.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown voice realtime command: ${sub}\nRun \`openwop voice --help\` for usage.`, 2);
  }
}

async function runRealtimeConfig(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'get';
  const { options } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--provider', '--credential-ref', '--model'] });
  if (options.help || sub === '--help') { write(ctx.io.stdout, VOICE_HELP); return 0; }
  const render = (b: any) => writeFields(ctx, [['provider', b?.provider], ['credentialRef', b?.credentialRef], ['model', b?.model]]);
  if (sub === 'get') {
    const res = await requestJson(ctx, `${REALTIME}/config`);
    return emit(ctx, res.body, () => render(res.body));
  }
  if (sub === 'set') {
    if (!options.provider && options.credentialRef === undefined && options.model === undefined) {
      throw new CliError('Nothing to set — pass --provider, --credential-ref, and/or --model.', 2);
    }
    // The server REPLACES the config on write: read it first, change only what was passed.
    const current = (await requestJson(ctx, `${REALTIME}/config`)).body ?? {};
    const body: Record<string, any> = { provider: options.provider ?? current.provider ?? 'off' };
    const credentialRef = options.credentialRef ?? current.credentialRef;
    const model = options.model ?? current.model;
    if (credentialRef) body.credentialRef = credentialRef;
    if (model) body.model = model;
    const res = await requestJson(ctx, `${REALTIME}/config`, { method: 'PUT', body });
    return emit(ctx, res.body, () => { writeLine(ctx.io.stdout, 'Updated realtime voice config.'); render(res.body); });
  }
  throw new CliError(`Unknown voice realtime config command: ${sub}\nRun \`openwop voice --help\` for usage.`, 2);
}

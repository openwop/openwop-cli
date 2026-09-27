import type { Ctx } from '../context.js';
/**
 * `openwop ai …` — the host's AI-provider seams (RFC 0091 multimodal callAI
 * modality gate, RFC 0105 speech synthesis, RFC 0106 transcription, RFC 0108
 * self-hosted `compat` dispatch, RFC 0121 §B.8 subscription-credential scope rail;
 * openwop-app ADR 0109 / ADR 0121 / ADR 0179 / ADR 0180).
 *
 *   POST /v1/host/openwop-app/ai/call                   — modality-gated callAI probe
 *   POST /v1/host/openwop-app/ai/call-speech-synthesizer — text → speech
 *   POST /v1/host/openwop-app/ai/call-transcriber        — audio → transcript
 *   POST /v1/host/openwop-app/credentials/bind           — bind a subscription credential (user scope only)
 *
 * (The same handlers also answer under the spec-canonical /v1/host/sample/*
 * prefix the conformance suite drives; the CLI always calls the canonical path.)
 *
 * Secrets: `bind-credential` reads the credential from a file or an environment
 * variable — never from argv — sends it once, and prints only the reference
 * name the server returns. The server never echoes the value.
 */
import { readFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { write, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { emit, writeFields } from './chatShared.js';
import { parseJsonFlag } from './contentHelpers.js';

const AI = '/v1/host/openwop-app/ai';

export const AI_HELP = `Usage:
  openwop ai call (--message <text> | --messages-json <json>) [--provider p] [--model m] [--json]
  openwop ai speech --text <text> --voice-id <v> [--stream] [--json]
  openwop ai transcribe (--stream-ref <ref> | --url <audio-url>) [--language <code>] [--json]
  openwop ai bind-credential --provider <p> --scope user|tenant|workspace
                             [--value-file <path> | --value-env <VAR>] [--acknowledge-risk] [--json]

The server's AI-provider seams:

  call             POST /v1/host/openwop-app/ai/call — runs the SAME modality gate a
                   workflow's AI call runs before dispatch: accepted parts report the
                   modalities seen; an unadvertised modality is refused
                   (unsupported_modality). The self-hosted \`compat\` provider really
                   dispatches to the operator's endpoint.
  speech           POST …/ai/call-speech-synthesizer { text, voiceId, stream? } —
                   prints the audio reference (url / mimeType / duration).
  transcribe       POST …/ai/call-transcriber { audio: { streamRef | url }, languageCode? }.
  bind-credential  POST /v1/host/openwop-app/credentials/bind { provider, mode: "subscription",
                   scope, value?, acknowledgedRisk? }. Personal subscriptions bind at
                   USER scope only (tenant/workspace is refused). With no value it is a
                   dry scope check that stores nothing. Storing a value requires
                   --acknowledge-risk: reusing a personal subscription may break the
                   provider's terms and risk account suspension. Providers connected
                   through a sign-in flow refuse a pasted token.

Exit codes: 0 ok, 2 refused / usage, 4 not signed in or not permitted, 1 provider error.

Examples:
  openwop ai call --message "hello" --provider anthropic
  openwop ai call --messages-json '[{"role":"user","content":[{"type":"image","url":"https://…"}]}]'
  openwop ai speech --text "Good morning" --voice-id default
  openwop ai bind-credential --provider example --scope user
`;

export async function runAi(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, AI_HELP); return sub ? 0 : 2; }
  const { options } = parseOptions(argv.slice(1), {
    bool: ['--help', '--stream', '--acknowledge-risk'],
    value: ['--message', '--messages-json', '--provider', '--model', '--text', '--voice-id', '--stream-ref', '--url', '--language', '--scope', '--value-file', '--value-env'],
  });
  if (options.help) { write(ctx.io.stdout, AI_HELP); return 0; }
  switch (sub) {
    case 'call': {
      let messages: unknown;
      if (options.messagesJson !== undefined) messages = parseJsonFlag('--messages-json', options.messagesJson);
      else if (options.message !== undefined) messages = [{ role: 'user', content: String(options.message) }];
      else throw new CliError('ai call requires --message <text> or --messages-json <json>.', 2);
      if (!Array.isArray(messages) || messages.length === 0) throw new CliError('--messages-json must be a non-empty JSON array.', 2);
      const body: Record<string, any> = { messages };
      if (options.provider) body.provider = options.provider;
      if (options.model) body.model = options.model;
      const res = await requestJson(ctx, `${AI}/call`, { method: 'POST', body });
      return emit(ctx, res.body, () => writeFields(ctx, [
        ['accepted', res.body?.accepted ? 'yes' : 'no'], ['provider', res.body?.provider],
        ['modalities', Array.isArray(res.body?.modalities) ? res.body.modalities.join(', ') : undefined],
        ['advertised', Array.isArray(res.body?.advertised) ? res.body.advertised.join(', ') : undefined],
        ['completion', res.body?.completion],
      ]));
    }
    case 'speech': case 'synthesize': {
      if (!options.text || !options.voiceId) throw new CliError('ai speech requires --text <text> and --voice-id <v>.', 2);
      const body: Record<string, any> = { text: options.text, voiceId: options.voiceId };
      if (options.stream) body.stream = true;
      const res = await requestJson(ctx, `${AI}/call-speech-synthesizer`, { method: 'POST', body });
      return emit(ctx, res.body, () => {
        const audio = res.body?.audio ?? {};
        writeFields(ctx, [['url', audio.url], ['mimeType', audio.mimeType], ['durationSeconds', audio.durationSeconds], ['voiceId', res.body?.voiceId], ['provider', res.body?.provider]]);
        for (const e of Array.isArray(res.body?.events) ? res.body.events : []) writeLine(ctx.io.stdout, `  · ${e.type} ${JSON.stringify(e.payload ?? {})}`);
      });
    }
    case 'transcribe': {
      if (!options.streamRef && !options.url) throw new CliError('ai transcribe requires --stream-ref <ref> or --url <audio-url>.', 2);
      const body: Record<string, any> = { audio: options.streamRef ? { streamRef: options.streamRef } : { url: options.url } };
      if (options.language) body.languageCode = options.language;
      const res = await requestJson(ctx, `${AI}/call-transcriber`, { method: 'POST', body });
      return emit(ctx, res.body, () => {
        writeLine(ctx.io.stdout, `transcript: ${res.body?.finalText ?? ''}`);
        writeFields(ctx, [['language', res.body?.language]]);
        for (const e of Array.isArray(res.body?.events) ? res.body.events : []) writeLine(ctx.io.stdout, `  · ${e.type}`);
      });
    }
    case 'bind-credential': case 'bind': {
      if (!options.provider || !options.scope) throw new CliError('ai bind-credential requires --provider <p> and --scope user|tenant|workspace.', 2);
      const body: Record<string, any> = { provider: options.provider, mode: 'subscription', scope: options.scope };
      let value: string | undefined;
      if (options.valueFile) {
        try { value = readFileSync(String(options.valueFile), 'utf8').trim(); } catch (err) {
          throw new CliError(`--value-file: cannot read ${options.valueFile} (${err instanceof Error ? err.message : String(err)})`, 2);
        }
      } else if (options.valueEnv) {
        value = ctx.env[String(options.valueEnv)];
        if (!value) throw new CliError(`--value-env: environment variable ${options.valueEnv} is empty or unset.`, 2);
      }
      if (value) body.value = value;
      if (options.acknowledgeRisk) body.acknowledgedRisk = true;
      const res = await requestJson(ctx, '/v1/host/openwop-app/credentials/bind', { method: 'POST', body });
      // The server returns { bound, scope, credentialRef? } — never the value.
      const shown = { bound: res.body?.bound, scope: res.body?.scope, ...(res.body?.credentialRef ? { credentialRef: res.body.credentialRef } : {}) };
      return emit(ctx, shown, () => writeLine(ctx.io.stdout, value
        ? `Bound ${options.provider} at ${shown.scope} scope → ${shown.credentialRef ?? '(reference not returned)'}.`
        : `Scope check passed: ${options.provider} may bind at ${shown.scope} scope (nothing stored).`));
    }
    default:
      throw new CliError(`Unknown ai command: ${sub}\nRun \`openwop ai --help\` for usage.`, 2);
  }
}

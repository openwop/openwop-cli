import type { Ctx } from '../context.js';
/**
 * `openwop creative-video ...` — AI video (openwop-app ADR 0404 §b; text-to-video
 * ADR 0404 §P4). Host-extension, org-scoped:
 * `/v1/host/openwop-app/creative-video/orgs/<orgId>/...`. Reading a job resolves
 * it (one provider poll while in flight), so polling `jobs get` drives a long job
 * to completion. The provider credential is a Connection, never a CLI flag.
 */
import { requestJson } from '../api.js';
import { CliError, HttpError } from '../errors.js';
import { write, writeJson, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { requireOrg } from './shared.js';
import { enc, mergeBody, pickArray, renderDone, renderList } from './contentHelpers.js';

const base = (org: string) => `/v1/host/openwop-app/creative-video/orgs/${enc(org)}`;

export const CREATIVE_VIDEO_HELP = `Usage:
  openwop creative-video jobs list --org <orgId> [--json]
  openwop creative-video jobs get <jobId> --org <orgId> [--json]
  openwop creative-video generate --org <orgId> --script <text> --avatar <avatarId> [--voice <voiceId>] [--json]
  openwop creative-video text-to-video --org <orgId> --prompt <text> [--model <m>] [--duration-sec <n>] [--json]

AI video jobs (host-extension, ADR 0404). Hits
/v1/host/openwop-app/creative-video/orgs/<orgId>/{jobs,generate,text-to-video}.
\`generate\` renders an avatar video from a script; \`text-to-video\` needs the
creative-video.t2v sub-toggle as well. Both return a job; poll \`jobs get\` until
its status is terminal (each read advances an in-flight job one step).

Exit codes: 0 ok; 1 provider failure (HTTP 502) or server error; 2 usage error,
missing provider connection (409), budget cap (429), or another 4xx;
4 auth/permission denied. A host without video generation answers 501.

Examples:
  openwop creative-video jobs list --org acme
  openwop creative-video generate --org acme --script "Welcome to Acme" --avatar av_1
  openwop creative-video text-to-video --org acme --prompt "a red bicycle at dawn" --duration-sec 5
  openwop creative-video jobs get job_1 --org acme --json
`;

export async function runCreativeVideo(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'jobs';
  if (sub === '--help' || sub === '-h' || sub === 'help') { write(ctx.io.stdout, CREATIVE_VIDEO_HELP); return 0; }
  let rest = argv.slice(1);
  let jobsSub = '';
  if (sub === 'jobs') { jobsSub = rest[0] && !rest[0].startsWith('-') ? rest[0] : 'list'; if (rest[0] === jobsSub) rest = rest.slice(1); }
  const { options, positionals } = parseOptions(rest, {
    bool: ['--help'],
    value: ['--org', '--script', '--avatar', '--voice', '--prompt', '--model', '--duration-sec', '--body', '--body-file'],
  });
  if (options.help) { write(ctx.io.stdout, CREATIVE_VIDEO_HELP); return 0; }
  const org = requireOrg(options.org);
  switch (sub) {
    case 'jobs': {
      if (jobsSub === 'list') {
        const res = await requestJson(ctx, `${base(org)}/jobs`);
        return renderList(ctx, res.body, pickArray(res.body, 'jobs'), ['jobId', 'kind', 'status', 'provider', 'assetId', 'createdAt'], 'No video jobs.');
      }
      if (jobsSub === 'get') {
        const id = positionals[0];
        if (!id) throw new CliError('Usage: openwop creative-video jobs get <jobId> --org <orgId>');
        const res = await requestJson(ctx, `${base(org)}/jobs/${enc(id)}`);
        if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
        const j = res.body ?? {};
        writeLine(ctx.io.stdout, `${j.jobId ?? id}  ${j.kind ?? ''}  ${j.status ?? ''}${j.assetId ? `  asset ${j.assetId}` : ''}${j.error ? `  error: ${j.error}` : ''}`);
        return 0;
      }
      throw new CliError(`Unknown creative-video jobs command: ${jobsSub}`);
    }
    case 'generate': {
      const body = mergeBody(ctx, options, { script: options.script, avatarId: options.avatar, voiceId: options.voice });
      if (!body.script || !body.avatarId) throw new CliError('creative-video generate needs --script and --avatar.');
      return startJob(ctx, `${base(org)}/generate`, body);
    }
    case 'text-to-video': {
      let durationSec: number | undefined;
      if (options.durationSec !== undefined) {
        durationSec = Number(options.durationSec);
        if (!Number.isFinite(durationSec)) throw new CliError('--duration-sec must be a number');
      }
      const body = mergeBody(ctx, options, { prompt: options.prompt, model: options.model, durationSec });
      if (!body.prompt) throw new CliError('creative-video text-to-video needs --prompt.');
      return startJob(ctx, `${base(org)}/text-to-video`, body);
    }
    default:
      throw new CliError(`Unknown creative-video command: ${sub}\nRun \`openwop creative-video --help\` for usage.`);
  }
}

/** POST a generation; a host-reported failed outcome (409/429/502) is rendered legibly. */
async function startJob(ctx: Ctx, path: string, body: Record<string, unknown>): Promise<number> {
  try {
    const res = await requestJson(ctx, path, { method: 'POST', body });
    return renderDone(ctx, res.body, `Video job ${res.body?.jobId ?? ''} ${res.body?.status ?? 'started'}.`);
  } catch (err) {
    const b = err instanceof HttpError ? (err.body as any) : undefined;
    if (err instanceof HttpError && b && b.status === 'failed') {
      if (ctx.json) writeJson(ctx.io.stdout, b);
      else writeLine(ctx.io.stderr, `openwop: video generation failed (HTTP ${err.status}): ${b.error ?? 'unknown error'}${b.error === 'no_connection' ? ' — connect the video provider under Connections first' : ''}`);
      return err.status >= 500 ? 1 : 2;
    }
    throw err;
  }
}

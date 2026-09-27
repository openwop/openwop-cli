import type { Ctx } from '../context.js';
/**
 * `openwop creative-briefs ...` — Creative Briefs (openwop-app ADR 0353; ad-layout
 * renders ADR 0399; text-to-video reel ADR 0411 P3b). Host-extension, org-scoped:
 * `/v1/host/openwop-app/creative-briefs/orgs/<orgId>/...`. Reads need
 * workspace:read, writes workspace:write; approving a brief (`transition
 * --status approved`) is privileged (host:members:manage) — the host decides.
 */
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { requestJson, parseJsonResponse } from '../api.js';
import { CliError, HttpError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { resolveRequest } from '../protocol.js';
import { requireOrg } from './shared.js';
import { csv, enc, mergeBody, parseJsonFlag, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

const base = (org: string) => `/v1/host/openwop-app/creative-briefs/orgs/${enc(org)}`;

export const CREATIVE_BRIEFS_HELP = `Usage:
  openwop creative-briefs list --org <orgId> [--json]
  openwop creative-briefs get <briefId> --org <orgId> [--json]
  openwop creative-briefs create --org <orgId> --title <t> --scene <text> [--asset-type <t>] [--mode manual|extraction|merge] [--body <json>|--body-file <path>] [--json]
  openwop creative-briefs update <briefId> --org <orgId> [--title <t>] [--scene <text>] [--asset-type <t>] [--body <json>|--body-file <path>] [--json]
  openwop creative-briefs delete <briefId> --org <orgId> --yes
  openwop creative-briefs transition <briefId> --org <orgId> --status draft|review|approved [--json]
  openwop creative-briefs versions <briefId> --org <orgId> [--json]
  openwop creative-briefs diff <briefId> --org <orgId> --from <n> --to <n> [--json]
  openwop creative-briefs moodboard <briefId> --org <orgId> [--product <p>] [--industry <i>] [--use-case <u>] [--persona-ids a,b] [--limit <n>] [--json]
  openwop creative-briefs pdf <briefId> --org <orgId> --output <file.pdf>
  openwop creative-briefs reel <briefId> --org <orgId> [--direction-index <n>] [--aspect-ratio <r>] [--duration-seconds <n>] [--provider <p>] [--credential-ref <ref>] [--json]
  openwop creative-briefs render-templates --org <orgId> [--json]
  openwop creative-briefs renders list <briefId> --org <orgId> [--json]
  openwop creative-briefs renders create <briefId> --org <orgId> (--template <id> | --templates a,b) [--direction-index <n>] [--brand <id>] [--animate] [--body <json>|--body-file <path>] [--json]
  openwop creative-briefs renders delete <briefId> <renderId> --org <orgId> --yes

Creative briefs (host-extension, ADR 0353/0399/0411). Hits
/v1/host/openwop-app/creative-briefs/orgs/<orgId>/... — briefs, their version
history + field-level diff, a mood board assembled from the media library, a
PDF export, ad-layout renders from the render-template catalog, and an async
text-to-video reel (returns a runId; follow it with \`openwop runs events\`).

create/update: --title, --scene (sceneDescription), --asset-type map to the
host fields; pass the rest (composition, cameraAngle, lighting, brandPalette,
messagingIntent, platformSpec, directions, moodBoard, kernel, base, platform)
via --body/--body-file (flags win over body keys). update is a merge on the host.

Exit codes: 0 ok; 2 usage error or 4xx; 4 auth/permission denied; 1 server error.

Examples:
  openwop creative-briefs list --org acme
  openwop creative-briefs create --org acme --title "Spring hero" --scene "Bike on a beach at dawn"
  openwop creative-briefs transition br_1 --org acme --status review
  openwop creative-briefs pdf br_1 --org acme --output brief.pdf
  openwop creative-briefs renders create br_1 --org acme --templates ig-square,ig-story
`;

const VALUE_FLAGS = [
  '--org', '--title', '--scene', '--asset-type', '--mode', '--body', '--body-file', '--status', '--from', '--to',
  '--product', '--industry', '--use-case', '--persona-ids', '--limit', '--output', '--direction-index',
  '--aspect-ratio', '--duration-seconds', '--provider', '--credential-ref', '--template', '--templates', '--brand',
];

function num(flag: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`);
  return n;
}

export async function runCreativeBriefs(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h' || sub === 'help') { write(ctx.io.stdout, CREATIVE_BRIEFS_HELP); return 0; }
  if (sub === 'renders') return renders(ctx, argv.slice(1));
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help', '--yes', '--animate'], value: VALUE_FLAGS });
  if (options.help) { write(ctx.io.stdout, CREATIVE_BRIEFS_HELP); return 0; }
  const org = requireOrg(options.org);
  const briefs = `${base(org)}/briefs`;
  const id = positionals[0];
  const needId = (usage: string) => { if (!id) throw new CliError(`Usage: openwop creative-briefs ${usage}`); return enc(id); };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, briefs);
      return renderList(ctx, res.body, pickArray(res.body, 'briefs'), ['briefId', 'title', 'assetType', 'status', 'version'], 'No creative briefs.');
    }
    case 'get': {
      const res = await requestJson(ctx, `${briefs}/${needId('get <briefId> --org <orgId>')}`);
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      const body = mergeBody(ctx, options, {
        title: options.title, sceneDescription: options.scene, assetType: options.assetType, mode: options.mode,
      });
      if (body.mode !== 'extraction' && (!body.title || !body.sceneDescription)) {
        throw new CliError('creative-briefs create needs --title and --scene (or --mode extraction with a kernel in --body).');
      }
      const res = await requestJson(ctx, briefs, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created creative brief ${res.body?.briefId ?? ''}.`);
    }
    case 'update': {
      const path = `${briefs}/${needId('update <briefId> --org <orgId> [--title t] [--body json]')}`;
      const body = mergeBody(ctx, options, { title: options.title, sceneDescription: options.scene, assetType: options.assetType });
      if (Object.keys(body).length === 0) throw new CliError('creative-briefs update needs at least one field (--title/--scene/--asset-type/--body).');
      const res = await requestJson(ctx, path, { method: 'PATCH', body });
      return renderDone(ctx, res.body, `Updated creative brief ${id} (version ${res.body?.version ?? '?'}, status ${res.body?.status ?? '?'}).`);
    }
    case 'delete': {
      const path = `${briefs}/${needId('delete <briefId> --org <orgId> --yes')}`;
      if (!options.yes) throw new CliError(`Refusing to delete creative brief ${id} without --yes.`);
      await requestJson(ctx, path, { method: 'DELETE' });
      return renderDone(ctx, { deleted: true, briefId: id }, `Deleted creative brief ${id}.`);
    }
    case 'transition': {
      const path = `${briefs}/${needId('transition <briefId> --org <orgId> --status <s>')}/transition`;
      if (!options.status) throw new CliError('creative-briefs transition needs --status draft|review|approved.');
      const res = await requestJson(ctx, path, { method: 'POST', body: { status: String(options.status) } });
      return renderDone(ctx, res.body, `Creative brief ${id} is now ${res.body?.status ?? options.status}.`);
    }
    case 'versions': {
      const res = await requestJson(ctx, `${briefs}/${needId('versions <briefId> --org <orgId>')}/versions`);
      return renderList(ctx, res.body, pickArray(res.body, 'versions'), ['version', 'capturedAt', 'capturedBy'], 'No versions.');
    }
    case 'diff': {
      const path = `${briefs}/${needId('diff <briefId> --org <orgId> --from <n> --to <n>')}/diff`;
      if (options.from === undefined || options.to === undefined) throw new CliError('creative-briefs diff needs --from and --to (version numbers).');
      const res = await requestJson(ctx, withQuery(path, { from: options.from, to: options.to }));
      return renderList(ctx, res.body, pickArray(res.body, 'changes'), ['field', 'from', 'to'], 'No changes.');
    }
    case 'moodboard': {
      const path = `${briefs}/${needId('moodboard <briefId> --org <orgId>')}/moodboard`;
      const body = mergeBody(ctx, options, {
        product: options.product, industry: options.industry, useCase: options.useCase,
        personaIds: csv(options.personaIds), limit: num('--limit', options.limit),
      });
      const res = await requestJson(ctx, path, { method: 'POST', body });
      const n = Array.isArray(res.body?.moodBoard) ? res.body.moodBoard.length : 0;
      return renderDone(ctx, res.body, `Assembled mood board for ${id} (${n} item${n === 1 ? '' : 's'}).`);
    }
    case 'pdf': {
      const path = `${briefs}/${needId('pdf <briefId> --org <orgId> --output <file.pdf>')}/pdf`;
      if (!options.output) throw new CliError('creative-briefs pdf needs --output <file.pdf> (the host returns PDF bytes).');
      const bytes = await postForBytes(ctx, path, {});
      const out = resolvePath(ctx.cwd, String(options.output));
      writeFileSync(out, bytes);
      return renderDone(ctx, { output: out, bytes: bytes.length }, `Wrote ${bytes.length} bytes to ${String(options.output)}.`);
    }
    case 'reel': {
      const path = `${briefs}/${needId('reel <briefId> --org <orgId>')}/reel`;
      const body = mergeBody(ctx, options, {
        directionIndex: num('--direction-index', options.directionIndex), aspectRatio: options.aspectRatio,
        durationSeconds: num('--duration-seconds', options.durationSeconds), provider: options.provider,
        credentialRef: options.credentialRef,
      });
      const res = await requestJson(ctx, path, { method: 'POST', body });
      return renderDone(ctx, res.body, `Started reel run ${res.body?.runId ?? ''} (status ${res.body?.status ?? 'pending'}). Follow it with: openwop runs events ${res.body?.runId ?? '<runId>'}`);
    }
    case 'render-templates': {
      const res = await requestJson(ctx, `${base(org)}/render-templates`);
      return renderList(ctx, res.body, pickArray(res.body, 'templates'), ['templateId', 'platform', 'format', 'width', 'height'], 'No render templates.');
    }
    default:
      throw new CliError(`Unknown creative-briefs command: ${sub}\nRun \`openwop creative-briefs --help\` for usage.`);
  }
}

async function renders(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help', '--yes', '--animate'], value: VALUE_FLAGS });
  if (options.help) { write(ctx.io.stdout, CREATIVE_BRIEFS_HELP); return 0; }
  const org = requireOrg(options.org);
  const briefId = positionals[0];
  if (!briefId) throw new CliError(`Usage: openwop creative-briefs renders ${sub} <briefId> --org <orgId>`);
  const path = `${base(org)}/briefs/${enc(briefId)}/renders`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, path);
      return renderList(ctx, res.body, pickArray(res.body, 'renders'), ['renderId', 'templateId', 'briefVersion', 'createdAt'], 'No renders.');
    }
    case 'create': {
      const body = mergeBody(ctx, options, {
        templateId: options.template, templateIds: csv(options.templates),
        directionIndex: num('--direction-index', options.directionIndex), brandId: options.brand,
        animate: options.animate ? true : undefined,
      });
      if (!body.templateId && !Array.isArray(body.templateIds)) throw new CliError('creative-briefs renders create needs --template <id> or --templates a,b.');
      const res = await requestJson(ctx, path, { method: 'POST', body });
      return renderDone(ctx, res.body, res.body?.renderId ? `Created render ${res.body.renderId}.` : `Created ${pickArray(res.body, 'renders').length} render(s).`);
    }
    case 'delete': {
      const renderId = positionals[1];
      if (!renderId) throw new CliError('Usage: openwop creative-briefs renders delete <briefId> <renderId> --org <orgId> --yes');
      if (!options.yes) throw new CliError(`Refusing to delete render ${renderId} without --yes.`);
      await requestJson(ctx, `${path}/${enc(renderId)}`, { method: 'DELETE' });
      return renderDone(ctx, { deleted: true, renderId }, `Deleted render ${renderId}.`);
    }
    default:
      throw new CliError(`Unknown creative-briefs renders command: ${sub}`);
  }
}

/** POST a JSON body and return the raw response bytes (PDF export). */
async function postForBytes(ctx: Ctx, requestedPath: string, body: unknown): Promise<Buffer> {
  const { path, headers } = await resolveRequest(ctx, requestedPath, { accept: 'application/pdf, application/json', 'content-type': 'application/json' });
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
  const res = await ctx.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(`HTTP ${res.status}`, res.status, text ? parseJsonResponse(text) : null);
  }
  return Buffer.from(await res.arrayBuffer());
}


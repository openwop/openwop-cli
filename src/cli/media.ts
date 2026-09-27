import type { Ctx } from '../context.js';
/**
 * `openwop media ...` — the media library (ADR 0007; intelligence/dedup/selection
 * ADR 0352; AI alt-text ADR 0363; AI image generate/edit/upscale ADR 0401), the
 * RFC 0055 §C capability-token asset surface (`assets/:token`, `media/upload`,
 * `media/put`), plus generate-image / transcribe / synthesize via core.openwop.ai.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import { requestJson } from '../api.js';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { resolveRequest } from '../protocol.js';
import { csv, enc, mergeBody, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

export const MEDIA_HELP = `Usage:
  openwop media generate-image <prompt> [--output path] [--json]
  openwop media transcribe <audio-file> [--language en] [--json]
  openwop media synthesize <text> [--voice name] [--output path] [--json]

  Media library (org-scoped, /v1/host/openwop-app/media/orgs/<orgId>/...):
  openwop media assets list --org <orgId> [--collection <id>] [--q <text>] [--tag <t>] [--json]
  openwop media assets get <assetId> --org <orgId> [--json]
  openwop media assets usage <assetId> --org <orgId> [--json]
  openwop media assets create <file> --org <orgId> [--name n] [--content-type t] [--collection id] [--tags a,b] [--body json|--body-file p] [--json]
  openwop media assets bulk <file>... --org <orgId> [--collection id] [--json]
  openwop media assets update <assetId> --org <orgId> [--name n] [--tags a,b] [--collection id|--no-collection] [--alt-text t] [--body json|--body-file p] [--json]
  openwop media assets delete <assetId> --org <orgId> --yes
  openwop media assets use <assetId> --org <orgId> [--json]
  openwop media assets alt-text <assetId> --org <orgId> [--json]
  openwop media assets autotag <assetId> --org <orgId> [--json]
  openwop media assets select --org <orgId> [--product p] [--industry i] [--use-case u] [--persona-ids a,b] [--collection id] [--limit n] [--json]
  openwop media assets generate --org <orgId> --prompt <text> [--provider openai] [--model m] [--size s] [--n N] [--credential-ref r] [--collection id] [--json]
  openwop media assets ai-edit <assetId> --org <orgId> [--op edit|inpaint|background-remove] [--prompt t] [--mask-file png] [--provider p] [--model m] [--credential-ref r] [--json]
  openwop media assets ai-upscale <assetId> --org <orgId> [--scale 2|4] [--provider p] [--model m] [--credential-ref r] [--json]
  openwop media collections list|create <name>|delete <collectionId> --org <orgId> [--yes] [--json]
  openwop media image-providers --org <orgId> [--json]

  Capability-token assets (RFC 0055 §C):
  openwop media upload <file> [--content-type t] [--name n] [--json]    POST /v1/host/openwop-app/media/upload
  openwop media put <file> [--content-type t] [--ttl-seconds N] [--json] POST /v1/host/openwop-app/media/put (test-seam gated)
  openwop media fetch <token> --output <path>                           GET  /v1/host/openwop-app/assets/<token>

Local files are read with the standard library and sent as base64 JSON
(\`contentBase64\` + \`contentType\`); the content type is inferred from the file
extension unless --content-type is given. \`alt-text\` and \`autotag\` return a
PROPOSAL — apply it with \`assets update\`. Library reads need workspace:read,
writes workspace:write in the org (403 → exit 4). \`fetch\` is token-authed: the
token IS the credential. \`put\` is only mounted when the host enables its test seam.

Exercises the host's core.openwop.ai media node family (image-generate,
audio-transcribe, audio-synthesize) through the demo backend's sample media
routes. --output writes the returned binary asset (PNG / WAV) to a file.

Note: the demo backend STUBS the actual provider calls — it advertises
aiProviders.imageGeneration: supported:false and wires no live media
provider — so results are deterministic fixture assets tagged \`stub: true\`,
not live generations. A production host with a wired provider returns real
media at the same endpoints.

Exit codes: 0 ok · 2 usage/4xx · 4 auth/permission denied · 1 host error.

Examples:
  openwop media assets list --org o1 --tag hero
  openwop media assets create ./logo.png --org o1 --tags brand,logo
  openwop media assets generate --org o1 --prompt "a lighthouse at dusk" --provider openai
  openwop media upload ./diagram.pdf --json
  openwop media fetch AbC123 --output diagram.pdf
  openwop media generate-image "a red bicycle" --output bike.png
  openwop media transcribe clip.wav --language en
  openwop media synthesize "hello world" --output hello.wav --json
`;


export async function runMedia(ctx: Ctx, argv: string[]) {
  const sub = argv[0];
  const args = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, MEDIA_HELP);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case 'generate-image':
      return runMediaGenerateImage(ctx, args);
    case 'transcribe':
      return runMediaTranscribe(ctx, args);
    case 'synthesize':
      return runMediaSynthesize(ctx, args);
    case 'assets':
      return runMediaAssets(ctx, args);
    case 'collections':
      return runMediaCollections(ctx, args);
    case 'image-providers':
      return runMediaImageProviders(ctx, args);
    case 'upload':
    case 'put':
      return runMediaStore(ctx, sub, args);
    case 'fetch':
      return runMediaFetch(ctx, args);
    default:
      throw new CliError(`Unknown media command: ${sub}\nRun \`openwop media --help\` for usage.`);
  }
}

async function runMediaGenerateImage(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--prompt', '--output'],
  });
  const prompt = options.prompt ?? positionals.join(' ');
  if (options.help || !prompt) {
    write(ctx.io.stdout, 'Usage: openwop media generate-image <prompt> [--output path] [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, '/v1/host/openwop-app/media/generate-image', {
    method: 'POST',
    body: { prompt },
  });
  if (options.output) await downloadAsset(ctx, res.body.url, options.output);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, formatTable(
    [{ field: 'contentType', value: res.body.contentType ?? '' },
     { field: 'bytes', value: String(res.body.bytes ?? '') },
     { field: 'url', value: res.body.url ?? '' },
     { field: 'stub', value: String(res.body.stub ?? false) }],
    ['field', 'value'],
  ));
  if (options.output) writeLine(ctx.io.stdout, `Wrote asset to ${options.output}`);
  return 0;
}

async function runMediaTranscribe(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--file', '--language'],
  });
  const filePath = options.file ?? positionals[0];
  if (options.help || !filePath) {
    write(ctx.io.stdout, 'Usage: openwop media transcribe <audio-file> [--language en] [--json]\n');
    return options.help ? 0 : 2;
  }
  let audioBase64;
  try {
    audioBase64 = readFileSync(resolvePath(ctx.cwd, filePath)).toString('base64');
  } catch (err) {
    throw new CliError(`Cannot read audio file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = await requestJson(ctx, '/v1/host/openwop-app/media/transcribe', {
    method: 'POST',
    body: { audioBase64, ...(options.language ? { language: options.language } : {}) },
  });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, formatTable(
    [{ field: 'language', value: res.body.language ?? '' },
     { field: 'bytes', value: String(res.body.bytes ?? '') },
     { field: 'stub', value: String(res.body.stub ?? false) }],
    ['field', 'value'],
  ));
  writeLine(ctx.io.stdout, '');
  writeLine(ctx.io.stdout, res.body.text ?? '');
  return 0;
}

async function runMediaSynthesize(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--text', '--voice', '--output'],
  });
  const text = options.text ?? positionals.join(' ');
  if (options.help || !text) {
    write(ctx.io.stdout, 'Usage: openwop media synthesize <text> [--voice name] [--output path] [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, '/v1/host/openwop-app/media/synthesize', {
    method: 'POST',
    body: { text, ...(options.voice ? { voice: options.voice } : {}) },
  });
  if (options.output) await downloadAsset(ctx, res.body.url, options.output);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, formatTable(
    [{ field: 'contentType', value: res.body.contentType ?? '' },
     { field: 'bytes', value: String(res.body.bytes ?? '') },
     { field: 'voice', value: res.body.voice ?? '' },
     { field: 'url', value: res.body.url ?? '' },
     { field: 'stub', value: String(res.body.stub ?? false) }],
    ['field', 'value'],
  ));
  if (options.output) writeLine(ctx.io.stdout, `Wrote asset to ${options.output}`);
  return 0;
}

/** Fetch a media-asset URL (relative to the host base URL) and write the
 *  raw bytes to `outPath`. The asset serve route is token-authed (the URL
 *  IS the credential) so no Authorization header is required. */
async function downloadAsset(ctx: Ctx, assetUrl: any, outPath: any) {
  if (typeof assetUrl !== 'string' || assetUrl.length === 0) {
    throw new CliError('media response did not include an asset URL to download');
  }
  const url = new URL(assetUrl, ctx.baseUrl);
  const res = await ctx.fetchImpl(url, { method: 'GET', headers: { accept: 'application/octet-stream' } });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, null);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(resolvePath(ctx.cwd, outPath), buf);
}

// ── Media library (ADR 0007 / 0352 / 0363 / 0401) ──

const orgBase = (org: string) => `/v1/host/openwop-app/media/orgs/${enc(org)}`;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Read a local file as base64 + an inferred (or explicit) content type. */
function readLocalFile(ctx: Ctx, filePath: string, contentType?: unknown): { contentBase64: string; contentType: string; name: string } {
  let buf: Buffer;
  try {
    buf = readFileSync(resolvePath(ctx.cwd, filePath));
  } catch (err) {
    throw new CliError(`Cannot read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const type = contentType ? String(contentType) : MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (!type) throw new CliError(`Cannot infer a content type for ${filePath} — pass --content-type.`);
  return { contentBase64: buf.toString('base64'), contentType: type, name: basename(filePath) };
}

function requireOrgFlag(org: unknown): string {
  if (!org) throw new CliError('This command is org-scoped — pass --org <orgId>.', 2);
  return String(org);
}

const ASSET_COLUMNS = ['assetId', 'name', 'contentType', 'sizeBytes', 'tags'];
const assetRow = (a: any) => ({
  assetId: a?.assetId ?? a?.id ?? '', name: a?.name ?? '', contentType: a?.contentType ?? '',
  sizeBytes: a?.sizeBytes ?? '', tags: Array.isArray(a?.tags) ? a.tags.join(',') : '',
});

async function runMediaAssets(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes', '--no-collection'],
    value: ['--org', '--collection', '--q', '--tag', '--name', '--content-type', '--tags', '--alt-text', '--body', '--body-file',
      '--product', '--industry', '--use-case', '--persona-ids', '--limit', '--prompt', '--provider', '--model', '--size', '--n',
      '--credential-ref', '--op', '--mask-file', '--scale'],
  });
  if (!sub || options.help || sub === '--help' || sub === '-h') { write(ctx.io.stdout, MEDIA_HELP); return sub ? 0 : 2; }
  const org = requireOrgFlag(options.org);
  const assets = `${orgBase(org)}/assets`;
  const id = positionals[0];
  const needId = (usage: string) => { if (!id) throw new CliError(`Usage: openwop media assets ${usage}`, 2); return `${assets}/${enc(id)}`; };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, withQuery(assets, { collectionId: options.collection, q: options.q, tag: options.tag }));
      return renderList(ctx, res.body, pickArray(res.body, 'assets'), ASSET_COLUMNS, 'No assets.', assetRow);
    }
    case 'get': {
      const res = await requestJson(ctx, needId('get <assetId> --org <orgId>'));
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'usage': {
      const res = await requestJson(ctx, `${needId('usage <assetId> --org <orgId>')}/usage`);
      return renderList(ctx, res.body, pickArray(res.body, 'usage'), ['documentId', 'title', 'kind'], 'Not used by any document.');
    }
    case 'create': {
      const fields: Record<string, unknown> = {
        name: options.name, collectionId: options.collection, tags: csv(options.tags),
      };
      if (id) {
        const f = readLocalFile(ctx, id, options.contentType);
        Object.assign(fields, { contentBase64: f.contentBase64, contentType: f.contentType, name: options.name ?? f.name });
      } else if (options.contentType) fields.contentType = String(options.contentType);
      const body = mergeBody(ctx, options, fields);
      if (!body.contentBase64 || !body.contentType || !body.name) {
        throw new CliError('Usage: openwop media assets create <file> --org <orgId> [--name n] (or --body with contentBase64/contentType/name)', 2);
      }
      const res = await requestJson(ctx, assets, { method: 'POST', body });
      return renderDone(ctx, res.body, `${res.body?.deduplicated ? 'Deduplicated to existing' : 'Created'} asset ${res.body?.assetId ?? ''} (${String(body.name)}).`);
    }
    case 'bulk': {
      let body: Record<string, any>;
      if (positionals.length > 0) {
        const items = positionals.map((p) => { const f = readLocalFile(ctx, p, options.contentType); return { contentBase64: f.contentBase64, contentType: f.contentType, name: f.name }; });
        body = mergeBody(ctx, options, { items, collectionId: options.collection });
      } else {
        body = mergeBody(ctx, options, { collectionId: options.collection });
      }
      if (!Array.isArray(body.items) || body.items.length === 0) throw new CliError('Usage: openwop media assets bulk <file>... --org <orgId> (1–20 files)', 2);
      const res = await requestJson(ctx, `${assets}/bulk`, { method: 'POST', body });
      return renderList(ctx, res.body, pickArray(res.body, 'results'), ['name', 'status', 'assetId', 'message'], 'No results.',
        (r: any) => ({ name: r?.name ?? '', status: r?.status ?? '', assetId: r?.asset?.assetId ?? '', message: r?.message ?? '' }));
    }
    case 'update': {
      const url = needId('update <assetId> --org <orgId> [--name n] [--tags a,b] [--collection id] [--alt-text t]');
      const fields: Record<string, unknown> = { name: options.name, tags: csv(options.tags), altText: options.altText };
      if (options.noCollection) fields.collectionId = null; else if (options.collection) fields.collectionId = String(options.collection);
      const body = mergeBody(ctx, options, fields);
      if (Object.keys(body).length === 0) throw new CliError('media assets update needs at least one field (--name/--tags/--collection/--alt-text/--body).', 2);
      const res = await requestJson(ctx, url, { method: 'PATCH', body });
      return renderDone(ctx, res.body, `Updated asset ${id}.`);
    }
    case 'delete': {
      const url = needId('delete <assetId> --org <orgId> --yes');
      if (!options.yes) throw new CliError(`Refusing to delete asset ${id} without --yes.`, 2);
      await requestJson(ctx, url, { method: 'DELETE' });
      return renderDone(ctx, { deleted: true, assetId: id }, `Deleted asset ${id}.`);
    }
    case 'use': {
      const res = await requestJson(ctx, `${needId('use <assetId> --org <orgId>')}/use`, { method: 'POST', body: {} });
      return renderDone(ctx, res.body, `Marked asset ${id} used (usageCount ${res.body?.usageCount ?? '?'}).`);
    }
    case 'alt-text':
    case 'autotag': {
      const res = await requestJson(ctx, `${needId(`${sub} <assetId> --org <orgId>`)}/${sub}`, { method: 'POST', body: {} });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Proposal (apply with \`openwop media assets update ${id} --org ${org} ...\`):`);
      writeJson(ctx.io.stdout, res.body?.proposal ?? res.body);
      return 0;
    }
    case 'select': {
      const body = mergeBody(ctx, options, {
        product: options.product, industry: options.industry, useCase: options.useCase,
        personaIds: csv(options.personaIds), collectionId: options.collection,
        limit: options.limit !== undefined ? Number(options.limit) : undefined,
      });
      const res = await requestJson(ctx, `${assets}/select`, { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = pickArray(res.body, 'assets', 'selected', 'results');
      if (items.length === 0) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((r: any) => ({ ...assetRow(r?.asset ?? r), score: r?.score ?? '' })), [...ASSET_COLUMNS, 'score']));
      return 0;
    }
    case 'generate': {
      const body = mergeBody(ctx, options, {
        prompt: options.prompt ?? (positionals.length ? positionals.join(' ') : undefined), provider: options.provider,
        model: options.model, size: options.size, n: options.n !== undefined ? Number(options.n) : undefined,
        credentialRef: options.credentialRef, collectionId: options.collection,
      });
      if (!body.prompt) throw new CliError('media assets generate needs --prompt <text>.', 2);
      const res = await requestJson(ctx, `${assets}/generate`, { method: 'POST', body });
      return renderList(ctx, res.body, pickArray(res.body, 'assets'), ASSET_COLUMNS, 'No assets generated.', assetRow);
    }
    case 'ai-edit': {
      const url = `${needId('ai-edit <assetId> --org <orgId> [--op edit|inpaint|background-remove] [--prompt t]')}/ai-edit`;
      const maskBase64 = options.maskFile ? readLocalFile(ctx, String(options.maskFile), 'image/png').contentBase64 : undefined;
      const body = mergeBody(ctx, options, { op: options.op, prompt: options.prompt, maskBase64, provider: options.provider, model: options.model, credentialRef: options.credentialRef });
      const res = await requestJson(ctx, url, { method: 'POST', body });
      return renderList(ctx, res.body, pickArray(res.body, 'assets'), ASSET_COLUMNS, 'No assets derived.', assetRow);
    }
    case 'ai-upscale': {
      const url = `${needId('ai-upscale <assetId> --org <orgId> [--scale 2|4]')}/ai-upscale`;
      const scale = options.scale !== undefined ? Number(options.scale) : undefined;
      if (scale !== undefined && scale !== 2 && scale !== 4) throw new CliError('--scale must be 2 or 4.', 2);
      const body = mergeBody(ctx, options, { scale, provider: options.provider, model: options.model, credentialRef: options.credentialRef });
      const res = await requestJson(ctx, url, { method: 'POST', body });
      return renderList(ctx, res.body, pickArray(res.body, 'assets'), ASSET_COLUMNS, 'No assets derived.', assetRow);
    }
    default:
      throw new CliError(`Unknown media assets command: ${sub}\nRun \`openwop media --help\` for usage.`);
  }
}

async function runMediaCollections(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(['list', 'create', 'delete'].includes(sub) ? 1 : 0), {
    bool: ['--help', '--yes'], value: ['--org', '--name'],
  });
  if (options.help || sub === '--help' || sub === '-h') { write(ctx.io.stdout, MEDIA_HELP); return 0; }
  const url = `${orgBase(requireOrgFlag(options.org))}/collections`;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, url);
      return renderList(ctx, res.body, pickArray(res.body, 'collections'), ['collectionId', 'name', 'createdAt'], 'No collections.',
        (c: any) => ({ collectionId: c?.collectionId ?? c?.id ?? '', name: c?.name ?? '', createdAt: c?.createdAt ?? '' }));
    }
    case 'create': {
      const name = options.name ?? positionals.join(' ');
      if (!name) throw new CliError('Usage: openwop media collections create <name> --org <orgId>', 2);
      const res = await requestJson(ctx, url, { method: 'POST', body: { name: String(name) } });
      return renderDone(ctx, res.body, `Created collection ${res.body?.collectionId ?? res.body?.id ?? ''} (${String(name)}).`);
    }
    case 'delete': {
      const id = positionals[0];
      if (!id) throw new CliError('Usage: openwop media collections delete <collectionId> --org <orgId> --yes', 2);
      if (!options.yes) throw new CliError(`Refusing to delete collection ${id} without --yes (its assets are re-homed).`, 2);
      const res = await requestJson(ctx, `${url}/${enc(id)}`, { method: 'DELETE' });
      return renderDone(ctx, res.body, `Deleted collection ${id}.`);
    }
    default:
      throw new CliError(`Unknown media collections command: ${sub}`);
  }
}

async function runMediaImageProviders(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, MEDIA_HELP); return 0; }
  const res = await requestJson(ctx, `${orgBase(requireOrgFlag(options.org))}/image-providers`);
  return renderList(ctx, res.body, pickArray(res.body, 'providers'), ['provider', 'credentialRefs', 'ops'],
    'No image providers — store a provider key first (openwop byok set).',
    (p: any) => ({ provider: p?.provider ?? '', credentialRefs: Array.isArray(p?.credentialRefs) ? p.credentialRefs.join(',') : '', ops: Array.isArray(p?.ops) ? p.ops.join(',') : '' }));
}

async function runMediaStore(ctx: Ctx, sub: 'upload' | 'put', argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--content-type', '--name', '--ttl-seconds'] });
  const file = positionals[0];
  if (options.help || !file) {
    write(ctx.io.stdout, `Usage: openwop media ${sub} <file> [--content-type t]${sub === 'upload' ? ' [--name n]' : ' [--ttl-seconds N]'} [--json]\n`);
    return options.help ? 0 : 2;
  }
  const f = readLocalFile(ctx, file, options.contentType);
  const body: Record<string, unknown> = { contentBase64: f.contentBase64, contentType: f.contentType };
  if (sub === 'upload') body.name = options.name ? String(options.name) : f.name;
  if (sub === 'put' && options.ttlSeconds !== undefined) body.ttlSeconds = Number(options.ttlSeconds);
  const res = await requestJson(ctx, `/v1/host/openwop-app/media/${sub}`, { method: 'POST', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    ['token', 'url', 'contentType', 'bytes', 'expiresAt'].filter((k) => res.body?.[k] !== undefined).map((k) => ({ field: k, value: String(res.body[k]) })),
    ['field', 'value'],
  ));
  return 0;
}

async function runMediaFetch(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--output'] });
  const token = positionals[0];
  if (options.help || !token || !options.output) {
    write(ctx.io.stdout, 'Usage: openwop media fetch <token> --output <path>\n');
    return options.help ? 0 : 2;
  }
  const { path, headers } = await resolveRequest(ctx, `/v1/host/openwop-app/assets/${enc(token)}`, { accept: '*/*' });
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  const res = await ctx.fetchImpl(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
    throw new HttpError(`HTTP ${res.status}`, res.status, body);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(resolvePath(ctx.cwd, String(options.output)), buf);
  const info = { token, output: String(options.output), bytes: buf.length, contentType: res.headers.get('content-type') ?? '' };
  return renderDone(ctx, info, `Wrote ${buf.length} bytes (${info.contentType}) to ${info.output}.`);
}

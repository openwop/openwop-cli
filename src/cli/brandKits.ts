import type { Ctx } from '../context.js';
/**
 * `openwop brand-kits ...` — marketing brand kits (ADR 0155 brand guardrails;
 * custom fonts ADR 0399; guardrail audit trail ADR 0354 P5).
 *
 * Surface: /v1/host/openwop-app/brand/{channels,brands[/...]} — always-on (no
 * toggle). Read = workspace:read in the brand's org (a miss is a uniform 404);
 * write = workspace:write plus the brand's governance lock (full → org admin;
 * partial → creator / listed editor / org admin). Changing governance itself
 * requires an org admin.
 *
 * Distinct from `openwop brand` (the ONE white-label app identity at
 * /public-brand + /app-brand).
 */
import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import {
  APP, enc, dispatchTable, listOut, detail, done, assign, qs, readBase64, type Cmd,
} from './marketingShared.js';

const B = `${APP}/brand`;
const FONT_ROLES = ['sans', 'serif'];

export const BRAND_KITS_HELP = `Usage:
  openwop brand-kits channels [--json]
  openwop brand-kits list [--org <orgId>] [--json]
  openwop brand-kits get <brandId> [--json]
  openwop brand-kits create --org <orgId> --name <n> [--description <t>] [--status <s>] [--parent-brand-id <id>] [--body <json>|--body-file <f>] [--json]
  openwop brand-kits update <brandId> [--name <n>] [--description <t>] [--status <s>] [--parent-brand-id <id>] [--expected-updated-at <iso>] [--body <json>|--body-file <f>] [--json]
  openwop brand-kits delete <brandId> --yes [--json]
  openwop brand-kits audit <brandId> [--json]
  openwop brand-kits fonts <brandId> [--json]
  openwop brand-kits font-set <brandId> <sans|serif> --file <font.woff2> --license-attested [--json]
  openwop brand-kits font-delete <brandId> <sans|serif> --yes

Marketing brand kits (ADR 0155): per-org brands carrying voice, positioning,
key phrases, channel voice rules, identity and governance. Hits
/v1/host/openwop-app/brand/brands[/{brandId}[/audit|/fonts[/{role}]]] and
/v1/host/openwop-app/brand/channels (the channel vocabulary).

Not to be confused with 'openwop brand', which reads/edits the single
white-label APP identity (/v1/host/openwop-app/public-brand + /app-brand).

'update' is a PATCH: only the fields you pass change. Pass
--expected-updated-at (the brand's updatedAt) to fail with a 409 instead of
overwriting a concurrent edit. Richer fields (voiceProfile, positioning,
keyPhrases, channelVoiceRules, identity, governance) go through --body/--body-file.
A governance change requires an org admin. 'font-set' uploads a custom font
(base64 of --file) and requires --license-attested (ADR 0399); 'audit' lists
the guardrail-change trail.

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown or unreadable brand,
409 = stale --expected-updated-at); 4 auth/permission denied (incl. a brand's
governance lock); 1 server error.

Examples:
  openwop brand-kits list --org org_1
  openwop brand-kits create --org org_1 --name "Acme" --description "Core brand"
  openwop brand-kits update br_1 --body '{"keyPhrases":["fast","friendly"]}'
  openwop brand-kits font-set br_1 sans --file ./Inter.woff2 --license-attested
`;

const BODY_FLAGS = ['--name', '--description', '--status', '--parent-brand-id'];

function brandBody(a: { options: Record<string, any>; body: Record<string, any> }): Record<string, any> {
  const o = a.options;
  return assign({ ...a.body }, { name: o.name, description: o.description, status: o.status, parentBrandId: o.parentBrandId });
}

function role(r: string): string {
  if (!FONT_ROLES.includes(r)) throw new CliError(`role must be one of: ${FONT_ROLES.join(', ')}`, 2);
  return r;
}

const TABLE: Record<string, Cmd> = {
  channels: {
    usage: 'channels [--json]', args: 0,
    run: async (ctx) => listOut(ctx, (await requestJson(ctx, `${B}/channels`)).body, 'channels', [['channel', (c) => (typeof c === 'string' ? c : c?.id ?? JSON.stringify(c))]], 'No channels.'),
  },
  list: {
    usage: 'list [--org <orgId>] [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${B}/brands${qs({ orgId: a.options.org })}`)).body, 'brands',
      ['id', 'name', 'orgId', 'status', ['lock', (b) => b.governance?.lockLevel], 'updatedAt'], 'No brands.'),
  },
  get: {
    usage: 'get <brandId> [--json]', args: 1,
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${B}/brands/${enc(a.positionals[0])}`)).body, 'brand'),
  },
  create: {
    usage: 'create --org <orgId> --name <n> [--description <t>] [--status <s>] [--parent-brand-id <id>] [--body <json>|--body-file <f>] [--json]',
    args: 0, body: true, value: ['--org', ...BODY_FLAGS], requires: ['name'],
    run: async (ctx, a) => {
      const body = brandBody(a);
      if (a.options.org !== undefined) body.orgId = a.options.org;
      if (!body.orgId) throw new CliError('brand-kits create needs --org <orgId>.', 2);
      const res = (await requestJson(ctx, `${B}/brands`, { method: 'POST', body })).body;
      return done(ctx, res, `Created brand ${res?.brand?.id ?? ''} (${res?.brand?.name ?? body.name}).`);
    },
  },
  update: {
    usage: 'update <brandId> [--name <n>] [--description <t>] [--status <s>] [--parent-brand-id <id>] [--expected-updated-at <iso>] [--body <json>|--body-file <f>] [--json]',
    args: 1, body: true, value: [...BODY_FLAGS, '--expected-updated-at'],
    run: async (ctx, a) => {
      const body = assign(brandBody(a), { expectedUpdatedAt: a.options.expectedUpdatedAt });
      if (Object.keys(body).length === 0) throw new CliError('Nothing to update — pass at least one field.', 2);
      const res = (await requestJson(ctx, `${B}/brands/${enc(a.positionals[0])}`, { method: 'PATCH', body })).body;
      return done(ctx, res, `Updated brand ${a.positionals[0]}.`);
    },
  },
  delete: {
    usage: 'delete <brandId> --yes [--json]', args: 1, confirm: 'delete the brand',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${B}/brands/${enc(a.positionals[0])}`, { method: 'DELETE' })).body, `Deleted brand ${a.positionals[0]}.`),
  },
  audit: {
    usage: 'audit <brandId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${B}/brands/${enc(a.positionals[0])}/audit`)).body, 'audit',
      ['changedAt', 'actor', ['fields', (r) => (Array.isArray(r.changes) ? r.changes.map((c: any) => c.field).join(',') : '')]], 'No guardrail changes recorded.'),
  },
  fonts: {
    usage: 'fonts <brandId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${B}/brands/${enc(a.positionals[0])}/fonts`)).body, 'fonts',
      ['role', 'family', 'attestedBy', 'createdAt'], 'No custom fonts.'),
  },
  'font-set': {
    usage: 'font-set <brandId> <sans|serif> --file <font.woff2> --license-attested [--json]',
    args: 2, value: ['--file'], bool: ['--license-attested'], requires: ['file'],
    run: async (ctx, a) => {
      const [brandId, r] = a.positionals;
      const body: Record<string, unknown> = { contentBase64: readBase64(ctx, String(a.options.file), '--file') };
      if (a.options.licenseAttested) body.licenseAttested = true;
      const res = (await requestJson(ctx, `${B}/brands/${enc(brandId)}/fonts/${enc(role(r))}`, { method: 'PUT', body })).body;
      return done(ctx, res, `Set the ${r} font of brand ${brandId}${res?.font?.family ? ` (${res.font.family})` : ''}.`);
    },
  },
  'font-delete': {
    usage: 'font-delete <brandId> <sans|serif> --yes', args: 2, confirm: 'delete the custom font',
    run: async (ctx, a) => {
      const [brandId, r] = a.positionals;
      await requestJson(ctx, `${B}/brands/${enc(brandId)}/fonts/${enc(role(r))}`, { method: 'DELETE' });
      return done(ctx, { deleted: true, brandId, role: r }, `Deleted the ${r} font of brand ${brandId}.`);
    },
  },
};

export async function runBrandKits(ctx: Ctx, argv: string[]) {
  return dispatchTable(ctx, 'brand-kits', BRAND_KITS_HELP, TABLE, argv, 'list');
}

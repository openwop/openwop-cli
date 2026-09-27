import type { Ctx } from '../context.js';
/**
 * `openwop campaign-brief ...` — campaign briefs + personas (ADR 0156), with the
 * brief's voice-of-customer evidence, ad angles, per-platform targeting packs,
 * version history, and the org hook bank.
 *
 * Surface: /v1/host/openwop-app/campaign-brief/* (toggle `campaign-brief`).
 * Read = workspace:read in the entity's org (a miss is a uniform 404);
 * write = workspace:write.
 */
import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { writeLine, writeJson } from '../io.js';
import {
  APP, enc, dispatchTable, listOut, detail, done, assign, qs, parseJsonFlag, type Cmd,
} from './marketingShared.js';

const CB = `${APP}/campaign-brief`;
const HOOK_STATUSES = ['candidate', 'tested', 'retired'];

export const CAMPAIGN_BRIEF_HELP = `Usage:
  openwop campaign-brief buyer-stages [--json]
  openwop campaign-brief personas list [--org <orgId>] [--brand <brandId>] [--json]
  openwop campaign-brief personas get <personaId> [--json]
  openwop campaign-brief personas create --org <orgId> --name <n> [--role <r>] [--buyer-stage <s>] [--brand-id <id>] [--body <json>|--body-file <f>] [--json]
  openwop campaign-brief personas update <personaId> [--name <n>] [--role <r>] [--buyer-stage <s>] [--brand-id <id>] [--body <json>|--body-file <f>] [--json]
  openwop campaign-brief personas delete <personaId> --yes [--json]
  openwop campaign-brief briefs list [--org <orgId>] [--json]
  openwop campaign-brief briefs get <briefId> [--json]
  openwop campaign-brief briefs create --org <orgId> --name <n> [--objective <t>] [--brand-id <id>] [--product-name <n>] [--body <json>|--body-file <f>] [--json]
  openwop campaign-brief briefs update <briefId> [--name <n>] [--objective <t>] [--brand-id <id>] [--product-name <n>] [--body <json>|--body-file <f>] [--json]
  openwop campaign-brief briefs delete <briefId> --yes [--json]
  openwop campaign-brief briefs validate <briefId> [--json]
  openwop campaign-brief briefs duplicate <briefId> [--name <n>] [--json]
  openwop campaign-brief briefs versions <briefId> [--json]
  openwop campaign-brief voc <briefId> [--sentiment pain|desire|objection|praise] [--theme <t>] [--json]
  openwop campaign-brief voc-delete <briefId> <evidenceId> --yes
  openwop campaign-brief angles <briefId> [--json]
  openwop campaign-brief angle-delete <briefId> <angleId> --yes
  openwop campaign-brief targeting <briefId> [--json]
  openwop campaign-brief targeting-delete <briefId> <meta|google|linkedin|tiktok> --yes
  openwop campaign-brief hooks --org <orgId> [--status candidate|tested|retired] [--json]
  openwop campaign-brief hook-promote <hookId> --org <orgId> --status candidate|tested|retired [--metric-ref-json <json>] [--json]

Campaign briefs (ADR 0156). Hits /v1/host/openwop-app/campaign-brief/:
  buyer-stages                 GET  buyer-stages (the stage + channel vocabulary)
  personas ...                 GET/POST personas, GET/PATCH/DELETE personas/{personaId}
  briefs ...                   GET/POST briefs, GET/PATCH/DELETE briefs/{briefId},
                               POST briefs/{id}/validate|duplicate, GET briefs/{id}/versions
  voc / voc-delete             GET briefs/{id}/voc, DELETE briefs/{id}/voc/{evidenceId}
  angles / angle-delete        GET briefs/{id}/angles, DELETE briefs/{id}/angles/{angleId}
  targeting / targeting-delete GET briefs/{id}/targeting, DELETE briefs/{id}/targeting/{platform}
  hooks / hook-promote         GET hooks?orgId=, POST hooks/{hookId}/promote

'update' is a PATCH — only the fields you pass change; richer fields
(painPoints, goals, channels, messaging, budget, utm, personaIds, …) go through
--body/--body-file. 'validate' reports the brief's readiness gaps. Deleting VoC
evidence that stored angles or targeting packs still cite is refused (409) —
delete those first.

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown/unreadable, 409 =
still cited); 4 auth/permission denied; 1 server error.

Examples:
  openwop campaign-brief personas create --org org_1 --name "Ops Director" --buyer-stage awareness
  openwop campaign-brief briefs create --org org_1 --name "Q3 launch" --objective "Drive trials"
  openwop campaign-brief briefs validate br_1
  openwop campaign-brief voc br_1 --sentiment pain
  openwop campaign-brief hook-promote hk_1 --org org_1 --status tested
`;

function personaBody(a: { options: Record<string, any>; body: Record<string, any> }): Record<string, any> {
  const o = a.options;
  return assign({ ...a.body }, { name: o.name, role: o.role, buyerStage: o.buyerStage, brandId: o.brandId });
}

function briefBody(a: { options: Record<string, any>; body: Record<string, any> }): Record<string, any> {
  const o = a.options;
  return assign({ ...a.body }, { name: o.name, objective: o.objective, brandId: o.brandId, productName: o.productName });
}

function withOrg(body: Record<string, any>, org: unknown, what: string): Record<string, any> {
  if (org !== undefined) body.orgId = org;
  if (!body.orgId) throw new CliError(`campaign-brief ${what} create needs --org <orgId>.`, 2);
  return body;
}

function nonEmpty(body: Record<string, any>): Record<string, any> {
  if (Object.keys(body).length === 0) throw new CliError('Nothing to update — pass at least one field.', 2);
  return body;
}

const PERSONA_FLAGS = ['--name', '--role', '--buyer-stage', '--brand-id'];
const BRIEF_FLAGS = ['--name', '--objective', '--brand-id', '--product-name'];

const PERSONAS: Record<string, Cmd> = {
  list: {
    usage: 'list [--org <orgId>] [--brand <brandId>] [--json]', args: 0, value: ['--org', '--brand'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/personas${qs({ orgId: a.options.org, brandId: a.options.brand })}`)).body,
      'personas', ['id', 'name', 'role', 'buyerStage', 'orgId', 'brandId'], 'No personas.'),
  },
  get: {
    usage: 'get <personaId> [--json]', args: 1,
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${CB}/personas/${enc(a.positionals[0])}`)).body, 'persona'),
  },
  create: {
    usage: 'create --org <orgId> --name <n> [--role <r>] [--buyer-stage <s>] [--brand-id <id>] [--body <json>|--body-file <f>] [--json]',
    args: 0, body: true, value: ['--org', ...PERSONA_FLAGS], requires: ['name'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${CB}/personas`, { method: 'POST', body: withOrg(personaBody(a), a.options.org, 'personas') })).body;
      return done(ctx, res, `Created persona ${res?.persona?.id ?? ''} (${res?.persona?.name ?? ''}).`);
    },
  },
  update: {
    usage: 'update <personaId> [--name <n>] [--role <r>] [--buyer-stage <s>] [--brand-id <id>] [--body <json>|--body-file <f>] [--json]',
    args: 1, body: true, value: PERSONA_FLAGS,
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${CB}/personas/${enc(a.positionals[0])}`, { method: 'PATCH', body: nonEmpty(personaBody(a)) })).body, `Updated persona ${a.positionals[0]}.`),
  },
  delete: {
    usage: 'delete <personaId> --yes [--json]', args: 1, confirm: 'delete the persona',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${CB}/personas/${enc(a.positionals[0])}`, { method: 'DELETE' })).body, `Deleted persona ${a.positionals[0]}.`),
  },
};

const BRIEFS: Record<string, Cmd> = {
  list: {
    usage: 'list [--org <orgId>] [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/briefs${qs({ orgId: a.options.org })}`)).body,
      'briefs', ['id', 'name', 'status', 'orgId', 'brandId', 'version'], 'No briefs.'),
  },
  get: {
    usage: 'get <briefId> [--json]', args: 1,
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}`)).body, 'brief'),
  },
  create: {
    usage: 'create --org <orgId> --name <n> [--objective <t>] [--brand-id <id>] [--product-name <n>] [--body <json>|--body-file <f>] [--json]',
    args: 0, body: true, value: ['--org', ...BRIEF_FLAGS], requires: ['name'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${CB}/briefs`, { method: 'POST', body: withOrg(briefBody(a), a.options.org, 'briefs') })).body;
      return done(ctx, res, `Created brief ${res?.brief?.id ?? ''} (${res?.brief?.name ?? ''}).`);
    },
  },
  update: {
    usage: 'update <briefId> [--name <n>] [--objective <t>] [--brand-id <id>] [--product-name <n>] [--body <json>|--body-file <f>] [--json]',
    args: 1, body: true, value: BRIEF_FLAGS,
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}`, { method: 'PATCH', body: nonEmpty(briefBody(a)) })).body, `Updated brief ${a.positionals[0]}.`),
  },
  delete: {
    usage: 'delete <briefId> --yes [--json]', args: 1, confirm: 'delete the brief',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}`, { method: 'DELETE' })).body, `Deleted brief ${a.positionals[0]}.`),
  },
  validate: {
    usage: 'validate <briefId> [--json]', args: 1,
    run: async (ctx, a) => {
      const body = (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}/validate`, { method: 'POST' })).body;
      if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
      writeLine(ctx.io.stdout, `valid: ${body?.valid ? 'yes' : 'no'}`);
      for (const it of Array.isArray(body?.issues) ? body.issues : []) writeLine(ctx.io.stdout, `  ${it.field}: ${it.message}`);
      if (Array.isArray(body?.enabledChannels)) writeLine(ctx.io.stdout, `enabledChannels: ${body.enabledChannels.join(', ') || '(none)'}`);
      return 0;
    },
  },
  duplicate: {
    usage: 'duplicate <briefId> [--name <n>] [--json]', args: 1, value: ['--name'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}/duplicate`, { method: 'POST', body: assign({}, { name: a.options.name }) })).body;
      return done(ctx, res, `Duplicated brief ${a.positionals[0]} as ${res?.brief?.id ?? ''}.`);
    },
  },
  versions: {
    usage: 'versions <briefId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}/versions`)).body,
      'versions', ['versionId', 'version', 'actor', 'createdAt'], 'No versions.'),
  },
};

const TOP: Record<string, Cmd> = {
  'buyer-stages': {
    usage: 'buyer-stages [--json]', args: 0,
    run: async (ctx) => {
      const body = (await requestJson(ctx, `${CB}/buyer-stages`)).body;
      if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
      const fmt = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.id ?? JSON.stringify(x))).join(', ') : '');
      writeLine(ctx.io.stdout, `buyerStages: ${fmt(body?.buyerStages)}`);
      writeLine(ctx.io.stdout, `channels: ${fmt(body?.channels)}`);
      return 0;
    },
  },
  voc: {
    usage: 'voc <briefId> [--sentiment pain|desire|objection|praise] [--theme <t>] [--json]', args: 1, value: ['--sentiment', '--theme'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}/voc${qs({ sentiment: a.options.sentiment, theme: a.options.theme })}`)).body,
      'evidence', ['id', 'sentiment', 'theme', ['quote', (e) => String(e.quote ?? '').slice(0, 60)]], 'No voice-of-customer evidence.'),
  },
  'voc-delete': {
    usage: 'voc-delete <briefId> <evidenceId> --yes', args: 2, confirm: 'delete the evidence',
    run: async (ctx, a) => {
      const [briefId, id] = a.positionals;
      await requestJson(ctx, `${CB}/briefs/${enc(briefId)}/voc/${enc(id)}`, { method: 'DELETE' });
      return done(ctx, { deleted: true, briefId, evidenceId: id }, `Deleted evidence ${id} from brief ${briefId}.`);
    },
  },
  angles: {
    usage: 'angles <briefId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}/angles`)).body,
      'angles', ['id', 'positioningLens', ['claim', (x) => String(x.claim ?? '').slice(0, 60)], ['proofs', (x) => x.proofRefs]], 'No angles.'),
  },
  'angle-delete': {
    usage: 'angle-delete <briefId> <angleId> --yes', args: 2, confirm: 'delete the angle',
    run: async (ctx, a) => {
      const [briefId, id] = a.positionals;
      await requestJson(ctx, `${CB}/briefs/${enc(briefId)}/angles/${enc(id)}`, { method: 'DELETE' });
      return done(ctx, { deleted: true, briefId, angleId: id }, `Deleted angle ${id} from brief ${briefId}.`);
    },
  },
  targeting: {
    usage: 'targeting <briefId> [--json]', args: 1,
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/briefs/${enc(a.positionals[0])}/targeting`)).body,
      'packs', ['platform', ['audiences', (p) => p.audiences], ['interests', (p) => p.interests], ['keywords', (p) => p.keywords]], 'No targeting packs.'),
  },
  'targeting-delete': {
    usage: 'targeting-delete <briefId> <meta|google|linkedin|tiktok> --yes', args: 2, confirm: 'delete the targeting pack',
    run: async (ctx, a) => {
      const [briefId, platform] = a.positionals;
      await requestJson(ctx, `${CB}/briefs/${enc(briefId)}/targeting/${enc(platform)}`, { method: 'DELETE' });
      return done(ctx, { deleted: true, briefId, platform }, `Deleted the ${platform} targeting pack from brief ${briefId}.`);
    },
  },
  hooks: {
    usage: 'hooks --org <orgId> [--status candidate|tested|retired] [--json]', args: 0, value: ['--org', '--status'], requires: ['org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${CB}/hooks${qs({ orgId: a.options.org, status: a.options.status })}`)).body,
      'hooks', ['id', 'status', 'format', ['text', (h) => String(h.text ?? '').slice(0, 60)]], 'No hooks.'),
  },
  'hook-promote': {
    usage: 'hook-promote <hookId> --org <orgId> --status candidate|tested|retired [--metric-ref-json <json>] [--json]',
    args: 1, value: ['--org', '--status', '--metric-ref-json'], requires: ['org', 'status'],
    run: async (ctx, a) => {
      if (!HOOK_STATUSES.includes(String(a.options.status))) throw new CliError(`--status must be one of: ${HOOK_STATUSES.join(', ')}`, 2);
      const body = assign({ orgId: a.options.org, status: a.options.status }, {
        metricRef: a.options.metricRefJson !== undefined ? parseJsonFlag(a.options.metricRefJson, '--metric-ref-json') : undefined,
      });
      const res = (await requestJson(ctx, `${CB}/hooks/${enc(a.positionals[0])}/promote`, { method: 'POST', body })).body;
      return done(ctx, res, `Hook ${a.positionals[0]} is now ${res?.hook?.status ?? a.options.status}.`);
    },
  },
};

export async function runCampaignBrief(ctx: Ctx, argv: string[]) {
  if (argv[0] === 'personas') return dispatchTable(ctx, 'campaign-brief personas', CAMPAIGN_BRIEF_HELP, PERSONAS, argv.slice(1), 'list');
  if (argv[0] === 'briefs') return dispatchTable(ctx, 'campaign-brief briefs', CAMPAIGN_BRIEF_HELP, BRIEFS, argv.slice(1), 'list');
  return dispatchTable(ctx, 'campaign-brief', CAMPAIGN_BRIEF_HELP, TOP, argv, '--help');
}

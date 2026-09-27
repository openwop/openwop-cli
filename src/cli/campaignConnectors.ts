import type { Ctx } from '../context.js';
/**
 * `openwop campaign-connectors ...` — ad-platform connectors + performance data
 * (ADR 0159 — Campaign Studio connectors & performance).
 *
 * Operator surface: /v1/host/openwop-app/campaign-connectors/* (toggle
 * `campaign-connectors`; read = workspace:read, write = workspace:write in the org).
 * Visitor surface (`public ...`): /v1/host/openwop-app/public/{orgId}/pixels and
 * /v1/host/openwop-app/public/{orgId}/conversions — anonymous, consent-gated on the
 * visitor key (`vk`, the 'marketing' consent category).
 */
import { requestJson } from '../api.js';
import { writeLine, writeJson } from '../io.js';
import { requireOrg } from './shared.js';
import {
  APP, enc, dispatchTable, listOut, detail, done, assign, qs, parseJsonFlag, readText, num, type Cmd,
} from './marketingShared.js';

const BASE = `${APP}/campaign-connectors`;
const orgBase = (org: string) => `${BASE}/orgs/${enc(org)}`;

export const CAMPAIGN_CONNECTORS_HELP = `Usage:
  openwop campaign-connectors platforms [--json]
  openwop campaign-connectors sync --org <orgId> --platform meta|google [--json]
  openwop campaign-connectors audience-sync --org <orgId> --segment <segmentId> --ad-account <id> --platform meta|google [--audience-name <n>] [--json]
  openwop campaign-connectors import --org <orgId> --csv-file <path> [--mapping-json '{...}'] [--default-platform <p>] [--campaign <id>] [--preset <name>] [--json]
  openwop campaign-connectors records --org <orgId> [--campaign <id>] [--json]
  openwop campaign-connectors kpi --org <orgId> [--campaign <id>] [--json]
  openwop campaign-connectors sync-status --org <orgId> [--json]
  openwop campaign-connectors pixels list --org <orgId> [--json]
  openwop campaign-connectors pixels set --org <orgId> --platform <p> --pixel-id <id> [--active true|false] [--json]
  openwop campaign-connectors pixels delete <platform> --org <orgId> --yes
  openwop campaign-connectors conversions list --org <orgId> [--json]
  openwop campaign-connectors conversions dispatch --org <orgId> [--json]
  openwop campaign-connectors public pixels <orgId> --vk <visitorKey> [--json]
  openwop campaign-connectors public conversion <orgId> --vk <visitorKey> --event-id <id> --event-name <n> [--email <e>] [--value <n>] [--currency <c>] [--json]

Ad-platform connectors + performance (ADR 0159). Operator commands hit
/v1/host/openwop-app/campaign-connectors/* and need --org:
  sync           POST …/sync — pull yesterday's metrics from Meta or Google (a 429 = cooldown).
  audience-sync  POST …/audience-sync — upload a CRM segment as a hashed custom audience
                 (202 = held for approval).
  import         POST …/import — import a performance CSV (read from --csv-file).
  records / kpi  GET …/records, GET …/kpi — imported rows and the KPI roll-up.
  sync-status    GET …/orgs/{orgId}/sync-status — per-platform last sync.
  pixels         GET/PUT …/orgs/{orgId}/pixels, DELETE …/pixels/{platform}.
  conversions    GET …/orgs/{orgId}/conversions; 'dispatch' POSTs …/conversions/dispatch
                 to send queued server-side conversions to the platforms.

'public' drives the anonymous visitor legs exactly as the frontend does (no auth):
GET /v1/host/openwop-app/public/{orgId}/pixels?vk= (empty unless the visitor has
marketing consent) and POST /v1/host/openwop-app/public/{orgId}/conversions (202;
recorded:false with a reason when the feature is off or consent is missing).

Exit codes: 0 ok; 2 usage error or host 4xx (429 = sync cooldown); 4 auth/permission
denied; 1 server error.

Examples:
  openwop campaign-connectors kpi --org org_1
  openwop campaign-connectors import --org org_1 --csv-file perf.csv --default-platform meta
  openwop campaign-connectors pixels set --org org_1 --platform meta --pixel-id 123456
  openwop campaign-connectors public pixels org_1 --vk v_abc --json
`;

const orgOf = (a: { options: Record<string, any> }) => requireOrg(a.options.org);

const TABLE: Record<string, Cmd> = {
  platforms: {
    usage: 'platforms [--json]', args: 0,
    run: async (ctx) => {
      const body = (await requestJson(ctx, `${BASE}/platforms`)).body;
      if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
      writeLine(ctx.io.stdout, (Array.isArray(body?.platforms) ? body.platforms : []).join('\n') || 'No platforms.');
      return 0;
    },
  },
  sync: {
    usage: 'sync --org <orgId> --platform meta|google [--json]', args: 0, body: true, value: ['--org', '--platform'], requires: ['platform'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, { orgId: orgOf(a), platform: a.options.platform });
      const body = (await requestJson(ctx, `${BASE}/sync`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Sync ${body?.outcome ?? 'done'}${body?.imported !== undefined ? ` (${body.imported} imported)` : ''}.`);
    },
  },
  'audience-sync': {
    usage: 'audience-sync --org <orgId> --segment <segmentId> --ad-account <id> --platform meta|google [--audience-name <n>] [--json]',
    args: 0, body: true, value: ['--org', '--segment', '--ad-account', '--platform', '--audience-name'],
    requires: ['platform'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, { orgId: orgOf(a), segmentId: o.segment, adAccountId: o.adAccount, platform: o.platform, audienceName: o.audienceName });
      const body = (await requestJson(ctx, `${BASE}/audience-sync`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Audience sync: ${body?.outcome ?? 'done'}.`);
    },
  },
  import: {
    usage: "import --org <orgId> --csv-file <path> [--mapping-json '{...}'] [--default-platform <p>] [--campaign <id>] [--preset <name>] [--json]",
    args: 0, body: true, value: ['--org', '--csv-file', '--mapping-json', '--default-platform', '--campaign', '--preset'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        orgId: orgOf(a),
        csv: o.csvFile !== undefined ? readText(ctx, String(o.csvFile), '--csv-file') : undefined,
        mapping: o.mappingJson !== undefined ? parseJsonFlag(o.mappingJson, '--mapping-json') : undefined,
        defaultPlatform: o.defaultPlatform, campaignId: o.campaign, preset: o.preset,
      });
      if (req.csv === undefined) { writeLine(ctx.io.stderr, 'openwop: missing --csv-file'); return 2; }
      const body = (await requestJson(ctx, `${BASE}/import`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Imported ${body?.imported ?? 0} rows (${body?.deduped ?? 0} deduped, ${Array.isArray(body?.invalid) ? body.invalid.length : body?.invalid ?? 0} invalid).`);
    },
  },
  records: {
    usage: 'records --org <orgId> [--campaign <id>] [--json]', args: 0, value: ['--org', '--campaign'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${BASE}/records${qs({ orgId: orgOf(a), campaignId: a.options.campaign })}`)).body,
      'records', ['date', 'platform', 'campaignId', 'impressions', 'clicks', 'spend', 'conversions'], 'No performance records.'),
  },
  kpi: {
    usage: 'kpi --org <orgId> [--campaign <id>] [--json]', args: 0, value: ['--org', '--campaign'],
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${BASE}/kpi${qs({ orgId: orgOf(a), campaignId: a.options.campaign })}`)).body),
  },
  'sync-status': {
    usage: 'sync-status --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${orgBase(orgOf(a))}/sync-status`)).body,
      'platforms', ['platform', 'lastSyncAt', 'lastOutcome', 'lastError'], 'No sync history.'),
  },
};

const PIXELS: Record<string, Cmd> = {
  list: {
    usage: 'list --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${orgBase(orgOf(a))}/pixels`)).body,
      'pixels', ['platform', 'pixelId', 'active', 'updatedAt'], 'No pixels configured.'),
  },
  set: {
    usage: 'set --org <orgId> --platform <p> --pixel-id <id> [--active true|false] [--json]', args: 0, body: true,
    value: ['--org', '--platform', '--pixel-id', '--active'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        platform: o.platform, pixelId: o.pixelId,
        active: o.active !== undefined ? String(o.active) === 'true' : undefined,
      });
      const body = (await requestJson(ctx, `${orgBase(orgOf(a))}/pixels`, { method: 'PUT', body: req })).body;
      return done(ctx, body, `Saved ${body?.pixel?.platform ?? req.platform ?? ''} pixel ${body?.pixel?.pixelId ?? req.pixelId ?? ''}.`);
    },
  },
  delete: {
    usage: 'delete <platform> --org <orgId> --yes', args: 1, value: ['--org'], confirm: 'delete the pixel',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${orgBase(orgOf(a))}/pixels/${enc(a.positionals[0])}`, { method: 'DELETE' })).body,
      `Deleted the ${a.positionals[0]} pixel.`),
  },
};

const CONVERSIONS: Record<string, Cmd> = {
  list: {
    usage: 'list --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${orgBase(orgOf(a))}/conversions`)).body,
      'conversions', ['eventId', 'eventName', 'at', 'value', 'currency', ['status', (c) => c.status ?? c.dispatch]], 'No conversions.'),
  },
  dispatch: {
    usage: 'dispatch --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => {
      const body = (await requestJson(ctx, `${orgBase(orgOf(a))}/conversions/dispatch`, { method: 'POST' })).body;
      return done(ctx, body, `Dispatched ${typeof body?.sent === 'object' ? JSON.stringify(body.sent) : body?.sent ?? 0} queued conversions.`);
    },
  },
};

const PUBLIC: Record<string, Cmd> = {
  pixels: {
    usage: 'pixels <orgId> --vk <visitorKey> [--json]', args: 1, value: ['--vk'], requires: ['vk'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${APP}/public/${enc(a.positionals[0])}/pixels${qs({ vk: a.options.vk })}`, { auth: false })).body,
      'pixels', ['platform', 'pixelId'], 'No pixels for this visitor (feature off or no marketing consent).'),
  },
  conversion: {
    usage: 'conversion <orgId> --vk <visitorKey> --event-id <id> --event-name <n> [--email <e>] [--value <n>] [--currency <c>] [--json]',
    args: 1, body: true, value: ['--vk', '--event-id', '--event-name', '--email', '--value', '--currency'], requires: ['vk'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        vk: o.vk, eventId: o.eventId, eventName: o.eventName, email: o.email,
        value: o.value !== undefined ? num(o.value, '--value') : undefined, currency: o.currency,
      });
      const body = (await requestJson(ctx, `${APP}/public/${enc(a.positionals[0])}/conversions`, { method: 'POST', body: req, auth: false })).body;
      return done(ctx, body, body?.recorded
        ? `Recorded conversion ${body.eventId ?? ''}${body.deduped ? ' (deduplicated)' : ''}.`
        : `Not recorded (${body?.reason ?? 'unknown'}).`);
    },
  },
};

export async function runCampaignConnectors(ctx: Ctx, argv: string[]) {
  if (argv[0] === 'pixels') return dispatchTable(ctx, 'campaign-connectors pixels', CAMPAIGN_CONNECTORS_HELP, PIXELS, argv.slice(1), 'list');
  if (argv[0] === 'conversions') return dispatchTable(ctx, 'campaign-connectors conversions', CAMPAIGN_CONNECTORS_HELP, CONVERSIONS, argv.slice(1), 'list');
  if (argv[0] === 'public') return dispatchTable(ctx, 'campaign-connectors public', CAMPAIGN_CONNECTORS_HELP, PUBLIC, argv.slice(1), '--help');
  return dispatchTable(ctx, 'campaign-connectors', CAMPAIGN_CONNECTORS_HELP, TABLE, argv, 'platforms');
}

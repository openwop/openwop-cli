import type { Ctx } from '../context.js';
/**
 * `openwop campaign-intel ...` — campaign intelligence (ADR 0160, over the
 * ADR 0159 performance records).
 *
 * Surface: /v1/host/openwop-app/campaign-intel/* (toggle `campaign-intel`; every
 * read needs workspace:read in the org; `apply` needs workspace:write).
 */
import { requestJson } from '../api.js';
import { writeLine } from '../io.js';
import { requireOrg } from './shared.js';
import { APP, dispatchTable, listOut, detail, done, assign, qs, num, type Cmd } from './marketingShared.js';

const BASE = `${APP}/campaign-intel`;

export const CAMPAIGN_INTEL_HELP = `Usage:
  openwop campaign-intel budget --org <orgId> [--campaign <id>] [--json]
  openwop campaign-intel forecast --org <orgId> [--campaign <id>] [--json]
  openwop campaign-intel anomalies --org <orgId> [--json]
  openwop campaign-intel overview --org <orgId> [--json]
  openwop campaign-intel attribution --org <orgId> [--json]
  openwop campaign-intel pacing --org <orgId> [--json]
  openwop campaign-intel plan-budget --org <orgId> --total-budget-minor <n> --target-conversions <n> --horizon-days <n>
                                     [--platform <p>]... [--shift-from <p> --shift-to <p> --shift-pct <n>] [--json]
  openwop campaign-intel apply --org <orgId> --platform <p> --ad-account <id> --campaign <id> --daily-budget-minor <n> (--dry-run | --yes) [--json]

Campaign intelligence (ADR 0160) over the imported performance records. Every
command needs --org and hits /v1/host/openwop-app/campaign-intel/*:
  budget       GET …/budget — the budget optimizer's reallocation suggestion.
  forecast     GET …/forecast — per-campaign forecasts.
  anomalies    GET …/anomalies — spend/CTR/CPA anomalies.
  overview     GET …/overview — funnel by platform + top/bottom performers.
  attribution  GET …/attribution — multi-touch attribution report.
  pacing       GET …/pacing — spend pacing against budget.
  plan-budget  POST …/plan-budget — plan a budget split (amounts are minor units,
               e.g. cents); --shift-* adds a what-if scenario moving pct between platforms.
  apply        POST …/recommendations/apply — set a campaign's daily budget on the
               ad platform. This changes real spend, so it needs --yes, or --dry-run
               to preview the platform call without sending it.

Exit codes: 0 ok; 2 usage error or host 4xx; 4 auth/permission denied; 1 server error.

Examples:
  openwop campaign-intel overview --org org_1
  openwop campaign-intel plan-budget --org org_1 --total-budget-minor 500000 --target-conversions 200 --horizon-days 30 --platform meta --platform google
  openwop campaign-intel apply --org org_1 --platform meta --ad-account act_1 --campaign c_1 --daily-budget-minor 5000 --dry-run
`;

const orgOf = (a: { options: Record<string, any> }) => requireOrg(a.options.org);

const read = (name: string, withCampaign: boolean): Cmd => ({
  usage: `${name} --org <orgId>${withCampaign ? ' [--campaign <id>]' : ''} [--json]`, args: 0,
  value: ['--org', ...(withCampaign ? ['--campaign'] : [])],
  run: async (ctx, a) => {
    const body = (await requestJson(ctx, `${BASE}/${name}${qs({ orgId: orgOf(a), campaignId: withCampaign ? a.options.campaign : undefined })}`)).body;
    if (name === 'anomalies') return listOut(ctx, body, 'anomalies', ['date', 'platform', 'campaignId', 'metric', 'severity', 'message'], 'No anomalies.');
    if (name === 'forecast') return listOut(ctx, body, 'forecasts', ['campaignId', 'platform', 'horizonDays', 'projectedSpend', 'projectedConversions'], 'No forecasts (no performance records).');
    return detail(ctx, body);
  },
});

const TABLE: Record<string, Cmd> = {
  budget: read('budget', true),
  forecast: read('forecast', true),
  anomalies: read('anomalies', false),
  overview: read('overview', false),
  attribution: read('attribution', false),
  pacing: read('pacing', false),
  'plan-budget': {
    usage: 'plan-budget --org <orgId> --total-budget-minor <n> --target-conversions <n> --horizon-days <n> [--platform <p>]... [--shift-from <p> --shift-to <p> --shift-pct <n>] [--json]',
    args: 0, body: true, value: ['--org', '--total-budget-minor', '--target-conversions', '--horizon-days', '--shift-from', '--shift-to', '--shift-pct'],
    multi: ['--platform'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        orgId: orgOf(a),
        totalBudgetMinor: o.totalBudgetMinor !== undefined ? num(o.totalBudgetMinor, '--total-budget-minor') : undefined,
        targetConversions: o.targetConversions !== undefined ? num(o.targetConversions, '--target-conversions') : undefined,
        horizonDays: o.horizonDays !== undefined ? num(o.horizonDays, '--horizon-days') : undefined,
        platforms: Array.isArray(o.platform) && o.platform.length ? o.platform : undefined,
        scenario: o.shiftFrom !== undefined || o.shiftTo !== undefined || o.shiftPct !== undefined
          ? { from: o.shiftFrom, to: o.shiftTo, pct: num(o.shiftPct, '--shift-pct') } : undefined,
      });
      for (const [k, flag] of [['totalBudgetMinor', '--total-budget-minor'], ['targetConversions', '--target-conversions'], ['horizonDays', '--horizon-days']] as const) {
        if (req[k] === undefined) { writeLine(ctx.io.stderr, `openwop: missing ${flag}`); return 2; }
      }
      return detail(ctx, (await requestJson(ctx, `${BASE}/plan-budget`, { method: 'POST', body: req })).body);
    },
  },
  apply: {
    usage: 'apply --org <orgId> --platform <p> --ad-account <id> --campaign <id> --daily-budget-minor <n> (--dry-run | --yes) [--json]',
    args: 0, body: true, bool: ['--dry-run', '--yes'], value: ['--org', '--platform', '--ad-account', '--campaign', '--daily-budget-minor'],
    requires: ['platform'],
    run: async (ctx, a) => {
      const o = a.options;
      const dryRun = o.dryRun === true || a.body.dryRun === true;
      if (!dryRun && !o.yes) {
        writeLine(ctx.io.stderr, 'Refusing to change a live campaign budget without --yes (use --dry-run to preview).');
        return 2;
      }
      const req = assign({ ...a.body }, {
        orgId: orgOf(a), platform: o.platform, adAccountId: o.adAccount, campaignId: o.campaign,
        dailyBudgetMinor: o.dailyBudgetMinor !== undefined ? num(o.dailyBudgetMinor, '--daily-budget-minor') : undefined,
        dryRun: dryRun ? true : undefined,
      });
      const body = (await requestJson(ctx, `${BASE}/recommendations/apply`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Budget ${dryRun ? 'preview' : 'update'}: ${body?.outcome ?? 'done'}.`);
    },
  },
};

export async function runCampaignIntel(ctx: Ctx, argv: string[]) {
  return dispatchTable(ctx, 'campaign-intel', CAMPAIGN_INTEL_HELP, TABLE, argv, '--help');
}

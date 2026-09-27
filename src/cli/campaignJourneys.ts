import type { Ctx } from '../context.js';
/**
 * `openwop campaign-journeys ...` — the journey enrollment ledger (ADR 0222;
 * exclusivity groups ADR 0299).
 *
 * Surface: /v1/host/openwop-app/campaign-journeys/enrollments (toggle
 * `campaign-journeys`). Journeys themselves are workflow chains — run and
 * monitor them with `openwop runs` / `openwop workflows`; this group only reads
 * which contact entered which journey, and resets a guard row so a contact can
 * re-enroll. Sibling of `openwop campaigns-orchestration`.
 */
import { requestJson } from '../api.js';
import { APP, dispatchTable, listOut, done, qs, type Cmd } from './marketingShared.js';

const E = `${APP}/campaign-journeys/enrollments`;

export const CAMPAIGN_JOURNEYS_HELP = `Usage:
  openwop campaign-journeys enrollments [--journey <journeyId>] [--json]
  openwop campaign-journeys reset --journey <journeyId> --contact <contactId> --yes [--json]

Campaign journeys (ADR 0222). 'enrollments' lists the enrollment ledger
(GET /v1/host/openwop-app/campaign-journeys/enrollments[?journeyId=]) — which
contact ran which journey, when, and under which run. 'reset' deletes one
(journey, contact) guard row (DELETE …/enrollments with {journeyId, contactId})
so that contact can enroll again — an explicit operator decision, so it needs --yes.

Journeys are workflow chains; run and watch them with 'openwop runs'. For
orchestrated campaigns see 'openwop campaigns-orchestration'.

Exit codes: 0 ok; 2 usage error or host 4xx; 4 auth/permission denied; 1 server error.

Examples:
  openwop campaign-journeys enrollments --journey wf.welcome
  openwop campaign-journeys reset --journey wf.welcome --contact c_42 --yes
`;

const TABLE: Record<string, Cmd> = {
  enrollments: {
    usage: 'enrollments [--journey <journeyId>] [--json]', args: 0, value: ['--journey'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${E}${qs({ journeyId: a.options.journey })}`)).body,
      'enrollments', ['journeyId', 'contactId', 'enrolledAt', 'runId', 'exclusivityGroup'], 'No enrollments.'),
  },
  reset: {
    usage: 'reset --journey <journeyId> --contact <contactId> --yes [--json]', args: 0,
    value: ['--journey', '--contact'], requires: ['journey', 'contact'], confirm: 'reset the enrollment',
    run: async (ctx, a) => {
      const body = (await requestJson(ctx, E, { method: 'DELETE', body: { journeyId: a.options.journey, contactId: a.options.contact } })).body;
      return done(ctx, body, body?.reset
        ? `Reset enrollment of ${a.options.contact} in ${a.options.journey}; the contact may enroll again.`
        : `No enrollment of ${a.options.contact} in ${a.options.journey} to reset.`);
    },
  },
};

export async function runCampaignJourneys(ctx: Ctx, argv: string[]) {
  return dispatchTable(ctx, 'campaign-journeys', CAMPAIGN_JOURNEYS_HELP, TABLE, argv, 'enrollments');
}

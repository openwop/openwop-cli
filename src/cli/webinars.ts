import type { Ctx } from '../context.js';
/**
 * `openwop webinars ...` — webinar / marketing events (ADR 0404).
 *
 * Surface: /v1/host/openwop-app/webinars/orgs/{orgId}/events[/{eventId}/...]
 * (toggle `webinars`; read = workspace:read, write = workspace:write in the org).
 * The provider (e.g. Zoom) is reached through the org's connection; the host
 * is the authority for every sync/push outcome.
 */
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { APP, enc, dispatchTable, listOut, done, assign, type Cmd } from './marketingShared.js';

const base = (org: string) => `${APP}/webinars/orgs/${enc(org)}/events`;

export const WEBINARS_HELP = `Usage:
  openwop webinars list --org <orgId> [--json]
  openwop webinars create --org <orgId> --provider-event-id <id> [--provider zoom] [--title <t>] [--starts-at <iso>] [--connection <connectionId>] [--journey <journeyId>] [--body <json>] [--json]
  openwop webinars bind-form <eventId> --org <orgId> --form <formId> [--json]
  openwop webinars sync <eventId> --org <orgId> [--json]
  openwop webinars push-registrants <eventId> --org <orgId> [--json]

Webinar events (ADR 0404). 'list' reads the org's events with registrant /
attendee / no-show counts and the pending-push queue depth. 'create' registers
(upserts) a provider event (default provider: zoom). 'bind-form' routes a form's
submissions to the event as registrants; 'sync' pulls registrants + attendance
from the provider; 'push-registrants' drains up to 50 queued registrants to the
provider. All hit /v1/host/openwop-app/webinars/orgs/{orgId}/events and need --org.

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown event/form);
4 auth/permission denied; 1 server error, or 'push-registrants' left any
registrant unpushed (the failures are listed).

Examples:
  openwop webinars list --org org_1
  openwop webinars create --org org_1 --provider-event-id 81234567890 --title "Launch webinar"
  openwop webinars bind-form ev_1 --org org_1 --form form_1
  openwop webinars sync ev_1 --org org_1 --json
`;

function orgOf(a: { options: Record<string, any> }): string { return requireOrg(a.options.org); }

const TABLE: Record<string, Cmd> = {
  list: {
    usage: 'list --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, base(orgOf(a)))).body, 'events', [
      'eventId', 'provider', 'title', 'startsAt',
      ['registrants', (e) => e.counts?.registrantCount], ['attendees', (e) => e.counts?.attendeeCount],
      ['noShows', (e) => e.counts?.noShowCount], ['pendingPush', (e) => e.pendingPushCount],
    ], 'No webinar events.'),
  },
  create: {
    usage: 'create --org <orgId> --provider-event-id <id> [--provider zoom] [--title <t>] [--starts-at <iso>] [--connection <id>] [--journey <id>] [--body <json>] [--json]',
    args: 0, body: true, value: ['--org', '--provider-event-id', '--provider', '--title', '--starts-at', '--connection', '--journey'], requires: ['providerEventId'],
    run: async (ctx, a) => {
      const o = a.options;
      const body = assign({ ...a.body }, {
        provider: o.provider, providerEventId: o.providerEventId, title: o.title, startsAt: o.startsAt,
        connectionId: o.connection, journeyId: o.journey,
      });
      const res = (await requestJson(ctx, base(orgOf(a)), { method: 'POST', body })).body;
      return done(ctx, res, `Registered webinar event ${res?.eventId ?? ''}.`);
    },
  },
  'bind-form': {
    usage: 'bind-form <eventId> --org <orgId> --form <formId> [--json]', args: 1, value: ['--org', '--form'], requires: ['form'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}/bind-form`, { method: 'POST', body: { formId: a.options.form } })).body;
      return done(ctx, res, `Bound form ${a.options.form} to event ${a.positionals[0]}.`);
    },
  },
  sync: {
    usage: 'sync <eventId> --org <orgId> [--json]', args: 1, value: ['--org'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}/sync`, { method: 'POST' })).body;
      return done(ctx, res, `Synced event ${a.positionals[0]}: ${JSON.stringify(res ?? {})}`);
    },
  },
  'push-registrants': {
    usage: 'push-registrants <eventId> --org <orgId> [--json]', args: 1, value: ['--org'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${base(orgOf(a))}/${enc(a.positionals[0])}/push-registrants`, { method: 'POST' })).body;
      const fails = Array.isArray(res?.failures) && res.failures.length
        ? `\n${res.failures.map((f: any) => `  failed: ${f.email} — ${f.reason}`).join('\n')}` : '';
      const code = done(ctx, res, `Pushed ${res?.pushed ?? 0} registrant(s); ${res?.failed ?? 0} failed.${fails}`);
      return res?.failed > 0 ? 1 : code;
    },
  },
};

export async function runWebinars(ctx: Ctx, argv: string[]) {
  return dispatchTable(ctx, 'webinars', WEBINARS_HELP, TABLE, argv, 'list');
}

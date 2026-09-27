import type { Ctx } from '../context.js';
/**
 * `openwop cdp ...` — the customer data platform spine (ADR 0263; entitlement
 * gate ADR 0419).
 *
 * Surface: /v1/host/openwop-app/cdp/* (toggle `cdp`). Identity resolution masks
 * PII for API-key principals; `audit-verify` needs an org admin/owner role.
 */
import { requestJson } from '../api.js';
import { HttpError } from '../errors.js';
import { writeLine, writeJson } from '../io.js';
import {
  APP, enc, dispatchTable, listOut, detail, done, assign, qs, parseJsonFlag, readText, type Cmd,
} from './marketingShared.js';

const BASE = `${APP}/cdp`;

export const CDP_HELP = `Usage:
  openwop cdp resolve --type <identifierType> --value <v> [--json]
  openwop cdp schemas list [--json]
  openwop cdp schemas register --event-type <t> (--schema-json '{...}' | --schema-file <f>) [--json]
  openwop cdp schemas validate <eventType> (--payload-json '{...}' | --payload-file <f>) [--json]
  openwop cdp collect --event-type <t> [--payload-json '{...}'] [--dedupe-key <k>] [--json]
  openwop cdp collect-batch (--events-json '[...]' | --events-file <f>) [--json]
  openwop cdp import --csv-file <f> [--event-type <t> | --event-type-column <col>] [--dedup-key-field <col>] [--json]
  openwop cdp events [--limit <n>] [--json]
  openwop cdp merge-events [--limit <n>] [--json]
  openwop cdp governance [--limit <n>] [--json]
  openwop cdp audit-verify [--json]

Customer data platform (ADR 0263) under /v1/host/openwop-app/cdp/*:
  resolve         GET …/identity/resolve?type=&value= — the unified customer for an
                  identifier (email, phone, …); PII is masked for API-key callers.
  schemas         GET/POST …/event-schemas; 'validate' POSTs
                  …/event-schemas/{eventType}/validate (a 422 = the payload is invalid;
                  the CLI prints the errors and exits 1).
  collect         POST …/collect — record one event (dedupe-key makes it idempotent).
  collect-batch   POST …/collect/batch — record an array of {eventType,payload,dedupeKey}.
  import          POST …/collect/import — import events from a CSV file.
  events          GET …/collected-events — recent collected events (limit 1–500).
  merge-events    GET …/merge-events — identity merge history.
  governance      GET …/governance-decisions — the governance decision log.
  audit-verify    GET …/audit-chain/verify — verify the tamper-evident audit chain
                  (org admin/owner only).

Exit codes: 0 ok (validate: payload valid); 1 validate: payload invalid, or server
error; 2 usage error or host 4xx; 4 auth/permission denied.

Examples:
  openwop cdp resolve --type email --value ada@example.com
  openwop cdp schemas register --event-type order.placed --schema-file order.schema.json
  openwop cdp collect --event-type page.viewed --payload-json '{"path":"/pricing"}' --dedupe-key pv-1
  openwop cdp events --limit 20 --json
`;

function jsonFrom(ctx: Ctx, inline: unknown, file: unknown, inlineFlag: string, fileFlag: string): unknown {
  if (inline !== undefined) return parseJsonFlag(String(inline), inlineFlag);
  if (file !== undefined) return parseJsonFlag(readText(ctx, String(file), fileFlag), fileFlag);
  return undefined;
}

const limited = (path: string, key: string, columns: Parameters<typeof listOut>[3], empty: string): Cmd => ({
  usage: `${path === 'governance-decisions' ? 'governance' : path === 'collected-events' ? 'events' : path} [--limit <n>] [--json]`,
  args: 0, value: ['--limit'],
  run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${BASE}/${path}${qs({ limit: a.options.limit })}`)).body, key, columns, empty),
});

const TABLE: Record<string, Cmd> = {
  resolve: {
    usage: 'resolve --type <identifierType> --value <v> [--json]', args: 0, value: ['--type', '--value'], requires: ['type', 'value'],
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, `${BASE}/identity/resolve${qs({ type: a.options.type, value: a.options.value })}`)).body),
  },
  collect: {
    usage: "collect --event-type <t> [--payload-json '{...}'] [--dedupe-key <k>] [--json]", args: 0, body: true,
    value: ['--event-type', '--payload-json', '--dedupe-key'], requires: ['eventType'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        eventType: o.eventType,
        payload: o.payloadJson !== undefined ? parseJsonFlag(o.payloadJson, '--payload-json') : undefined,
        dedupeKey: o.dedupeKey,
      });
      const body = (await requestJson(ctx, `${BASE}/collect`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Collected ${req.eventType} event ${body?.eventId ?? body?.event?.eventId ?? ''}${body?.deduped ? ' (deduplicated)' : ''}.`);
    },
  },
  'collect-batch': {
    usage: "collect-batch (--events-json '[...]' | --events-file <f>) [--json]", args: 0, body: true, value: ['--events-json', '--events-file'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, { events: jsonFrom(ctx, a.options.eventsJson, a.options.eventsFile, '--events-json', '--events-file') });
      if (req.events === undefined) { writeLine(ctx.io.stderr, 'openwop: missing --events-json or --events-file'); return 2; }
      return detail(ctx, (await requestJson(ctx, `${BASE}/collect/batch`, { method: 'POST', body: req })).body);
    },
  },
  import: {
    usage: 'import --csv-file <f> [--event-type <t> | --event-type-column <col>] [--dedup-key-field <col>] [--json]', args: 0, body: true,
    value: ['--csv-file', '--event-type', '--event-type-column', '--dedup-key-field'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        csv: o.csvFile !== undefined ? readText(ctx, String(o.csvFile), '--csv-file') : undefined,
        eventType: o.eventType, eventTypeColumn: o.eventTypeColumn, dedupKeyField: o.dedupKeyField,
      });
      if (req.csv === undefined) { writeLine(ctx.io.stderr, 'openwop: missing --csv-file'); return 2; }
      return detail(ctx, (await requestJson(ctx, `${BASE}/collect/import`, { method: 'POST', body: req })).body);
    },
  },
  events: limited('collected-events', 'events', ['eventId', 'eventType', ['at', (e) => e.at ?? e.receivedAt ?? e.createdAt], 'dedupeKey'], 'No collected events.'),
  'merge-events': limited('merge-events', 'events', ['mergeId', ['survivor', (e) => e.survivorId ?? e.winnerId], ['merged', (e) => e.mergedId ?? e.loserId], ['at', (e) => e.at ?? e.createdAt]], 'No merge events.'),
  governance: limited('governance-decisions', 'decisions', ['decisionId', 'kind', 'outcome', ['at', (d) => d.at ?? d.timestamp ?? d.createdAt]], 'No governance decisions.'),
  'audit-verify': {
    usage: 'audit-verify [--json]', args: 0,
    run: async (ctx) => {
      const body = (await requestJson(ctx, `${BASE}/audit-chain/verify`)).body;
      if (ctx.json) { writeJson(ctx.io.stdout, body); return body?.valid === false || body?.ok === false ? 1 : 0; }
      const ok = body?.valid ?? body?.ok;
      writeLine(ctx.io.stdout, `audit chain: ${ok === false ? 'BROKEN' : 'intact'} (length ${body?.length ?? 0})`);
      if (ok === false && body?.brokenAt !== undefined) writeLine(ctx.io.stdout, `brokenAt: ${body.brokenAt}`);
      return ok === false ? 1 : 0;
    },
  },
};

const SCHEMAS: Record<string, Cmd> = {
  list: {
    usage: 'list [--json]', args: 0,
    run: async (ctx) => listOut(ctx, (await requestJson(ctx, `${BASE}/event-schemas`)).body, 'schemas',
      ['eventType', 'version', ['updatedAt', (s) => s.updatedAt ?? s.registeredAt ?? s.createdAt]], 'No event schemas registered.'),
  },
  register: {
    usage: "register --event-type <t> (--schema-json '{...}' | --schema-file <f>) [--json]", args: 0, body: true,
    value: ['--event-type', '--schema-json', '--schema-file'], requires: ['eventType'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, {
        eventType: a.options.eventType,
        schema: jsonFrom(ctx, a.options.schemaJson, a.options.schemaFile, '--schema-json', '--schema-file'),
      });
      if (req.schema === undefined) { writeLine(ctx.io.stderr, 'openwop: missing --schema-json or --schema-file'); return 2; }
      const body = (await requestJson(ctx, `${BASE}/event-schemas`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Registered the ${req.eventType} event schema${body?.version !== undefined ? ` (version ${body.version})` : ''}.`);
    },
  },
  validate: {
    usage: "validate <eventType> (--payload-json '{...}' | --payload-file <f>) [--json]", args: 1, body: true,
    value: ['--payload-json', '--payload-file'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, { payload: jsonFrom(ctx, a.options.payloadJson, a.options.payloadFile, '--payload-json', '--payload-file') });
      let body: any;
      try {
        body = (await requestJson(ctx, `${BASE}/event-schemas/${enc(a.positionals[0])}/validate`, { method: 'POST', body: req })).body;
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 422) throw err;
        body = err.body;
      }
      const valid = body?.valid === true;
      if (ctx.json) { writeJson(ctx.io.stdout, body); return valid ? 0 : 1; }
      writeLine(ctx.io.stdout, valid ? 'valid' : 'invalid');
      for (const e of Array.isArray(body?.errors) ? body.errors : []) {
        writeLine(ctx.io.stdout, `  - ${typeof e === 'string' ? e : `${e.path ?? e.instancePath ?? ''} ${e.message ?? JSON.stringify(e)}`.trim()}`);
      }
      return valid ? 0 : 1;
    },
  },
};

export async function runCdp(ctx: Ctx, argv: string[]) {
  if (argv[0] === 'schemas') return dispatchTable(ctx, 'cdp schemas', CDP_HELP, SCHEMAS, argv.slice(1), 'list');
  return dispatchTable(ctx, 'cdp', CDP_HELP, TABLE, argv, '--help');
}

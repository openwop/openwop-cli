import type { Ctx } from '../context.js';
/**
 * `openwop destination-sync ...` — reverse-ETL destination syncs (ADR 0266;
 * entitlement gate ADR 0419).
 *
 * Surface: /v1/host/openwop-app/destination-sync/syncs[/{id}[/dry-run|prepare|advance]]
 * (toggle `destination-sync`, tenant-scoped).
 */
import { requestJson } from '../api.js';
import { writeLine } from '../io.js';
import {
  APP, enc, dispatchTable, listOut, detail, done, assign, parseJsonFlag, readText, type Cmd,
} from './marketingShared.js';

const BASE = `${APP}/destination-sync/syncs`;

export const DESTINATION_SYNC_HELP = `Usage:
  openwop destination-sync list [--json]
  openwop destination-sync get <syncId> [--json]
  openwop destination-sync create --name <n> [--destination-kind <k>] [--source-object <o>] [--field-map-json '[...]']
                                  [--sync-mode <m>] [--cursor-field <f>] [--connection <id>] [--body <json>|--body-file <f>] [--json]
  openwop destination-sync update <syncId> [--name <n>] [--field-map-json '[...]'] [--sync-mode <m>] [--cursor-field <f>] [--body <json>] [--json]
  openwop destination-sync delete <syncId> --yes
  openwop destination-sync dry-run <syncId> (--sample-json '{...}' | --sample-file <f>) [--json]
  openwop destination-sync prepare <syncId> (--records-json '[...]' | --records-file <f>) [--json]
  openwop destination-sync advance <syncId> --cursor <c> [--json]

Reverse-ETL destination syncs (ADR 0266) under
/v1/host/openwop-app/destination-sync/syncs. A sync maps a source object (default
'contact') onto a destination (default 'webhook'; warehouse kinds take --body
fields such as project/dataset/table/warehouseKeyField) through a field map.
  dry-run   POST …/{id}/dry-run — apply the field map to one sample record.
  prepare   POST …/{id}/prepare — build the outgoing batch for a set of records.
  advance   POST …/{id}/advance — move the incremental cursor after a delivery.
'update' is a partial PATCH (name, fieldMap, syncMode, cursorField only).

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown sync); 4 auth/permission
denied; 1 server error.

Examples:
  openwop destination-sync create --name "Contacts to webhook" --field-map-json '[{"from":"email","to":"email"}]'
  openwop destination-sync dry-run ds_1 --sample-json '{"email":"a@b.co"}'
  openwop destination-sync advance ds_1 --cursor 2026-09-01T00:00:00Z
`;

function jsonFrom(ctx: Ctx, inline: unknown, file: unknown, inlineFlag: string, fileFlag: string): unknown {
  if (inline !== undefined) return parseJsonFlag(String(inline), inlineFlag);
  if (file !== undefined) return parseJsonFlag(readText(ctx, String(file), fileFlag), fileFlag);
  return undefined;
}

const item = (id: string) => `${BASE}/${enc(id)}`;

const TABLE: Record<string, Cmd> = {
  list: {
    usage: 'list [--json]', args: 0,
    run: async (ctx) => listOut(ctx, (await requestJson(ctx, BASE)).body, 'syncs',
      [['id', (s) => s.id ?? s.syncId], 'name', 'destinationKind', 'sourceObject', 'syncMode', 'cursor'], 'No destination syncs.'),
  },
  get: {
    usage: 'get <syncId> [--json]', args: 1,
    run: async (ctx, a) => detail(ctx, (await requestJson(ctx, item(a.positionals[0]))).body),
  },
  create: {
    usage: "create --name <n> [--destination-kind <k>] [--source-object <o>] [--field-map-json '[...]'] [--sync-mode <m>] [--cursor-field <f>] [--connection <id>] [--body <json>|--body-file <f>] [--json]",
    args: 0, body: true, value: ['--name', '--destination-kind', '--source-object', '--field-map-json', '--sync-mode', '--cursor-field', '--connection'],
    requires: ['name'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        name: o.name, destinationKind: o.destinationKind, sourceObject: o.sourceObject,
        fieldMap: o.fieldMapJson !== undefined ? parseJsonFlag(o.fieldMapJson, '--field-map-json') : undefined,
        syncMode: o.syncMode, cursorField: o.cursorField, connectionId: o.connection,
      });
      const body = (await requestJson(ctx, BASE, { method: 'POST', body: req })).body;
      return done(ctx, body, `Created destination sync ${body?.id ?? body?.syncId ?? ''} (${req.name}).`);
    },
  },
  update: {
    usage: "update <syncId> [--name <n>] [--field-map-json '[...]'] [--sync-mode <m>] [--cursor-field <f>] [--body <json>] [--json]",
    args: 1, body: true, value: ['--name', '--field-map-json', '--sync-mode', '--cursor-field'],
    run: async (ctx, a) => {
      const o = a.options;
      const req = assign({ ...a.body }, {
        name: o.name,
        fieldMap: o.fieldMapJson !== undefined ? parseJsonFlag(o.fieldMapJson, '--field-map-json') : undefined,
        syncMode: o.syncMode, cursorField: o.cursorField,
      });
      if (Object.keys(req).length === 0) { writeLine(ctx.io.stderr, 'openwop: nothing to update — pass at least one field.'); return 2; }
      const body = (await requestJson(ctx, item(a.positionals[0]), { method: 'PATCH', body: req })).body;
      return done(ctx, body, `Updated destination sync ${a.positionals[0]}.`);
    },
  },
  delete: {
    usage: 'delete <syncId> --yes', args: 1, confirm: 'delete the destination sync',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, item(a.positionals[0]), { method: 'DELETE' })).body ?? { deleted: true },
      `Deleted destination sync ${a.positionals[0]}.`),
  },
  'dry-run': {
    usage: "dry-run <syncId> (--sample-json '{...}' | --sample-file <f>) [--json]", args: 1, body: true, value: ['--sample-json', '--sample-file'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, { sample: jsonFrom(ctx, a.options.sampleJson, a.options.sampleFile, '--sample-json', '--sample-file') });
      if (req.sample === undefined) { writeLine(ctx.io.stderr, 'openwop: missing --sample-json or --sample-file'); return 2; }
      return detail(ctx, (await requestJson(ctx, `${item(a.positionals[0])}/dry-run`, { method: 'POST', body: req })).body, 'mapped');
    },
  },
  prepare: {
    usage: "prepare <syncId> (--records-json '[...]' | --records-file <f>) [--json]", args: 1, body: true, value: ['--records-json', '--records-file'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, { records: jsonFrom(ctx, a.options.recordsJson, a.options.recordsFile, '--records-json', '--records-file') });
      if (req.records === undefined) { writeLine(ctx.io.stderr, 'openwop: missing --records-json or --records-file'); return 2; }
      return detail(ctx, (await requestJson(ctx, `${item(a.positionals[0])}/prepare`, { method: 'POST', body: req })).body);
    },
  },
  advance: {
    usage: 'advance <syncId> --cursor <c> [--json]', args: 1, body: true, value: ['--cursor'], requires: ['cursor'],
    run: async (ctx, a) => {
      const req = assign({ ...a.body }, { cursor: a.options.cursor });
      const body = (await requestJson(ctx, `${item(a.positionals[0])}/advance`, { method: 'POST', body: req })).body;
      return done(ctx, body, `Advanced the cursor of ${a.positionals[0]} to ${body?.cursor ?? req.cursor}.`);
    },
  },
};

export async function runDestinationSync(ctx: Ctx, argv: string[]) {
  return dispatchTable(ctx, 'destination-sync', DESTINATION_SYNC_HELP, TABLE, argv, 'list');
}

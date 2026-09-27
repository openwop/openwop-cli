import type { Ctx } from '../context.js';
/**
 * `openwop ui-state ...` — your per-resource saved UI state (ADR 0071).
 *
 * Hits `/v1/host/openwop-app/ui-state` (host-extension, non-normative). Rows are
 * keyed by the AUTHENTICATED caller server-side — you only ever read/write your
 * own. Non-authoritative display preferences (selected revision, expanded
 * panels, dismissed notices), never product state.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, parseJsonFlag, renderDone, renderList, withQuery } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/ui-state';

export const UI_STATE_HELP = `Usage:
  openwop ui-state list [--resource-type <t>] [--resource-id <id>] [--json]
  openwop ui-state get <resourceType> <resourceId> <key> [--json]
  openwop ui-state set <resourceType> <resourceId> <key> --value <json> [--json]
  openwop ui-state delete <resourceType> <resourceId> <key>

\`list\` reads your rows (GET ${BASE}?resourceType=&resourceId=); \`get\` filters one
key from that list. \`set\` writes one key (PUT ${BASE}, body { resourceType,
resourceId, key, value }); --value is parsed as JSON, falling back to a string.
\`delete\` removes one key (DELETE ${BASE}/<type>/<id>/<key>).

Exit codes: 0 ok · 2 usage / not found · 4 forbidden.

Examples:
  openwop ui-state list --resource-type artifact
  openwop ui-state set artifact a1 compareMode --value true
  openwop ui-state delete artifact a1 compareMode
`;

export async function runUiState(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, UI_STATE_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--resource-type', '--resource-id', '--value'] });
  if (options.help) { write(ctx.io.stdout, UI_STATE_HELP); return 0; }
  const [resourceType, resourceId, key] = positionals;
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, withQuery(BASE, { resourceType: options.resourceType, resourceId: options.resourceId }));
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      return renderList(ctx, res.body, items, ['resourceType', 'resourceId', 'key', 'value'], 'No saved UI state.');
    }
    case 'get': {
      if (!resourceType || !resourceId || !key) { write(ctx.io.stderr, 'Usage: openwop ui-state get <resourceType> <resourceId> <key>\n'); return 2; }
      const res = await requestJson(ctx, withQuery(BASE, { resourceType, resourceId }));
      const items: any[] = Array.isArray(res.body?.items) ? res.body.items : [];
      const hit = items.find((i) => i?.key === key);
      if (!hit) throw new CliError(`No ui-state for ${resourceType}/${resourceId}/${key}.`, 2);
      if (ctx.json) writeJson(ctx.io.stdout, hit); else writeLine(ctx.io.stdout, JSON.stringify(hit.value));
      return 0;
    }
    case 'set': {
      if (!resourceType || !resourceId || !key || options.value === undefined) {
        write(ctx.io.stderr, 'Usage: openwop ui-state set <resourceType> <resourceId> <key> --value <json>\n'); return 2;
      }
      let value: unknown;
      try { value = parseJsonFlag('--value', options.value); } catch { value = String(options.value); }
      const res = await requestJson(ctx, BASE, { method: 'PUT', body: { resourceType, resourceId, key, value } });
      return renderDone(ctx, res.body, `Saved ${resourceType}/${resourceId}/${key}.`);
    }
    case 'delete': {
      if (!resourceType || !resourceId || !key) { write(ctx.io.stderr, 'Usage: openwop ui-state delete <resourceType> <resourceId> <key>\n'); return 2; }
      await requestJson(ctx, `${BASE}/${enc(resourceType)}/${enc(resourceId)}/${enc(key)}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted ${resourceType}/${resourceId}/${key}.`);
      return 0;
    }
    default: throw new CliError(`Unknown ui-state command: ${sub}\nRun \`openwop ui-state --help\` for usage.`);
  }
}

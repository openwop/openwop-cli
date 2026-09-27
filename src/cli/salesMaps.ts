import type { Ctx } from '../context.js';
/**
 * `openwop sales-maps ...` — dynamic sales maps (openwop-app ADR 0282).
 * Host-extension route `POST /v1/host/openwop-app/sales-maps/orgs/:orgId/geocode`
 * (toggle `sales-maps`, workspace:write — a genuine cache miss spends a BYOK
 * geocoding provider call on the host). Manual --lat/--lng and cache hits need no
 * provider. The host resolves + caches; the CLI relays its answer.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

export const SALES_MAPS_SPECS: CommandSpec[] = [
  { cmd: ['geocode'], method: 'POST', route: '/v1/host/openwop-app/sales-maps/orgs/:org/geocode', summary: 'Resolve (and cache) an address to a map point.', body: ['address', 'lat:number', 'lng:number'] },
];

export const SALES_MAPS_HELP = buildGroupHelp('sales-maps', `
Sales maps (host-extension /v1/host/openwop-app/sales-maps/…, org-scoped).
\`geocode\` returns {address, lat, lng, source}: pass --address to resolve it
(may spend a provider call on the server), or --lat/--lng to pin a point by hand.
`, SALES_MAPS_SPECS, `Examples:
  openwop sales-maps geocode --org org_1 --address "1 Main St, Springfield"
  openwop sales-maps geocode --org org_1 --address "Warehouse 4" --lat 40.71 --lng=-74.0`);

export async function runSalesMaps(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'sales-maps', SALES_MAPS_HELP, SALES_MAPS_SPECS, argv);
}

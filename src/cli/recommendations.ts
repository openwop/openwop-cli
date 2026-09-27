import type { Ctx } from '../context.js';
/**
 * `openwop recommendations ...` — product-recommendation placements (openwop-app
 * ADR 0273, MERCH-A). Host-extension routes under
 * `/v1/host/openwop-app/recommendations/orgs/:orgId` (toggle `recommendations`;
 * read = workspace:read, write = workspace:write) plus the PUBLIC storefront
 * resolve `/v1/host/openwop-app/public-recommendations/:orgId/resolve` (no auth,
 * no contactId — segment targeting is inert on the public route by design).
 * The host ranks + filters; the CLI renders its resolved products verbatim.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const B = '/v1/host/openwop-app/recommendations/orgs/:org';

export const RECOMMENDATIONS_SPECS: CommandSpec[] = [
  { cmd: ['placements', 'list'], method: 'GET', route: `${B}/placements`, summary: 'List recommendation placements.', list: { key: 'placements', columns: ['placementId', 'slot', 'source', 'segmentId', 'holdoutPct', 'active'], empty: 'No placements.' } },
  { cmd: ['placements', 'create'], method: 'POST', route: `${B}/placements`, summary: 'Create a placement.', body: ['slot!', 'source!', 'segmentId', 'holdoutPct:number', 'active:bool'] },
  { cmd: ['placements', 'update'], method: 'PATCH', route: `${B}/placements/:placementId`, summary: 'Patch a placement.', body: ['source', 'segmentId', 'holdoutPct:number', 'active:bool'] },
  { cmd: ['placements', 'delete'], method: 'DELETE', route: `${B}/placements/:placementId`, summary: 'Delete a placement.', confirm: true },
  { cmd: ['affinity-rebuild'], method: 'POST', route: `${B}/affinity/rebuild`, summary: 'Rebuild the bought-together affinity table from orders.' },
  { cmd: ['resolve'], method: 'GET', route: `${B}/resolve`, summary: 'Preview the resolved recommendations for a slot (operator view).', query: ['slot!', 'productId', 'contactId', 'sessionKey', 'limit:number'], list: { key: 'products', columns: ['productId', 'name', 'price', 'currency'], empty: 'No recommendations.' } },
  { cmd: ['public', 'resolve'], method: 'GET', route: '/v1/host/openwop-app/public-recommendations/:org/resolve', auth: false, summary: 'Resolve recommendations as an anonymous storefront visitor.', query: ['slot!', 'productId', 'sessionKey', 'limit:number'], list: { key: 'products', columns: ['productId', 'name', 'price', 'currency'], empty: 'No recommendations.' } },
];

export const RECOMMENDATIONS_HELP = buildGroupHelp('recommendations', `
Product recommendations (host-extension /v1/host/openwop-app/recommendations/…,
org-scoped). --slot is pdp | cart | checkout | post_purchase | category | home |
oos_404; --source is bought_together | cross_sell | upsell | similar | trending;
--holdout-pct is the A/B holdout percentage. \`resolve\` previews what a slot
shows (optionally as --contact-id); \`public resolve\` hits the anonymous
storefront route and never sends credentials. Prices are the host's own values.
`, RECOMMENDATIONS_SPECS, `Examples:
  openwop recommendations placements list --org org_1
  openwop recommendations placements create --org org_1 --slot pdp --source bought_together --holdout-pct 10
  openwop recommendations resolve --org org_1 --slot pdp --product-id prod_1 --limit 4
  openwop recommendations public resolve --org org_1 --slot home`);

export async function runRecommendations(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'recommendations', RECOMMENDATIONS_HELP, RECOMMENDATIONS_SPECS, argv);
}

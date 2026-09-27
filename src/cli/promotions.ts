import type { Ctx } from '../context.js';
/**
 * `openwop promotions ...` — commerce promotions (openwop-app ADR 0274, MERCH-B:
 * cart-threshold / product-discount / loss-leader / tiered / BOGO promotions).
 * Host-extension routes under `/v1/host/openwop-app/promotions/orgs/:orgId`
 * (toggle `promotions`; read = workspace:read, write = workspace:write).
 * Promotion EVALUATION happens host-side on the commerce order path — the CLI
 * only manages the promotion rows and renders the host's usage counters.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const B = '/v1/host/openwop-app/promotions/orgs/:org/promotions';
const FIELDS = [
  'name', 'reward:json', 'scope:json', 'minSpend:number', 'priority:number', 'stackable:bool',
  'active:bool', 'segmentId', 'budget:json', 'schedule:json', 'currency',
];

export const PROMOTIONS_SPECS: CommandSpec[] = [
  { cmd: ['list'], method: 'GET', route: B, summary: 'List promotions (+ per-promotion usage).', list: { key: 'promotions', columns: ['promotionId', 'name', 'type', 'active', 'priority'], empty: 'No promotions.' } },
  { cmd: ['get'], method: 'GET', route: `${B}/:promotionId`, summary: 'Get one promotion.' },
  { cmd: ['create'], method: 'POST', route: B, summary: 'Create a promotion.', body: ['name!', 'type!', ...FIELDS.slice(1), 'minQuantity:number', 'bogo:json'] },
  { cmd: ['update'], method: 'PATCH', route: `${B}/:promotionId`, summary: 'Patch a promotion.', body: FIELDS },
  { cmd: ['delete'], method: 'DELETE', route: `${B}/:promotionId`, summary: 'Delete a promotion.', confirm: true },
];

export const PROMOTIONS_HELP = buildGroupHelp('promotions', `
Commerce promotions (host-extension /v1/host/openwop-app/promotions/…, org-scoped).
--type is one of cart_threshold | product_discount | loss_leader | tiered | bogo.
--reward is {"kind":"percentage"|"fixed","value":n}; --scope is
{"productIds":[…],"categories":[…],"all":true}; --bogo is {"buy":n,"get":m};
--budget is {"maxDiscount":n,"maxQuantity":n}. The host validates every rule
(a loss_leader needs budget.maxDiscount, a tiered one needs --min-quantity).
`, PROMOTIONS_SPECS, `Examples:
  openwop promotions list --org org_1
  openwop promotions create --org org_1 --name "Spend 50 save 10%" --type cart_threshold --min-spend 50 --reward '{"kind":"percentage","value":10}'
  openwop promotions update promo_1 --org org_1 --active false
  openwop promotions delete promo_1 --org org_1 --yes`);

export async function runPromotions(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'promotions', PROMOTIONS_HELP, PROMOTIONS_SPECS, argv);
}

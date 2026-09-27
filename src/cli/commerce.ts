import type { Ctx } from '../context.js';
/**
 * `openwop commerce ...` — the e-commerce surface (openwop-app ADR 0177 + its
 * follow-ons: ADR 0238 partial refunds, ADR 0257 typed product fields, ADR 0279
 * product subscriptions, ADR 0296 order bumps / one-click upsell, ADR 0297
 * affiliate payouts). Operator routes live under
 * `/v1/host/openwop-app/commerce/orgs/:orgId` (toggle `commerce`,
 * authorizeOrgScope: read = workspace:read, write = workspace:write); the
 * anonymous storefront lives under `/v1/host/openwop-app/public-store/:orgId`
 * and is driven here as the `commerce public …` family (sent WITHOUT the bearer).
 *
 * Money posture: the host resolves every price, total, tax, discount and charge;
 * the CLI relays amounts verbatim in the units the host names (commerce catalog
 * `price` / partial-refund `amount` are decimal amounts in the order currency)
 * and never computes one. Payment capture happens on the host's Stripe Checkout
 * page — no card datum is ever handled here. The UCP agent-commerce families are
 * declared in commerceUcp.ts and concatenated below.
 */
import { COMMERCE_UCP_SPECS, COMMERCE_UCP_INTRO, runCommerceUcpCustom } from './commerceUcp.js';
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const O = '/v1/host/openwop-app/commerce/orgs/:org';
const P = '/v1/host/openwop-app/public-store/:orgId';

const PRODUCT_FIELDS = [
  'type', 'description', 'price:number', 'currency', 'imageAssetTokens:json', 'downloadAssetTokens:json',
  'inventory:number', 'lowStockThreshold:number', 'variants:json', 'categories:json', 'tags:json',
  'attributes:json', 'weightGrams:number', 'dims:json', 'customFields:json', 'cost:number', 'kind',
  'components:json', 'subscription:json',
];
const PRICE_LIST_FIELDS = ['currency', 'entries:json', 'contactIds:json', 'companyIds:json', 'priority:number', 'exclusiveAssortment:bool'];

const COMMERCE_CORE_SPECS: CommandSpec[] = [
  // ── Products ──
  { cmd: ['products', 'list'], method: 'GET', route: `${O}/products`, summary: 'List catalog products.', query: ['q'], list: { key: 'products', columns: ['productId', 'name', 'type', 'price', 'currency', 'inventory', 'active'], empty: 'No products.' } },
  { cmd: ['products', 'get'], method: 'GET', route: `${O}/products/:productId`, summary: 'Get one product.' },
  { cmd: ['products', 'create'], method: 'POST', route: `${O}/products`, summary: 'Create a product.', body: ['name!', ...PRODUCT_FIELDS] },
  { cmd: ['products', 'update'], method: 'PATCH', route: `${O}/products/:productId`, summary: 'Patch a product.', body: ['name', ...PRODUCT_FIELDS, 'active:bool'] },
  { cmd: ['products', 'delete'], method: 'DELETE', route: `${O}/products/:productId`, summary: 'Delete a product.', confirm: true },
  { cmd: ['products', 'movements'], method: 'GET', route: `${O}/products/:productId/movements`, summary: 'List a product\'s stock-movement ledger.', list: { key: 'movements', columns: ['movementId', 'delta', 'inventoryAfter', 'reason', 'orderId', 'at'], empty: 'No stock movements.' } },

  // ── Typed product custom fields (ADR 0257) ──
  { cmd: ['product-fields', 'list'], method: 'GET', route: `${O}/product-fields`, summary: 'List product custom-field definitions.', list: { key: 'fields', columns: ['defId', 'key', 'label', 'type', 'required'], empty: 'No product fields.' } },
  { cmd: ['product-fields', 'create'], method: 'POST', route: `${O}/product-fields`, summary: 'Create a product custom-field definition.', body: ['key!', 'label!', 'type!', 'required:bool', 'options:json'] },
  { cmd: ['product-fields', 'delete'], method: 'DELETE', route: `${O}/product-fields/:defId`, summary: 'Delete a product custom-field definition.', confirm: true },

  // ── Orders ──
  { cmd: ['orders', 'list'], method: 'GET', route: `${O}/orders`, summary: 'List orders.', query: ['status'], list: { key: 'orders', columns: ['orderId', 'status', 'fulfillmentStatus', 'total', 'currency', 'contactId', 'createdAt'], empty: 'No orders.' } },
  { cmd: ['orders', 'get'], method: 'GET', route: `${O}/orders/:orderId`, summary: 'Get one order.' },
  { cmd: ['orders', 'create'], method: 'POST', route: `${O}/orders`, summary: 'Create a pending order.', body: ['lines:json!', 'contactId', 'couponCode', 'affiliateCode', 'shippingAddress:json', 'idempotencyKey'] },
  { cmd: ['orders', 'pay'], method: 'POST', route: `${O}/orders/:orderId/pay`, summary: 'Mark an order paid against a payment intent (verified with Stripe when configured).', body: ['paymentIntentId!'] },
  { cmd: ['orders', 'refund'], method: 'POST', route: `${O}/orders/:orderId/refund`, summary: 'Fully refund an order.', confirm: true },
  { cmd: ['orders', 'partial-refund'], method: 'POST', route: `${O}/orders/:orderId/partial-refund`, summary: 'Partially refund an order (repeat-safe via --refund-key).', body: ['amount:number!', 'refundKey!'], confirm: true },
  { cmd: ['orders', 'refunds'], method: 'GET', route: `${O}/orders/:orderId/refunds`, summary: 'List an order\'s partial-refund ledger.', list: { key: 'refunds', columns: ['refundLedgerId', 'amount', 'currency', 'refundKey', 'provider', 'createdAt'], empty: 'No partial refunds.' } },
  { cmd: ['orders', 'cancel'], method: 'POST', route: `${O}/orders/:orderId/cancel`, summary: 'Cancel an order (releases reserved stock).', confirm: true },
  { cmd: ['orders', 'fulfillment'], method: 'POST', route: `${O}/orders/:orderId/fulfillment`, summary: 'Set an order\'s fulfillment status.', body: ['fulfillmentStatus!'] },

  // ── Cart (one per user + org) ──
  { cmd: ['cart', 'get'], method: 'GET', route: `${O}/cart`, summary: 'Show your cart.' },
  { cmd: ['cart', 'set-item'], method: 'PUT', route: `${O}/cart/items/:productId`, summary: 'Set a cart line\'s quantity (0 removes it).', body: ['quantity:number'] },
  { cmd: ['cart', 'clear'], method: 'DELETE', route: `${O}/cart`, summary: 'Clear your cart.', confirm: true },
  { cmd: ['cart', 'checkout'], method: 'POST', route: `${O}/cart/checkout`, summary: 'Turn your cart into a pending order.', body: ['contactId', 'couponCode', 'idempotencyKey'] },

  // ── Price lists + explainable price resolution ──
  { cmd: ['price-lists', 'list'], method: 'GET', route: `${O}/price-lists`, summary: 'List price lists.', list: { key: 'priceLists', columns: ['priceListId', 'name', 'currency', 'priority', 'active'], empty: 'No price lists.' } },
  { cmd: ['price-lists', 'create'], method: 'POST', route: `${O}/price-lists`, summary: 'Create a price list.', body: ['name!', ...PRICE_LIST_FIELDS] },
  { cmd: ['price-lists', 'update'], method: 'PATCH', route: `${O}/price-lists/:priceListId`, summary: 'Patch a price list.', body: ['name', ...PRICE_LIST_FIELDS, 'active:bool'] },
  { cmd: ['price-lists', 'delete'], method: 'DELETE', route: `${O}/price-lists/:priceListId`, summary: 'Delete a price list.', confirm: true },
  { cmd: ['price', 'get'], method: 'GET', route: `${O}/price`, summary: 'Preview the resolved price + sellability for a product and buyer.', query: ['productId!', 'variantId', 'contactId', 'companyId'] },

  // ── Quotes ──
  { cmd: ['quotes', 'list'], method: 'GET', route: `${O}/quotes`, summary: 'List quotes.', query: ['status'], list: { key: 'quotes', columns: ['quoteId', 'status', 'version', 'total', 'currency', 'contactId', 'expiresAt'], empty: 'No quotes.' } },
  { cmd: ['quotes', 'get'], method: 'GET', route: `${O}/quotes/:quoteId`, summary: 'Get one quote.' },
  { cmd: ['quotes', 'create'], method: 'POST', route: `${O}/quotes`, summary: 'Create a draft quote.', body: ['lines:json!', 'contactId', 'companyId', 'dealId', 'note', 'expiresInDays:number'] },
  { cmd: ['quotes', 'revise'], method: 'PATCH', route: `${O}/quotes/:quoteId`, summary: 'Revise a quote (records a revision).', body: ['lines:json', 'note', 'expiresInDays:number'] },
  { cmd: ['quotes', 'revisions'], method: 'GET', route: `${O}/quotes/:quoteId/revisions`, summary: 'List a quote\'s revisions.', list: { key: 'revisions', columns: ['revisionId', 'version', 'actor', 'at'], empty: 'No revisions.' } },
  { cmd: ['quotes', 'send'], method: 'POST', route: `${O}/quotes/:quoteId/send`, summary: 'Send a quote to the buyer.' },
  { cmd: ['quotes', 'decline'], method: 'POST', route: `${O}/quotes/:quoteId/decline`, summary: 'Mark a quote declined.' },
  { cmd: ['quotes', 'accept'], method: 'POST', route: `${O}/quotes/:quoteId/accept`, summary: 'Accept a quote on the buyer\'s behalf (converts it to an order).' },

  // ── Coupons ──
  { cmd: ['coupons', 'list'], method: 'GET', route: `${O}/coupons`, summary: 'List coupons.', list: { key: 'coupons', columns: ['couponId', 'code', 'type', 'value', 'currency', 'active'], empty: 'No coupons.' } },
  { cmd: ['coupons', 'create'], method: 'POST', route: `${O}/coupons`, summary: 'Create a coupon.', body: ['code!', 'type', 'value:number', 'currency'] },

  // ── Product subscriptions (ADR 0279) ──
  { cmd: ['subscriptions', 'list'], method: 'GET', route: `${O}/subscriptions`, summary: 'List product subscriptions.', list: { key: 'subscriptions', columns: ['subscriptionId', 'productId', 'interval', 'unitPrice', 'currency', 'status', 'paymentMode'], empty: 'No subscriptions.' } },
  { cmd: ['subscriptions', 'create'], method: 'POST', route: `${O}/subscriptions`, summary: 'Subscribe a buyer to a product.', body: ['productId!', 'interval!', 'contactId', 'idempotencyKey'] },
  { cmd: ['subscriptions', 'cycle'], method: 'POST', route: `${O}/subscriptions/:subscriptionId/cycle`, summary: 'Run one billing cycle now (creates the cycle order).' },
  { cmd: ['subscriptions', 'cancel'], method: 'DELETE', route: `${O}/subscriptions/:subscriptionId`, summary: 'Cancel a subscription.', confirm: true },

  // ── Affiliates + payouts (advisory ledger; no money movement) ──
  { cmd: ['affiliates', 'list'], method: 'GET', route: `${O}/affiliates`, summary: 'List affiliates.', list: { key: 'affiliates', columns: ['affiliateId', 'code', 'name', 'commissionType', 'commissionRate', 'currency'], empty: 'No affiliates.' } },
  { cmd: ['affiliates', 'create'], method: 'POST', route: `${O}/affiliates`, summary: 'Create an affiliate.', body: ['code!', 'name', 'commissionType!', 'commissionRate:number!', 'currency'] },
  { cmd: ['affiliates', 'payout'], method: 'POST', route: `${O}/affiliates/:affiliateId/payout`, summary: 'Record a payout of an affiliate\'s owed balance (ledger only).' },
  { cmd: ['affiliates', 'payouts-csv'], method: 'GET', route: `${O}/affiliates/payouts.csv`, summary: 'Export the affiliate payout ledger as CSV.', text: true },
  { cmd: ['payouts', 'list'], method: 'GET', route: `${O}/payouts`, summary: 'List recorded affiliate payouts.', list: { key: 'payouts', columns: ['payoutId', 'affiliateId', 'amount', 'currency', 'status', 'createdAt'], empty: 'No payouts.' } },

  // ── Reports ──
  { cmd: ['reports', 'summary'], method: 'GET', route: `${O}/reports/summary`, summary: 'Revenue summary (the host\'s one-read dashboard).' },

  // ── Public storefront (anonymous visitor routes) ──
  { cmd: ['public', 'products'], method: 'GET', route: `${P}/products`, summary: 'Browse a store\'s published products.', query: ['q', 'category', 'tag'], auth: false, list: { key: 'products', columns: ['productId', 'name', 'type', 'price', 'currency'], empty: 'No published products.' } },
  { cmd: ['public', 'product'], method: 'GET', route: `${P}/products/:productId`, summary: 'Get one published product.', auth: false },
  { cmd: ['public', 'checkout'], method: 'POST', route: `${P}/checkout`, summary: 'Guest checkout — returns a hosted checkout URL (live) or a pending demo order.', auth: false, body: ['email!', 'lines:json!', 'name', 'couponCode', 'shippingAddress:json', 'bumps:json', 'funnel:json', 'savePaymentMethod:bool', 'ref', 'idempotencyKey'] },
  { cmd: ['public', 'one-click'], method: 'POST', route: `${P}/orders/:orderId/one-click`, summary: 'Accept a one-click post-purchase offer (when the host enables it).', auth: false, body: ['productId!', 'quantity:number', 'funnel:json'] },
  { cmd: ['public', 'accept-quote'], method: 'POST', route: `${P}/quotes/:quoteId/accept`, summary: 'Accept a shared quote with its share-link token.', auth: false, body: ['token!'] },
];

export const COMMERCE_SPECS: CommandSpec[] = [...COMMERCE_CORE_SPECS, ...COMMERCE_UCP_SPECS];

const COMMERCE_INTRO = `
E-commerce (host-extension /v1/host/openwop-app/commerce/orgs/<orgId>/…, org-scoped;
the public storefront is /v1/host/openwop-app/public-store/<orgId>/… and is
called without credentials). Products, typed product fields, orders (pay /
refund / partial-refund / cancel / fulfillment), the per-user cart, price lists
with a "view as buyer" price preview, quotes, coupons, product subscriptions,
the affiliate ledger, and the revenue summary.

--lines is a JSON array of {"productId":"…","quantity":n} (quotes may add
"unitPrice"). --fulfillment-status is pending | processing | shipped |
delivered; --status on orders list is pending | paid | fulfilled | refunding |
partially_refunded | refunded | canceled; --interval is weekly | monthly |
quarterly | yearly; --commission-type is percentage | fixed. Amounts are passed
through exactly as the host names them — the host computes every total.
--idempotency-key makes an order/checkout create repeat-safe.
`;

export const COMMERCE_HELP = buildGroupHelp('commerce', [COMMERCE_INTRO, COMMERCE_UCP_INTRO].filter(Boolean).join('\n\n'), COMMERCE_SPECS, `Examples:
  openwop commerce products list --org org_1 --q mug
  openwop commerce products create --org org_1 --name Mug --price 12.5 --currency USD --inventory 40
  openwop commerce orders create --org org_1 --lines '[{"productId":"prod_1","quantity":2}]' --idempotency-key ord-42
  openwop commerce orders fulfillment ord_1 --org org_1 --fulfillment-status shipped
  openwop commerce orders partial-refund ord_1 --org org_1 --amount 5 --refund-key adj-1 --yes
  openwop commerce price get --org org_1 --product-id prod_1 --contact-id c_1
  openwop commerce affiliates payouts-csv --org org_1 > payouts.csv
  openwop commerce public products org_1 --category mugs
  openwop commerce public checkout org_1 --email a@b.co --lines '[{"productId":"prod_1","quantity":1}]'`);

export async function runCommerce(ctx: Ctx, argv: string[]) {
  const custom = await runCommerceUcpCustom(ctx, argv);
  if (custom !== null) return custom;
  return runResourceGroup(ctx, 'commerce', COMMERCE_HELP, COMMERCE_SPECS, argv);
}

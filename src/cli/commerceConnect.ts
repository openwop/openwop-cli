import type { Ctx } from '../context.js';
/**
 * `openwop commerce-connect ...` — Stripe Connect paid pack listings
 * (openwop-app ADR 0385 "commerce-connect", plus the ADR 0575 class-3 operator
 * remediation surfaces). Host-extension routes under
 * `/v1/host/openwop-app/commerce-connect/*` (toggle `commerce-connect`).
 *
 * Seller/buyer routes are tenant-scoped (read = workspace:read, write =
 * workspace:write). The `approvals`, `admin …`, `import` and `fee-config`
 * routes are superadmin-only on the host; a non-superadmin gets HTTP 403
 * (exit 4). The CLI relays only: seller onboarding returns a Stripe-hosted
 * link which is printed for the operator to open — the CLI never accepts,
 * prints or stores card or bank details. Amounts are the host's
 * `…MajorUnits` fields, passed through exactly; nothing is computed locally.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const B = '/v1/host/openwop-app/commerce-connect';

export const COMMERCE_CONNECT_SPECS: CommandSpec[] = [
  // Seller (tenant-scoped)
  { cmd: ['seller', 'status'], method: 'GET', route: `${B}/seller`, summary: "Show this workspace's seller account state (null when not onboarded)." },
  { cmd: ['seller', 'onboard'], method: 'POST', route: `${B}/seller/onboard`, summary: 'Start or resume Stripe Connect onboarding; returns a Stripe-hosted link to open.', body: ['country'] },
  { cmd: ['seller', 'sync'], method: 'POST', route: `${B}/seller/sync`, summary: 'Re-read the live seller account state from Stripe.' },
  { cmd: ['seller', 'stats'], method: 'GET', route: `${B}/seller/stats`, summary: 'Seller sales stats.' },
  { cmd: ['seller', 'listings'], method: 'GET', route: `${B}/seller/listings`, summary: "List this workspace's own listings (incl. approval state).", list: { key: 'listings', columns: ['packName', 'lane', 'priceMajorUnits', 'currency', 'approvalState'], empty: 'No listings.' } },
  // Listings
  { cmd: ['listings', 'list'], method: 'GET', route: `${B}/listings`, summary: 'Browse paid listings.', list: { key: 'listings', columns: ['packName', 'lane', 'priceMajorUnits', 'currency', 'approvalState', 'packMissing'], empty: 'No listings.' } },
  { cmd: ['listings', 'set'], method: 'PUT', route: `${B}/listings/:packName`, summary: 'Create or update your listing for a pack.', body: ['lane!', 'priceMajorUnits:number', 'currency', 'externalPaymentUrl'] },
  { cmd: ['listings', 'delete'], method: 'DELETE', route: `${B}/listings/:packName`, summary: 'Release your own listing for a pack.', confirm: true },
  // Purchase + orders + payouts
  { cmd: ['purchase', 'checkout'], method: 'POST', route: `${B}/purchase/checkout`, summary: 'Start a purchase of a native-paid listing; returns a Stripe-hosted checkout link.', body: ['packName!'] },
  { cmd: ['orders', 'list'], method: 'GET', route: `${B}/orders`, summary: 'List your purchases and sales ({purchases, sales}).' },
  { cmd: ['orders', 'get'], method: 'GET', route: `${B}/orders/:orderId`, summary: 'Get one order.' },
  { cmd: ['payouts', 'list'], method: 'GET', route: `${B}/payouts`, summary: 'List seller payouts.', list: { key: 'payouts', columns: ['payoutId', 'amountMajorUnits', 'currency', 'status', 'arrivalDate'], empty: 'No payouts.' } },
  // Operator (superadmin)
  { cmd: ['approvals', 'list'], method: 'GET', route: `${B}/approvals`, summary: 'Superadmin: list pending listing approvals.', list: { key: 'pending', columns: ['approvalId', 'packName', 'lane', 'priceMajorUnits', 'currency', 'sellerTenantId', 'packMissing'], empty: 'No pending approvals.' } },
  { cmd: ['approvals', 'decide'], method: 'POST', route: `${B}/approvals/:approvalId`, summary: 'Superadmin: approve or reject a listing (a rejection needs --reason).', body: ['decision!', 'reason'] },
  { cmd: ['admin', 'orders'], method: 'GET', route: `${B}/admin/orders`, summary: 'Superadmin: recent orders across sellers.', list: { key: 'orders', columns: ['orderId', 'packName', 'amountMajorUnits', 'currency', 'status', 'sellerTenantId'], empty: 'No orders.' } },
  { cmd: ['admin', 'refund'], method: 'POST', route: `${B}/admin/orders/:orderId/refund`, summary: 'Superadmin: refund an order.', confirm: true },
  { cmd: ['admin', 'disputes'], method: 'GET', route: `${B}/admin/disputes`, summary: 'Superadmin: disputes + platform loss by currency.', list: { key: 'disputes', columns: ['disputeId', 'orderId', 'amountMajorUnits', 'currency', 'status', 'platformLossMajorUnits'], empty: 'No disputes.' } },
  { cmd: ['admin', 'delist'], method: 'DELETE', route: `${B}/admin/listings/:packName`, summary: 'Superadmin: dissolve a listing (tombstone + cooldown).', body: ['reason!'], confirm: true },
  { cmd: ['admin', 'listing-state'], method: 'PUT', route: `${B}/admin/listings/:packName/state`, summary: 'Superadmin: suspend or reactivate a listing.', body: ['state!', 'reason!'] },
  { cmd: ['import'], method: 'POST', route: `${B}/import`, summary: 'Superadmin: import seller account rows ({"sellers":[…]}).', body: ['sellers:json'] },
  { cmd: ['fee-config', 'get'], method: 'GET', route: `${B}/fee-config`, summary: 'Superadmin: read the application fee percent (global, or per --tenant-id).', query: ['tenantId'] },
  { cmd: ['fee-config', 'set'], method: 'PUT', route: `${B}/fee-config`, summary: 'Superadmin: set the application fee percent (global, or per --tenant-id).', body: ['applicationFeePct:number!', 'tenantId'] },
];

export const COMMERCE_CONNECT_HELP = buildGroupHelp('commerce-connect', `
Stripe Connect paid pack listings (host-extension /v1/host/openwop-app/commerce-connect/…).
Sellers onboard through a Stripe-hosted link (\`seller onboard\` prints it;
open it in a browser), then \`seller sync\` re-reads the account state. The CLI
never handles card or bank details. --lane is free | external-link |
native-paid; a native-paid listing needs onboarding first and an operator
approval before it is purchasable. \`approvals decide\` takes --decision
approved | rejected (--reason required on reject). \`admin listing-state\` takes
--state suspended | active. The approvals / admin / import / fee-config commands
are superadmin-only (HTTP 403 → exit 4 otherwise). Amounts are the host's
major-unit fields, relayed as given.
`, COMMERCE_CONNECT_SPECS, `Examples:
  openwop commerce-connect seller onboard --country US
  openwop commerce-connect listings set my.pack --lane native-paid --price-major-units 19 --currency usd
  openwop commerce-connect purchase checkout --pack-name my.pack
  openwop commerce-connect orders list --json
  openwop commerce-connect approvals decide appr_1 --decision rejected --reason "Pack is missing a README"
  openwop commerce-connect fee-config set --application-fee-pct 10`);

export async function runCommerceConnect(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'commerce-connect', COMMERCE_CONNECT_HELP, COMMERCE_CONNECT_SPECS, argv);
}

import type { Ctx } from '../context.js';
/**
 * Commerce UCP specs — the Universal Commerce Protocol surfaces of the commerce
 * feature, mounted inside `openwop commerce`:
 *
 *  - `commerce ucp …` — openwop-app ADR 0178 (UCP server). The merchant-admin
 *    client registry (`/commerce/orgs/:orgId/ucp/clients`, operator auth,
 *    toggles `commerce` + `commerce-ucp`) and the PUBLIC agent surface
 *    (`/commerce/ucp/orgs/:orgId/*`): discovery + catalog are open reads; the
 *    token mint is OAuth client_credentials; cart / checkout / order routes need a
 *    UCP bearer (the access token from `commerce ucp token`, passed as the global
 *    `--api-key`) carrying the right scope (`cart:write`, `checkout:write`,
 *    `orders:read`).
 *  - `commerce ucp-buyer …` — openwop-app ADR 0188 (outbound agentic shopping,
 *    toggle `commerce-ucp-buyer`, org-scoped operator auth). The checkout money
 *    gate (spend cap + approval) is enforced host-side; the CLI only relays.
 *
 * Money fields (`maxAmountMinor`, AP2 mandate `amount`) are passed through
 * exactly as given — the CLI never computes a charge.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import type { CommandSpec } from './resourceCommands.js';

const ADMIN = '/v1/host/openwop-app/commerce/orgs/:org/ucp';
const UCP = '/v1/host/openwop-app/commerce/ucp/orgs/:org';
const BUYER = '/v1/host/openwop-app/commerce/orgs/:org/ucp-buyer';

export const COMMERCE_UCP_SPECS: CommandSpec[] = [
  // ── merchant admin: UCP agent client registry ──
  { cmd: ['ucp', 'clients', 'list'], method: 'GET', route: `${ADMIN}/clients`, summary: 'List provisioned UCP agent clients.', list: { key: 'clients', columns: ['clientId', 'name', 'scopes', 'createdAt'], empty: 'No UCP clients.' } },
  {
    cmd: ['ucp', 'clients', 'create'], method: 'POST', route: `${ADMIN}/clients`, summary: 'Provision a UCP agent client (returns its secret ONCE).',
    body: ['name!', 'scopes:list'],
    notice: 'warning: the response contains the client secret. It is shown ONCE and never stored by the CLI — copy it to a secret store now.',
  },
  { cmd: ['ucp', 'clients', 'delete'], method: 'DELETE', route: `${ADMIN}/clients/:clientId`, summary: 'Revoke a UCP agent client.', confirm: true },

  // ── public agent surface: discovery + catalog (open) ──
  { cmd: ['ucp', 'discovery'], method: 'GET', route: `${UCP}/.well-known/ucp`, summary: 'Read the merchant UCP discovery document.', auth: false },
  { cmd: ['ucp', 'oauth-metadata'], method: 'GET', route: `${UCP}/.well-known/oauth-authorization-server`, summary: 'Read the merchant OAuth authorization-server metadata.', auth: false },
  { cmd: ['ucp', 'catalog'], method: 'GET', route: `${UCP}/catalog`, summary: 'List the merchant UCP catalog (active products).', auth: false, list: { key: 'items', columns: ['id', 'title', 'type', 'availability'], empty: 'No catalog items.' } },
  { cmd: ['ucp', 'product'], method: 'GET', route: `${UCP}/catalog/:productId`, summary: 'Read one UCP catalog item.', auth: false },

  // ── public agent surface: bearer-scoped (pass the UCP access token as --api-key) ──
  { cmd: ['ucp', 'cart', 'get'], method: 'GET', route: `${UCP}/cart`, summary: "Read the agent's cart (UCP bearer, cart:write)." },
  { cmd: ['ucp', 'cart', 'add'], method: 'POST', route: `${UCP}/cart/items`, summary: 'Set an item quantity in the cart (UCP bearer, cart:write; quantity 0 removes).', body: ['item_id!=item-id', 'quantity:number'] },
  { cmd: ['ucp', 'cart', 'clear'], method: 'DELETE', route: `${UCP}/cart`, summary: "Clear the agent's cart (UCP bearer, cart:write).", confirm: true },
  { cmd: ['ucp', 'checkout'], method: 'POST', route: `${UCP}/checkout`, summary: 'Check out the cart into an order (UCP bearer, checkout:write; may 409 approval_required).', body: ['coupon_code=coupon-code'] },
  { cmd: ['ucp', 'order', 'get'], method: 'GET', route: `${UCP}/orders/:orderId`, summary: 'Read an order (UCP bearer, orders:read).' },
  { cmd: ['ucp', 'order', 'cancel'], method: 'POST', route: `${UCP}/orders/:orderId/cancel`, summary: 'Cancel a still-pending order (UCP bearer, checkout:write).' },
  { cmd: ['ucp', 'order', 'pay'], method: 'POST', route: `${UCP}/orders/:orderId/pay`, summary: 'Pay an order with an AP2 mandate or a payment intent id (UCP bearer, checkout:write).', body: ['payment_intent_id=payment-intent-id', 'ap2_mandate:json=ap2-mandate'] },

  // ── ucp-buyer: outbound agentic shopping ──
  { cmd: ['ucp-buyer', 'discover'], method: 'POST', route: `${BUYER}/discover`, summary: "Discover a remote merchant's UCP surface.", body: ['merchantUrl', 'merchantServerId'] },
  { cmd: ['ucp-buyer', 'catalog-search'], method: 'POST', route: `${BUYER}/catalog-search`, summary: "Search a remote merchant's catalog.", body: ['merchantUrl', 'merchantServerId', 'q'] },
  { cmd: ['ucp-buyer', 'purchases', 'list'], method: 'GET', route: `${BUYER}/purchases`, summary: 'List outbound purchases.', list: { key: 'purchases', columns: ['purchaseId', 'status', 'merchantUrl', 'extOrderId', 'createdAt'], empty: 'No purchases.' } },
  { cmd: ['ucp-buyer', 'purchases', 'get'], method: 'GET', route: `${BUYER}/purchases/:purchaseId`, summary: 'Read one purchase (+ its approval status).' },
  { cmd: ['ucp-buyer', 'purchases', 'create'], method: 'POST', route: `${BUYER}/purchases`, summary: 'Draft an outbound purchase (spend cap in minor units).', body: ['merchantUrl', 'merchantServerId', 'intent', 'maxAmountMinor:number', 'currency', 'lines:json'] },
  { cmd: ['ucp-buyer', 'purchases', 'checkout'], method: 'POST', route: `${BUYER}/purchases/:purchaseId/checkout`, summary: 'Place the purchase (host enforces the money gate / approval).' },
  { cmd: ['ucp-buyer', 'purchases', 'close'], method: 'POST', route: `${BUYER}/purchases/:purchaseId/close`, summary: "Close an 'unknown' purchase with an operator-verified outcome.", body: ['outcome!', 'reason'] },
  { cmd: ['ucp-buyer', 'purchases', 'track'], method: 'POST', route: `${BUYER}/purchases/:purchaseId/track`, summary: "Refresh a purchase's status from the merchant." },
];

export const COMMERCE_UCP_INTRO = `UCP (Universal Commerce Protocol). \`commerce ucp clients …\` manages the
merchant's agent clients (operator auth). The \`commerce ucp\` agent surface is
PUBLIC: discovery/catalog need no auth; mint a token with

  openwop commerce ucp token --org <orgId> --client-id <id> --client-secret-env <VAR> [--json]
      POST ${UCP}/oauth/token — OAuth client_credentials (secret read from the env var, never a flag)

then pass the access token as the global \`--api-key\` for cart / checkout / order
commands. \`ucp order pay\` takes \`--payment-intent-id\` or \`--ap2-mandate '{"id":…,"amount":n,"currency":"USD"}'\`.
\`commerce ucp-buyer …\` is the outbound buyer surface (toggle commerce-ucp-buyer);
\`purchases close --outcome\` is not_placed | confirmed_placed.`;

const TOKEN_USAGE = `Usage: openwop commerce ucp token --org <orgId> --client-id <id> --client-secret-env <VAR> [--json]
  POST ${UCP}/oauth/token (public, client_credentials) — mint a UCP access token.
`;

/**
 * `commerce ucp token` — the client_credentials mint. Not a plain spec because the
 * client secret must come from an environment variable (never argv, never logged),
 * and the returned access token is shown once with a warning.
 * Returns null when `argv` is not this command (so the group dispatcher continues).
 */
export async function runCommerceUcpCustom(ctx: Ctx, argv: string[]): Promise<number | null> {
  if (argv[0] !== 'ucp' || argv[1] !== 'token') return null;
  const { options } = parseOptions(argv.slice(2), { bool: ['--help'], value: ['--org', '--client-id', '--client-secret-env'] });
  if (options.help) { write(ctx.io.stdout, TOKEN_USAGE); return 0; }
  if (!options.org || !options.clientId || !options.clientSecretEnv) { write(ctx.io.stderr, TOKEN_USAGE); return 2; }
  const secret = ctx.env?.[String(options.clientSecretEnv)];
  if (!secret) throw new CliError(`Environment variable ${options.clientSecretEnv} is empty or unset.`, 2);
  const path = `/v1/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(String(options.org))}/oauth/token`;
  const res = await requestJson(ctx, path, {
    method: 'POST',
    auth: false,
    body: { grant_type: 'client_credentials', client_id: String(options.clientId), client_secret: secret },
  });
  writeLine(ctx.io.stderr, 'warning: the output contains a UCP access token. It is shown once and not stored by the CLI — treat it as a secret.');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `access_token: ${b.access_token ?? ''}`);
  writeLine(ctx.io.stdout, `token_type:   ${b.token_type ?? ''}`);
  writeLine(ctx.io.stdout, `expires_in:   ${b.expires_in ?? ''}`);
  writeLine(ctx.io.stdout, `scope:        ${b.scope ?? ''}`);
  return 0;
}

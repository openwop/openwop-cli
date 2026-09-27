import type { Ctx } from '../context.js';
/**
 * `openwop billing ...` — workspace billing reads + Stripe hand-offs (openwop-app
 * ADR 0176 billing, ADR 0419 paid feature bundles; `features/billing/routes.ts`).
 *
 * CARD-DATA BOUNDARY: this command never collects, sends or prints payment
 * details. `checkout` / `bundle-checkout` / `portal` return a Stripe-hosted URL
 * (or a `demo:` placeholder when the host has no Stripe key) for the operator to
 * open in a browser; card entry happens on Stripe's page. The Stripe webhook
 * route is Stripe→server only (signed with a secret the CLI never holds) and is
 * deliberately not driven here.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { gatedRequest, readBodyOption, arrayOf } from './adminShared.js';

const BASE = '/v1/host/openwop-app/billing';

export const BILLING_HELP = `Usage:
  openwop billing subscription [--json]
  openwop billing balance [--json]
  openwop billing entitlements [--json]
  openwop billing bundles [--json]
  openwop billing invoices [list] [--json]
  openwop billing invoices get <invoiceId> [--json]
  openwop billing checkout --price <priceId> [--json]
  openwop billing bundle-checkout <bundleId> [--json]
  openwop billing portal [--json]

  Super-admin operations:
  openwop billing invoices create --amount <n> [--currency <c>] [--json]
  openwop billing coupons create --code <c> [--type percentage|fixed] [--value <n>] [--json]
  openwop billing sync-seats [--json]
  openwop billing import (--body <json> | --body-file <path>) [--json]

Workspace billing (host extension under ${BASE}; toggle 'billing').
  subscription     GET  /subscription               plan tier, status, seats, period
  balance          GET  /balance                    purchased token balance
  entitlements     GET  /entitlements               the plan's allowed features + limits
  bundles          GET  /bundles                    paid feature bundles (for sale / owned)
  invoices         GET  /invoices[/:invoiceId]      generated invoices
  checkout         POST /checkout                   a Stripe Checkout URL for a price
  bundle-checkout  POST /bundles/:bundleId/checkout a Stripe Checkout URL for a bundle
  portal           POST /portal                     a Stripe customer-portal URL
  invoices create  POST /invoices                   [super-admin] generate an invoice
  coupons create   POST /coupons                    [super-admin] create a coupon
  sync-seats       POST /sync-seats                 [super-admin] recount seats from members
  import           POST /import                     [super-admin] import {subscriptions[], balances[]}

NO CARD DATA: checkout/portal only return a Stripe-hosted URL to open in your browser
(mode "demo" with a demo: URL when the server has no Stripe key configured). The Stripe
webhook (POST /webhook) is Stripe-to-server only and is not exposed here.

Exit codes: 0 ok · 2 usage / not found / billing off · 4 permission denied / not super-admin.

Examples:
  openwop billing subscription
  openwop billing checkout --price price_123
  openwop billing portal --json
  openwop billing coupons create --code LAUNCH20 --type percentage --value 20
`;

export async function runBilling(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'subscription';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, BILLING_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help'],
    value: ['--price', '--amount', '--currency', '--code', '--type', '--value', '--body', '--body-file'],
  });
  if (options.help) { write(ctx.io.stdout, BILLING_HELP); return 0; }
  const emit = (body: any, human: () => void) => { if (ctx.json) writeJson(ctx.io.stdout, body); else human(); };
  const superadmin = (path: string, body: unknown, surface: string) =>
    gatedRequest(ctx, path, { method: 'POST', body }, surface, 'superadmin');

  switch (sub) {
    case 'subscription': {
      const res = await requestJson(ctx, `${BASE}/subscription`);
      emit(res.body, () => {
        const s = res.body ?? {};
        writeLine(ctx.io.stdout, `plan:    ${s.planTier ?? '?'} (${s.status ?? '?'})`);
        writeLine(ctx.io.stdout, `seats:   ${s.quantity ?? '—'}`);
        if (s.currentPeriodEnd) writeLine(ctx.io.stdout, `renews:  ${s.currentPeriodEnd}`);
        if (s.trialEnd) writeLine(ctx.io.stdout, `trial:   ends ${s.trialEnd}`);
      });
      return 0;
    }
    case 'balance': {
      const res = await requestJson(ctx, `${BASE}/balance`);
      emit(res.body, () => writeLine(ctx.io.stdout, `tokens available: ${res.body?.totalAvailable ?? 0} (purchased total ${res.body?.purchasedTokensTotal ?? 0})`));
      return 0;
    }
    case 'entitlements': {
      const res = await requestJson(ctx, `${BASE}/entitlements`);
      emit(res.body, () => {
        const e = res.body ?? {};
        writeLine(ctx.io.stdout, `plan: ${e.plan ?? '?'}`);
        writeLine(ctx.io.stdout, `allowed features: ${e.allowedFeatures === '*' ? 'all' : Array.isArray(e.allowedFeatures) ? e.allowedFeatures.join(', ') : '?'}`);
        const limits = e.limits && typeof e.limits === 'object' ? Object.entries(e.limits) : [];
        writeLine(ctx.io.stdout, `limits: ${limits.length ? limits.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
      });
      return 0;
    }
    case 'bundles': {
      const res = await requestJson(ctx, `${BASE}/bundles`);
      emit(res.body, () => {
        const rows = arrayOf(res.body, 'bundles');
        if (rows.length === 0) { writeLine(ctx.io.stdout, 'No feature bundles configured.'); return; }
        writeLine(ctx.io.stdout, formatTable(rows.map((b: any) => ({
          bundleId: b.bundleId, forSale: b.forSale ? 'yes' : 'no', owned: b.owned ? 'yes' : 'no', price: b.priceDisplay ?? '',
        })), ['bundleId', 'forSale', 'owned', 'price']));
      });
      return 0;
    }
    case 'invoices': {
      const verb = positionals[0] ?? 'list';
      if (verb === 'get') {
        if (!positionals[1]) throw new CliError('Usage: openwop billing invoices get <invoiceId>', 2);
        const res = await requestJson(ctx, `${BASE}/invoices/${encodeURIComponent(positionals[1])}`);
        emit(res.body, () => writeLine(ctx.io.stdout, res.body?.markdown ?? JSON.stringify(res.body, null, 2)));
        return 0;
      }
      if (verb === 'create') {
        const amount = Number(options.amount);
        if (options.amount === undefined || !Number.isFinite(amount)) throw new CliError('Usage: openwop billing invoices create --amount <n> [--currency <c>]', 2);
        const res = await superadmin(`${BASE}/invoices`, { amount, ...(options.currency ? { currency: options.currency } : {}) }, 'Generating an invoice');
        emit(res.body, () => writeLine(ctx.io.stdout, `Created invoice ${res.body?.invoiceId ?? '?'} (${res.body?.amount} ${res.body?.currency}).`));
        return 0;
      }
      if (verb !== 'list') throw new CliError(`Unknown invoices verb: ${verb}`, 2);
      const res = await requestJson(ctx, `${BASE}/invoices`);
      emit(res.body, () => {
        const rows = arrayOf(res.body, 'invoices');
        if (rows.length === 0) { writeLine(ctx.io.stdout, 'No invoices.'); return; }
        writeLine(ctx.io.stdout, formatTable(rows.map((i: any) => ({
          invoiceId: i.invoiceId, planTier: i.planTier ?? '', amount: `${i.amount ?? ''} ${i.currency ?? ''}`.trim(), createdAt: i.createdAt ?? '',
        })), ['invoiceId', 'planTier', 'amount', 'createdAt']));
      });
      return 0;
    }
    case 'checkout': {
      if (!options.price) throw new CliError('Usage: openwop billing checkout --price <priceId>', 2);
      const res = await requestJson(ctx, `${BASE}/checkout`, { method: 'POST', body: { priceId: options.price } });
      emit(res.body, () => writeLine(ctx.io.stdout, `Open to complete checkout (${res.body?.mode ?? '?'}): ${res.body?.url ?? '?'}`));
      return 0;
    }
    case 'bundle-checkout': {
      if (!positionals[0]) throw new CliError('Usage: openwop billing bundle-checkout <bundleId>', 2);
      const res = await requestJson(ctx, `${BASE}/bundles/${encodeURIComponent(positionals[0])}/checkout`, { method: 'POST', body: {} });
      emit(res.body, () => writeLine(ctx.io.stdout, `Open to complete checkout (${res.body?.mode ?? '?'}): ${res.body?.url ?? '?'}`));
      return 0;
    }
    case 'portal': {
      const res = await requestJson(ctx, `${BASE}/portal`, { method: 'POST', body: {} });
      emit(res.body, () => writeLine(ctx.io.stdout, `Billing portal (${res.body?.mode ?? '?'}): ${res.body?.url ?? '?'}`));
      return 0;
    }
    case 'coupons': {
      if (positionals[0] !== 'create' || !options.code) throw new CliError('Usage: openwop billing coupons create --code <c> [--type percentage|fixed] [--value <n>]', 2);
      if (options.type !== undefined && options.type !== 'percentage' && options.type !== 'fixed') throw new CliError('--type must be percentage or fixed.', 2);
      const body: Record<string, any> = { code: options.code, type: options.type ?? 'percentage' };
      if (options.value !== undefined) {
        const v = Number(options.value);
        if (!Number.isFinite(v)) throw new CliError('--value must be a number.', 2);
        body.value = v;
      }
      const res = await superadmin(`${BASE}/coupons`, body, 'Creating a billing coupon');
      emit(res.body, () => writeLine(ctx.io.stdout, `Created coupon ${res.body?.code ?? options.code} (${res.body?.type} ${res.body?.value}).`));
      return 0;
    }
    case 'sync-seats': {
      const res = await superadmin(`${BASE}/sync-seats`, {}, 'Billing seat sync');
      emit(res.body, () => writeLine(ctx.io.stdout, `Seats synced: ${res.body?.quantity ?? '?'}.`));
      return 0;
    }
    case 'import': {
      const body = readBodyOption(ctx, options);
      if (!body) throw new CliError('Usage: openwop billing import (--body <json> | --body-file <path>)  — {"subscriptions":[...],"balances":[...]}', 2);
      const res = await superadmin(`${BASE}/import`, body, 'Billing import');
      emit(res.body, () => writeLine(ctx.io.stdout, `Imported ${res.body?.subscriptions ?? 0} subscription(s), ${res.body?.balances ?? 0} balance(s).`));
      return 0;
    }
    case 'webhook':
      throw new CliError('The Stripe webhook is Stripe-to-server only (it needs Stripe\'s signature) and is not driven from the CLI.', 2);
    default:
      throw new CliError(`Unknown billing command: ${sub}\nRun \`openwop billing --help\` for usage.`);
  }
}

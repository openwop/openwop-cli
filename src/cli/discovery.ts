import type { Ctx } from '../context.js';
/**
 * `openwop discovery ...` — product discovery / merchandising (ADR 0275).
 *
 * Operator surface: /v1/host/openwop-app/discovery/orgs/{orgId}/{collections,rules,search,embeddings}
 * (toggle `discovery`; read = workspace:read, write = workspace:write in the org).
 * Shopper surface (`public search`): /v1/host/openwop-app/public-discovery/{orgId}/search
 * — anonymous; a toggle-off store answers an empty result, an unknown org 404s.
 */
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import {
  APP, enc, dispatchTable, listOut, done, assign, qs, parseJsonFlag, num, type Cmd,
} from './marketingShared.js';

const base = (org: string) => `${APP}/discovery/orgs/${enc(org)}`;

export const DISCOVERY_HELP = `Usage:
  openwop discovery collections --org <orgId> [--json]
  openwop discovery collection-create --org <orgId> --name <n> [--type manual|rule] [--product-id <id>]... [--rule-json '{...}'] [--parent <collectionId>] [--body <json>|--body-file <f>] [--json]
  openwop discovery collection-update <collectionId> --org <orgId> [--name <n>] [--product-id <id>]... [--rule-json '{...}'] [--active true|false] [--parent <id>] [--body <json>] [--json]
  openwop discovery collection-delete <collectionId> --org <orgId> --yes
  openwop discovery collection-resolve <collectionId> --org <orgId> [--json]
  openwop discovery rules --org <orgId> [--json]
  openwop discovery rule-create --org <orgId> --name <n> [--scope-json '{...}'] [--actions-json '[...]'] [--holdout-pct <n>] [--body <json>|--body-file <f>] [--json]
  openwop discovery rule-delete <ruleId> --org <orgId> --yes
  openwop discovery search --org <orgId> [--q <text>] [--collection <id>] [--filter key=value]... [--session-key <k>] [--json]
  openwop discovery embeddings-rebuild --org <orgId> [--json]
  openwop discovery public search <orgId> [--q <text>] [--collection <id>] [--filter key=value]... [--session-key <k>] [--json]

Product discovery (ADR 0275): curated/rule collections, merchandising rules
(boost/bury/pin with an optional holdout), faceted product search, and the
semantic-search embedding index. Operator commands hit
/v1/host/openwop-app/discovery/orgs/{orgId}/... and need --org. 'collection-update'
is a partial PATCH. 'embeddings-rebuild' invalidates + re-derives the org's
product embedding index.

'public search' drives the anonymous storefront search
/v1/host/openwop-app/public-discovery/{orgId}/search (no auth) — the same result a
shopper sees (a store with discovery off answers an empty list).

Each --filter key=value is sent as filters[key]=value (a facet constraint).

Exit codes: 0 ok; 2 usage error or host 4xx (404 = unknown collection/rule/org);
4 auth/permission denied; 1 server error.

Examples:
  openwop discovery collections --org org_1
  openwop discovery collection-create --org org_1 --name "Summer" --product-id p_1 --product-id p_2
  openwop discovery search --org org_1 --q shoes --filter category=footwear
  openwop discovery public search org_1 --q shoes --json
`;

function orgOf(a: { options: Record<string, any> }): string { return requireOrg(a.options.org); }

function searchQuery(o: Record<string, any>): string {
  const params: Record<string, unknown> = { q: o.q, collectionId: o.collection, sessionKey: o.sessionKey };
  for (const pair of o.filter ?? []) {
    const s = String(pair);
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    params[`filters[${s.slice(0, eq)}]`] = s.slice(eq + 1);
  }
  return qs(params);
}

function boolFlag(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  return String(v) === 'true' || String(v) === '1' || String(v) === 'yes';
}

const PRODUCT_COLS = ['productId', 'name', 'type', 'price', 'currency'];

function renderSearch(ctx: Ctx, body: any): number {
  return listOut(ctx, body, 'products', PRODUCT_COLS, 'No products matched.');
}

const TABLE: Record<string, Cmd> = {
  collections: {
    usage: 'collections --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${base(orgOf(a))}/collections`)).body, 'collections',
      ['collectionId', 'name', 'type', 'active', ['products', (c) => c.productIds]], 'No collections.'),
  },
  'collection-create': {
    usage: "collection-create --org <orgId> --name <n> [--type manual|rule] [--product-id <id>]... [--rule-json '{...}'] [--parent <collectionId>] [--body <json>|--body-file <f>] [--json]",
    args: 0, body: true, value: ['--org', '--name', '--type', '--rule-json', '--parent'], multi: ['--product-id'], requires: ['name'],
    run: async (ctx, a) => {
      const o = a.options;
      const body = assign({ ...a.body }, {
        name: o.name, type: o.type, productIds: o.productId,
        rule: o.ruleJson !== undefined ? parseJsonFlag(o.ruleJson, '--rule-json') : undefined, parentId: o.parent,
      });
      const res = (await requestJson(ctx, `${base(orgOf(a))}/collections`, { method: 'POST', body })).body;
      return done(ctx, res, `Created collection ${res?.collection?.collectionId ?? ''}.`);
    },
  },
  'collection-update': {
    usage: "collection-update <collectionId> --org <orgId> [--name <n>] [--product-id <id>]... [--rule-json '{...}'] [--active true|false] [--parent <id>] [--body <json>] [--json]",
    args: 1, body: true, value: ['--org', '--name', '--rule-json', '--active', '--parent'], multi: ['--product-id'],
    run: async (ctx, a) => {
      const o = a.options;
      const body = assign({ ...a.body }, {
        name: o.name, productIds: o.productId,
        rule: o.ruleJson !== undefined ? parseJsonFlag(o.ruleJson, '--rule-json') : undefined,
        active: boolFlag(o.active), parentId: o.parent,
      });
      const res = (await requestJson(ctx, `${base(orgOf(a))}/collections/${enc(a.positionals[0])}`, { method: 'PATCH', body })).body;
      return done(ctx, res, `Updated collection ${a.positionals[0]}.`);
    },
  },
  'collection-delete': {
    usage: 'collection-delete <collectionId> --org <orgId> --yes', args: 1, value: ['--org'], confirm: 'delete the collection',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${base(orgOf(a))}/collections/${enc(a.positionals[0])}`, { method: 'DELETE' })).body, `Deleted collection ${a.positionals[0]}.`),
  },
  'collection-resolve': {
    usage: 'collection-resolve <collectionId> --org <orgId> [--json]', args: 1, value: ['--org'],
    run: async (ctx, a) => renderSearch(ctx, (await requestJson(ctx, `${base(orgOf(a))}/collections/${enc(a.positionals[0])}/resolve`)).body),
  },
  rules: {
    usage: 'rules --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => listOut(ctx, (await requestJson(ctx, `${base(orgOf(a))}/rules`)).body, 'rules',
      ['ruleId', 'name', 'holdoutPct', ['actions', (r) => r.actions]], 'No merchandising rules.'),
  },
  'rule-create': {
    usage: "rule-create --org <orgId> --name <n> [--scope-json '{...}'] [--actions-json '[...]'] [--holdout-pct <n>] [--body <json>|--body-file <f>] [--json]",
    args: 0, body: true, value: ['--org', '--name', '--scope-json', '--actions-json', '--holdout-pct'], requires: ['name'],
    run: async (ctx, a) => {
      const o = a.options;
      const body = assign({ ...a.body }, {
        name: o.name,
        scope: o.scopeJson !== undefined ? parseJsonFlag(o.scopeJson, '--scope-json') : undefined,
        actions: o.actionsJson !== undefined ? parseJsonFlag(o.actionsJson, '--actions-json') : undefined,
        holdoutPct: o.holdoutPct !== undefined ? num(o.holdoutPct, '--holdout-pct') : undefined,
      });
      const res = (await requestJson(ctx, `${base(orgOf(a))}/rules`, { method: 'POST', body })).body;
      return done(ctx, res, `Created rule ${res?.rule?.ruleId ?? ''}.`);
    },
  },
  'rule-delete': {
    usage: 'rule-delete <ruleId> --org <orgId> --yes', args: 1, value: ['--org'], confirm: 'delete the rule',
    run: async (ctx, a) => done(ctx, (await requestJson(ctx, `${base(orgOf(a))}/rules/${enc(a.positionals[0])}`, { method: 'DELETE' })).body, `Deleted rule ${a.positionals[0]}.`),
  },
  search: {
    usage: 'search --org <orgId> [--q <text>] [--collection <id>] [--filter key=value]... [--session-key <k>] [--json]',
    args: 0, value: ['--org', '--q', '--collection', '--session-key'], multi: ['--filter'],
    run: async (ctx, a) => renderSearch(ctx, (await requestJson(ctx, `${base(orgOf(a))}/search${searchQuery(a.options)}`)).body),
  },
  'embeddings-rebuild': {
    usage: 'embeddings-rebuild --org <orgId> [--json]', args: 0, value: ['--org'],
    run: async (ctx, a) => {
      const res = (await requestJson(ctx, `${base(orgOf(a))}/embeddings/rebuild`, { method: 'POST' })).body;
      return done(ctx, res, `Rebuilt the product embedding index (${res?.products ?? 0} products).`);
    },
  },
};

const PUBLIC: Record<string, Cmd> = {
  search: {
    usage: 'search <orgId> [--q <text>] [--collection <id>] [--filter key=value]... [--session-key <k>] [--json]',
    args: 1, value: ['--q', '--collection', '--session-key'], multi: ['--filter'],
    run: async (ctx, a) => renderSearch(ctx, (await requestJson(ctx, `${APP}/public-discovery/${enc(a.positionals[0])}/search${searchQuery(a.options)}`, { auth: false })).body),
  },
};

export async function runDiscovery(ctx: Ctx, argv: string[]) {
  if (argv[0] === 'public') return dispatchTable(ctx, 'discovery public', DISCOVERY_HELP, PUBLIC, argv.slice(1), '--help');
  return dispatchTable(ctx, 'discovery', DISCOVERY_HELP, TABLE, argv, 'collections');
}


import type { Ctx } from '../context.js';
/**
 * `openwop docs ...` — the product-documentation surface (feature: docs, ADR 0392).
 *
 * Docs are CMS pages; this group drives the two non-page routes:
 *   - POST /v1/host/openwop-app/docs/orgs/<orgId>/backfill   (authed; host:members:manage)
 *     the idempotent docs ↔ knowledge-base reconcile sweep; the returned counts
 *     are the on-demand drift signal.
 *   - GET  /v1/host/openwop-app/public/<orgId>/docs          (public, no auth)
 *     the published docs navigation tree.
 * Host-extension, non-normative.
 */
import { CliError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { enc, pickArray, renderList } from './contentHelpers.js';

export const DOCS_HELP = `Usage:
  openwop docs backfill --org <orgId> [--json]
  openwop docs public <orgId> [--json]

Product documentation (host-extension, ADR 0392).
  backfill  POST /v1/host/openwop-app/docs/orgs/<orgId>/backfill — re-sync every
            published doc page into the org's knowledge base (idempotent). Needs
            the publish-approval tier (host:members:manage). Prints the counts.
  public    GET /v1/host/openwop-app/public/<orgId>/docs — the published docs
            navigation tree, read WITHOUT auth (what visitors see).

Exit codes: 0 ok; 2 usage error or a 4xx; 4 auth or permission denied; 1 server error.

Examples:
  openwop docs backfill --org org_1
  openwop docs public org_1 --json
`;

export async function runDocs(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, DOCS_HELP); return sub ? 0 : 2; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--org'] });
  if (options.help) { write(ctx.io.stdout, DOCS_HELP); return 0; }
  switch (sub) {
    case 'backfill': {
      const org = requireOrg(options.org);
      const res = await requestJson(ctx, `/v1/host/openwop-app/docs/orgs/${enc(org)}/backfill`, { method: 'POST', body: {} });
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'public': {
      const org = positionals[0] ?? options.org;
      if (!org) { write(ctx.io.stderr, 'Usage: openwop docs public <orgId>\n'); return 2; }
      const res = await requestJson(ctx, `/v1/host/openwop-app/public/${enc(org)}/docs`, { auth: false });
      return renderList(ctx, res.body, pickArray(res.body, 'docs'), ['slug', 'title'], 'No published docs.',
        (d) => ({ slug: d.slug ?? '', title: d.title ?? '' }));
    }
    default: throw new CliError(`Unknown docs command: ${sub}\nRun \`openwop docs --help\` for usage.`);
  }
}

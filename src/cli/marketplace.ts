import type { Ctx } from '../context.js';
/** `openwop marketplace ...` — pack marketplace: listings, install, reviews (feature: marketplace). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';

const MP = '/v1/host/sample/marketplace';
const reviews = (org: string, pack: string) => `${MP}/orgs/${encodeURIComponent(org)}/listings/${encodeURIComponent(pack)}/reviews`;

export const MARKETPLACE_HELP = `Usage:
  openwop marketplace listings [--json]
  openwop marketplace install --pack <name> --version <v> [--json]
  openwop marketplace reviews <packName> --org <orgId> [--json]
  openwop marketplace review <packName> --org <orgId> --rating <1-5> [--comment <t>] [--json]
  openwop marketplace unreview <packName> --org <orgId> [--yes]

The pack marketplace (host-extension). \`listings\`/\`install\` browse + install shared
packs; \`reviews\`/\`review\`/\`unreview\` are org-scoped (need --org). Distinct from the
signed node-pack \`packs\` registry. The host is the authority; the CLI mirrors + relays.
`;


export async function runMarketplace(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'listings';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, MARKETPLACE_HELP); return 0; }
  const args = argv.slice(['listings', 'install', 'reviews', 'review', 'unreview'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'listings': return mpListings(ctx, args);
    case 'install': return mpInstall(ctx, args);
    case 'reviews': return mpReviews(ctx, args);
    case 'review': return mpReview(ctx, args);
    case 'unreview': return mpUnreview(ctx, args);
    default: throw new CliError(`Unknown marketplace command: ${sub}\nRun \`openwop marketplace --help\` for usage.`);
  }
}

async function mpListings(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, MARKETPLACE_HELP); return 0; }
  const res = await requestJson(ctx, `${MP}/listings`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.listings) ? res.body.listings : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No listings.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(
    items.map((l: any) => ({ pack: l.packName ?? l.name ?? '', version: l.version ?? l.latestVersion ?? '', rating: l.rating ?? '', installs: l.installs ?? '' })),
    ['pack', 'version', 'rating', 'installs'],
  ));
  return 0;
}

async function mpInstall(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--pack', '--version'] });
  if (!options.pack || !options.version) { write(ctx.io.stderr, 'Usage: openwop marketplace install --pack <name> --version <v> [--json]\n'); return 2; }
  const res = await requestJson(ctx, `${MP}/install`, { method: 'POST', body: { packName: String(options.pack), version: String(options.version) } });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Installed ${String(options.pack)}@${String(options.version)}.`);
  return 0;
}

async function mpReviews(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop marketplace reviews <packName> --org <orgId> [--json]\n'); return options.help ? 0 : 2; }
  const res = await requestJson(ctx, reviews(org, positionals[0]));
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.reviews) ? res.body.reviews : [];
  if (items.length === 0) { writeLine(ctx.io.stdout, 'No reviews.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(items.map((r: any) => ({ author: r.authorId ?? '', rating: r.rating ?? '', comment: (r.comment ?? '').slice(0, 60) })), ['author', 'rating', 'comment']));
  return 0;
}

async function mpReview(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { value: ['--org', '--rating', '--comment'] });
  const org = requireOrg(options.org);
  if (positionals.length !== 1 || options.rating === undefined) { write(ctx.io.stderr, 'Usage: openwop marketplace review <packName> --org <orgId> --rating <1-5> [--comment <t>] [--json]\n'); return 2; }
  const body: Record<string, unknown> = { rating: Number(options.rating) };
  if (options.comment) body.comment = String(options.comment);
  const res = await requestJson(ctx, reviews(org, positionals[0]), { method: 'POST', body });
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `Reviewed ${positionals[0]} (${Number(options.rating)}★).`);
  return 0;
}

async function mpUnreview(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'], value: ['--org'] });
  const org = requireOrg(options.org);
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop marketplace unreview <packName> --org <orgId> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) throw new CliError(`Refusing to remove your review of ${positionals[0]} without --yes.`, 2);
  await requestJson(ctx, reviews(org, positionals[0]), { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Removed review of ${positionals[0]}.`);
  return 0;
}

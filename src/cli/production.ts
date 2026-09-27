import type { Ctx } from '../context.js';
/**
 * `openwop production ...` — Production Intelligence (openwop-app ADR 0172:
 * vendor directory + generated production plans; ADR 0643 D6: the vendor KB
 * `reindex-kb` repair lane). Host-extension, org-scoped:
 * `/v1/host/openwop-app/production/orgs/<orgId>/...`. Plan GENERATION is a
 * workflow run, not a route — this group reads plans and moves their advisory
 * status. Vendor pricing is redacted by the host for callers without
 * host:members:manage; the CLI renders whatever the host returns.
 */
import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requireOrg } from './shared.js';
import { csv, enc, mergeBody, pickArray, renderDone, renderList, withQuery } from './contentHelpers.js';

const base = (org: string) => `/v1/host/openwop-app/production/orgs/${enc(org)}`;

export const PRODUCTION_HELP = `Usage:
  openwop production plans list --org <orgId> [--json]
  openwop production plans get <planId> --org <orgId> [--json]
  openwop production plans status <planId> --org <orgId> --status draft|approved|in_production|completed [--json]
  openwop production vendors list --org <orgId> [--q <text>] [--type contractor|agency] [--contract-status active|inactive|preferred] [--json]
  openwop production vendors get <vendorId> --org <orgId> [--json]
  openwop production vendors create --org <orgId> --name <n> [--type <t>] [--contact-email <e>] [--website <u>] [--region <r>] [--contract-status <s>] [--notes <text>] [--company <companyId>] [--body <json>|--body-file <path>] [--json]
  openwop production vendors update <vendorId> --org <orgId> [same fields as create] [--json]
  openwop production vendors delete <vendorId> --org <orgId> --yes
  openwop production vendors portfolio <vendorId> --org <orgId> (--set a,b | --add a,b | --remove a,b | --clear) [--json]
  openwop production reindex-kb --org <orgId> [--json]

Production Intelligence (host-extension, ADR 0172). Hits
/v1/host/openwop-app/production/orgs/<orgId>/{plans,vendors,reindex-kb}.

create/update map flags to the host fields (companyId, contactEmail, website,
region, contractStatus, notes, type, name); pass capabilities, priceRanges,
pastProjects, lastVerifiedAt via --body/--body-file (flags win). \`vendors
portfolio\` REPLACES the vendor's portfolio media-asset token set on the host,
so --add/--remove read the current set first and write the merged result.
\`reindex-kb\` rebuilds the vendor-directory knowledge base and reports
\`complete\`: false means the sweep did not finish (re-run it).

Exit codes: 0 ok; 2 usage error or 4xx; 4 auth/permission denied; 1 server error.

Examples:
  openwop production vendors list --org acme --type agency
  openwop production vendors create --org acme --name "Blue Films" --type agency --region EU
  openwop production vendors portfolio v_1 --org acme --add tok_a,tok_b
  openwop production plans status plan_1 --org acme --status approved
  openwop production reindex-kb --org acme --json
`;

const VALUE_FLAGS = [
  '--org', '--status', '--q', '--type', '--contract-status', '--name', '--contact-email', '--website', '--region',
  '--notes', '--company', '--body', '--body-file', '--set', '--add', '--remove',
];

export async function runProduction(ctx: Ctx, argv: string[]): Promise<number> {
  const family = argv[0];
  if (!family || family === '--help' || family === '-h' || family === 'help') { write(ctx.io.stdout, PRODUCTION_HELP); return family ? 0 : 2; }
  if (family === 'reindex-kb') {
    const { options } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--org'] });
    if (options.help) { write(ctx.io.stdout, PRODUCTION_HELP); return 0; }
    const org = requireOrg(options.org);
    const res = await requestJson(ctx, `${base(org)}/reindex-kb`, { method: 'POST', body: {} });
    const b = res.body ?? {};
    const complete = b.complete === false ? ' (INCOMPLETE — re-run to finish)' : '';
    return renderDone(ctx, b, `Reindexed vendor knowledge base${complete}: ${JSON.stringify(b)}`);
  }
  if (family !== 'plans' && family !== 'vendors') throw new CliError(`Unknown production command: ${family}\nRun \`openwop production --help\` for usage.`);
  const sub = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'list';
  const rest = argv.slice(argv[1] === sub ? 2 : 1);
  const { options, positionals } = parseOptions(rest, { bool: ['--help', '--yes', '--clear'], value: VALUE_FLAGS });
  if (options.help) { write(ctx.io.stdout, PRODUCTION_HELP); return 0; }
  const org = requireOrg(options.org);
  const id = positionals[0];
  const need = (usage: string) => { if (!id) throw new CliError(`Usage: openwop production ${family} ${usage}`); return enc(id); };
  if (family === 'plans') {
    const plans = `${base(org)}/plans`;
    switch (sub) {
      case 'list': {
        const res = await requestJson(ctx, plans);
        return renderList(ctx, res.body, pickArray(res.body, 'plans'), ['planId', 'status', 'briefId', 'generatedAt'], 'No production plans.');
      }
      case 'get': {
        const res = await requestJson(ctx, `${plans}/${need('get <planId> --org <orgId>')}`);
        writeJson(ctx.io.stdout, res.body); return 0;
      }
      case 'status': {
        const path = `${plans}/${need('status <planId> --org <orgId> --status <s>')}/status`;
        if (!options.status) throw new CliError('production plans status needs --status draft|approved|in_production|completed.');
        const res = await requestJson(ctx, path, { method: 'POST', body: { status: String(options.status) } });
        return renderDone(ctx, res.body, `Production plan ${id} is now ${res.body?.status ?? options.status}.`);
      }
      default: throw new CliError(`Unknown production plans command: ${sub}`);
    }
  }
  const vendors = `${base(org)}/vendors`;
  const fields = () => mergeBody(ctx, options, {
    name: options.name, type: options.type, contactEmail: options.contactEmail, website: options.website,
    region: options.region, contractStatus: options.contractStatus, notes: options.notes, companyId: options.company,
  });
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, withQuery(vendors, { q: options.q, type: options.type, contractStatus: options.contractStatus }));
      return renderList(ctx, res.body, pickArray(res.body, 'vendors'), ['vendorId', 'name', 'type', 'contractStatus', 'region'], 'No vendors.');
    }
    case 'get': {
      const res = await requestJson(ctx, `${vendors}/${need('get <vendorId> --org <orgId>')}`);
      writeJson(ctx.io.stdout, res.body); return 0;
    }
    case 'create': {
      const body = fields();
      if (!body.name) throw new CliError('production vendors create needs --name.');
      const res = await requestJson(ctx, vendors, { method: 'POST', body });
      return renderDone(ctx, res.body, `Created vendor ${res.body?.vendorId ?? ''} (${String(body.name)}).`);
    }
    case 'update': {
      const path = `${vendors}/${need('update <vendorId> --org <orgId> [fields]')}`;
      const body = fields();
      if (Object.keys(body).length === 0) throw new CliError('production vendors update needs at least one field.');
      const res = await requestJson(ctx, path, { method: 'PATCH', body });
      return renderDone(ctx, res.body, `Updated vendor ${id}.`);
    }
    case 'delete': {
      const path = `${vendors}/${need('delete <vendorId> --org <orgId> --yes')}`;
      if (!options.yes) throw new CliError(`Refusing to delete vendor ${id} without --yes.`);
      await requestJson(ctx, path, { method: 'DELETE' });
      return renderDone(ctx, { deleted: true, vendorId: id }, `Deleted vendor ${id}.`);
    }
    case 'portfolio': {
      const path = `${vendors}/${need('portfolio <vendorId> --org <orgId> (--set|--add|--remove|--clear)')}`;
      const modes = [options.set !== undefined, options.add !== undefined, options.remove !== undefined, Boolean(options.clear)].filter(Boolean).length;
      if (modes !== 1) throw new CliError('production vendors portfolio needs exactly one of --set, --add, --remove, --clear.');
      let tokens: string[];
      if (options.clear) tokens = [];
      else if (options.set !== undefined) tokens = csv(options.set) ?? [];
      else {
        // The host PUT replaces the whole set — read-modify-write.
        const current = await requestJson(ctx, path);
        const existing: string[] = Array.isArray(current.body?.portfolioAssetTokens) ? current.body.portfolioAssetTokens.map(String) : [];
        if (options.add !== undefined) tokens = [...new Set([...existing, ...(csv(options.add) ?? [])])];
        else { const drop = new Set(csv(options.remove) ?? []); tokens = existing.filter((t) => !drop.has(t)); }
      }
      const res = await requestJson(ctx, `${path}/portfolio`, { method: 'PUT', body: { tokens } });
      const n = Array.isArray(res.body?.portfolioAssetTokens) ? res.body.portfolioAssetTokens.length : tokens.length;
      return renderDone(ctx, res.body, `Vendor ${id} portfolio now has ${n} asset token${n === 1 ? '' : 's'}.`);
    }
    default: throw new CliError(`Unknown production vendors command: ${sub}`);
  }
}

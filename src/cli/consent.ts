import type { Ctx } from '../context.js';
/** `openwop consent ...` — tenant-scoped, region-aware consent store (ADR 0020). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

export const CONSENT_HELP = `Usage:
  openwop consent policy <orgId> [--json]
  openwop consent set-policy <orgId> [--default-mode opt-in|opt-out] [--regulated-region <r>]... [--json]
  openwop consent records <orgId> [--json]
  openwop consent get <orgId> <subjectKey> [--json]
  openwop consent erase <orgId> <subjectKey> [--yes] [--json]
  openwop consent public get <orgId> <subjectKey> [--json]
  openwop consent public record <orgId> <subjectKey> [--category <name=bool>]... [--region <r>] [--json]

Tenant-scoped consent (ADR 0020). The host is the authority: consent is stored
per-tenant and the host resolves a subject's effective categories. This command
RENDERS the host's resolved view — it never computes or asserts a consent outcome
locally. The org→tenant mapping and the per-tenant 'consent' feature toggle are
enforced host-side; when the toggle is off the host returns a uniform 404 and this
command fails closed with a legible message (it does not assume permissive).

Authed, org-scoped (RBAC) — hits /v1/host/sample/consent/orgs/<orgId>/*:
  policy        GET  .../policy        Show the tenant consent policy (defaultMode + regulated regions).
  set-policy    PUT  .../policy        Update defaultMode and/or regulatedRegions (workspace:write).
  records       GET  .../records       List all consent records for the tenant.
  get           GET  .../subjects/<k>  Show one subject's consent record (or none).
  erase         DEL  .../subjects/<k>  GDPR erasure — purge the record + fan out to feature erasers (idempotent).

Public, unauthed — hits /v1/host/sample/public-consent/<orgId>:
  public get    GET  .../<k>           Read a visitor's recorded categories, or the policy default if none.
  public record POST .../             Record a visitor's category choices (source=public).

  --default-mode <m>      (set-policy) opt-in | opt-out.
  --regulated-region <r>  (set-policy) A regulated region code (repeatable; replaces the list).
  --category <name=bool>  (public record) A category choice, e.g. analytics=true (repeatable).
  --region <r>            (public record) The visitor's region.
  --yes                   (erase) Confirm the destructive GDPR erasure.

Exit codes: 0 success · 1 host/HTTP error (incl. consent not enabled) · 2 usage error.

Examples:
  openwop consent policy org_123
  openwop consent set-policy org_123 --default-mode opt-out --regulated-region EU --regulated-region UK
  openwop consent records org_123 --json
  openwop consent get org_123 visitor-abc
  openwop consent erase org_123 visitor-abc --yes
  openwop consent public get org_123 visitor-abc
  openwop consent public record org_123 visitor-abc --category analytics=true --category marketing=false
`;

const ORG_BASE = '/v1/host/sample/consent/orgs';
const PUB_BASE = '/v1/host/sample/public-consent';

/**
 * requestJson, but map the host's uniform 404 (org-tenant's `consent` toggle off,
 * or the surface not advertised) onto a legible fail-closed error rather than a bare
 * HTTP 404. The host is the authority; we never fall back to a permissive default.
 */
async function consentRequest(ctx: Ctx, path: string, options?: Parameters<typeof requestJson>[2]) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(
        "consent unavailable: the host returned 404. Consent is gated on the org-tenant's `consent` feature toggle (uniform 404 when off) — verify the org exists and the host advertises/enables consent.",
        1,
      );
    }
    throw err;
  }
}

export async function runConsent(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? '';
  if (sub === '--help' || sub === '-h' || sub === '') {
    write(ctx.io.stdout, CONSENT_HELP);
    return 0;
  }
  // `public` is a two-word namespace: `consent public get|record`.
  if (sub === 'public') {
    const psub = argv[1] ?? '';
    const rest = argv.slice(2);
    switch (psub) {
      case 'get':
        return await runPublicGet(ctx, rest);
      case 'record':
        return await runPublicRecord(ctx, rest);
      default:
        throw new CliError(`Unknown consent public command: ${psub || '(none)'}\nRun \`openwop consent --help\` for usage.`);
    }
  }
  const args = argv.slice(1);
  switch (sub) {
    case 'policy':
      return await runPolicyGet(ctx, args);
    case 'set-policy':
      return await runSetPolicy(ctx, args);
    case 'records':
      return await runRecords(ctx, args);
    case 'get':
      return await runGet(ctx, args);
    case 'erase':
      return await runErase(ctx, args);
    default:
      throw new CliError(`Unknown consent command: ${sub}\nRun \`openwop consent --help\` for usage.`);
  }
}

function renderCategories(c: any): string {
  if (!c || typeof c !== 'object') return '(none)';
  return ['necessary', 'analytics', 'marketing']
    .map((k) => `${k}=${c[k] === true ? 'yes' : 'no'}`)
    .join(' ');
}

async function runPolicyGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop consent policy <orgId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await consentRequest(ctx, `${ORG_BASE}/${encodeURIComponent(positionals[0])}/policy`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const p = res.body?.policy ?? {};
  writeLine(ctx.io.stdout, `tenantId: ${p.tenantId ?? ''}`);
  writeLine(ctx.io.stdout, `defaultMode: ${p.defaultMode ?? 'opt-in'}`);
  writeLine(ctx.io.stdout, `regulatedRegions: ${Array.isArray(p.regulatedRegions) && p.regulatedRegions.length ? p.regulatedRegions.join(', ') : '(none)'}`);
  return 0;
}

async function runSetPolicy(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--default-mode'],
    multi: ['--regulated-region'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop consent set-policy <orgId> [--default-mode opt-in|opt-out] [--regulated-region <r>]... [--json]\n');
    return options.help ? 0 : 2;
  }
  const body: { defaultMode?: string; regulatedRegions?: string[] } = {};
  if (options.defaultMode !== undefined) {
    if (options.defaultMode !== 'opt-in' && options.defaultMode !== 'opt-out') {
      throw new CliError('--default-mode must be opt-in or opt-out', 2);
    }
    body.defaultMode = options.defaultMode;
  }
  if (Array.isArray(options.regulatedRegion)) body.regulatedRegions = options.regulatedRegion;
  if (Object.keys(body).length === 0) throw new CliError('Nothing to set — pass --default-mode and/or --regulated-region.', 2);
  const res = await consentRequest(ctx, `${ORG_BASE}/${encodeURIComponent(positionals[0])}/policy`, { method: 'PUT', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const p = res.body?.policy ?? {};
  writeLine(ctx.io.stdout, `Updated consent policy: defaultMode=${p.defaultMode ?? ''} regulatedRegions=${Array.isArray(p.regulatedRegions) && p.regulatedRegions.length ? p.regulatedRegions.join(', ') : '(none)'}`);
  return 0;
}

async function runRecords(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop consent records <orgId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await consentRequest(ctx, `${ORG_BASE}/${encodeURIComponent(positionals[0])}/records`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const records = Array.isArray(res.body?.records) ? res.body.records : [];
  if (records.length === 0) {
    writeLine(ctx.io.stdout, 'No consent records for this tenant.');
    return 0;
  }
  const rows = records.map((r: any) => ({
    subjectKey: r.subjectKey,
    region: r.region ?? '',
    categories: renderCategories(r.categories),
    source: r.source ?? '',
    ts: r.ts ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['subjectKey', 'region', 'categories', 'source', 'ts']));
  return 0;
}

async function runGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 2) {
    write(ctx.io.stdout, 'Usage: openwop consent get <orgId> <subjectKey> [--json]\n');
    return options.help ? 0 : 2;
  }
  const [orgId, subjectKey] = positionals;
  const res = await consentRequest(ctx, `${ORG_BASE}/${encodeURIComponent(orgId)}/subjects/${encodeURIComponent(subjectKey)}`);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const r = res.body?.record;
  if (!r) {
    writeLine(ctx.io.stdout, `No consent record for subject ${subjectKey}.`);
    return 0;
  }
  writeLine(ctx.io.stdout, `subjectKey: ${r.subjectKey}`);
  if (r.region) writeLine(ctx.io.stdout, `region: ${r.region}`);
  writeLine(ctx.io.stdout, `categories: ${renderCategories(r.categories)}`);
  writeLine(ctx.io.stdout, `source: ${r.source ?? ''}`);
  writeLine(ctx.io.stdout, `ts: ${r.ts ?? ''}`);
  if (r.expiresAt) writeLine(ctx.io.stdout, `expiresAt: ${r.expiresAt}`);
  return 0;
}

async function runErase(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 2) {
    write(ctx.io.stdout, 'Usage: openwop consent erase <orgId> <subjectKey> [--yes] [--json]\n');
    return options.help ? 0 : 2;
  }
  const [orgId, subjectKey] = positionals;
  if (!options.yes) {
    writeLine(ctx.io.stderr, `Refusing to erase subject ${subjectKey} (GDPR erasure is irreversible) without --yes.`);
    return 2;
  }
  const res = await consentRequest(ctx, `${ORG_BASE}/${encodeURIComponent(orgId)}/subjects/${encodeURIComponent(subjectKey)}`, { method: 'DELETE' });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const purged = res.body?.consentRecord === true;
  writeLine(ctx.io.stdout, `Erased subject ${subjectKey} (consent record ${purged ? 'purged' : 'absent'}; downstream feature data erased).`);
  return 0;
}

async function runPublicGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 2) {
    write(ctx.io.stdout, 'Usage: openwop consent public get <orgId> <subjectKey> [--json]\n');
    return options.help ? 0 : 2;
  }
  const [orgId, subjectKey] = positionals;
  // Public read is unauthed — resolves org→tenant host-side, gated on the toggle.
  const res = await consentRequest(ctx, `${PUB_BASE}/${encodeURIComponent(orgId)}/${encodeURIComponent(subjectKey)}`, { auth: false });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `recorded: ${b.recorded === true ? 'yes' : 'no'}`);
  if (b.recorded !== true && b.defaultMode) writeLine(ctx.io.stdout, `defaultMode: ${b.defaultMode}`);
  writeLine(ctx.io.stdout, `categories: ${renderCategories(b.categories)}`);
  if (b.region) writeLine(ctx.io.stdout, `region: ${b.region}`);
  return 0;
}

async function runPublicRecord(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--region'],
    multi: ['--category'],
  });
  if (options.help || positionals.length !== 2) {
    write(ctx.io.stdout, "Usage: openwop consent public record <orgId> <subjectKey> [--category <name=bool>]... [--region <r>] [--json]\n");
    return options.help ? 0 : 2;
  }
  const [orgId, subjectKey] = positionals;
  const categories: Record<string, boolean> = {};
  for (const entry of (Array.isArray(options.category) ? options.category : [])) {
    const eq = entry.indexOf('=');
    if (eq < 0) throw new CliError(`--category must be name=bool (got '${entry}')`, 2);
    const name = entry.slice(0, eq);
    const val = entry.slice(eq + 1).toLowerCase();
    if (val !== 'true' && val !== 'false') throw new CliError(`--category value must be true or false (got '${entry}')`, 2);
    categories[name] = val === 'true';
  }
  const body: Record<string, unknown> = { subjectKey, categories };
  if (options.region !== undefined) body.region = options.region;
  const res = await consentRequest(ctx, `${PUB_BASE}/${encodeURIComponent(orgId)}`, { method: 'POST', body, auth: false });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Recorded consent for ${subjectKey}: ${renderCategories(res.body?.categories)}`);
  return 0;
}

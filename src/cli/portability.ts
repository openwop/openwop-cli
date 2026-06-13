import type { Ctx } from '../context.js';
/** `openwop export` / `openwop import` — agent-platform portability (RFC 0098).
 *
 * Move reusable estate (agents, packs, schedules, rosters, templates) between
 * hosts as a portable BUNDLE. This module owns both portability commands (wired
 * as two dispatcher cases that share the bundle shapes + the secret redactor):
 *   GET  /v1/host/sample/export[?kinds=]        — produce an ExportBundle (refs only)
 *   POST /v1/host/sample/import?dryRun=true      — an ImportPlan (no writes)
 *   POST /v1/host/sample/import                  — apply → ImportResult
 *
 * Secrets are refs, never values (golden rule 3 / RFC 0098 §E(1)). The host
 * guarantees the export bundle carries NO credential material — only
 * `secretsToRebind` references — and rejects (422) an import bundle that smuggles
 * a literal credential value BEFORE applying. The CLI adds defense-in-depth: it
 * runs every response through a redactor before printing or writing to disk, so
 * even a misbehaving host can't leak a secret through this surface. `--dry-run`
 * previews creates/updates/skips/conflicts with zero writes (RFC 0098 §E(2)); the
 * import is idempotent + re-owns every entity to the caller's identity host-side.
 * Gated on `capabilities.portability` (advertised in /.well-known/openwop); fails
 * closed when absent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const EXPORT_HELP = `Usage:
  openwop export [--kinds <kind>]... [--out <file>] [--json]

Produce a portable ExportBundle of this tenant's reusable estate — agents, packs,
schedules, rosters, templates (RFC 0098). The bundle carries REFERENCES only: no
credential values ever travel in it, just \`secretsToRebind\` refs the operator
rebinds at the destination. Filter what's included with --kinds (repeatable).

The host produces the bundle; the CLI renders/saves what it returns and runs it
through a secret redactor first (defense-in-depth — the bundle is already
refs-only). Gated on \`capabilities.portability\`; fails closed when the host
doesn't advertise the surface.

  --kinds <kind>   Limit the export to a kind (repeatable): agent | pack | schedule | roster | template.
  --out <file>     Write the bundle JSON to a file instead of stdout.
  --json           Print the raw (redacted) bundle JSON to stdout.

Exit codes: 0 ok · 1 error / surface not served.

Examples:
  openwop export --json
  openwop export --kinds agent --kinds schedule --out estate.json
`;

export const IMPORT_HELP = `Usage:
  openwop import <bundle-file> [--dry-run] [--json]

Import a portable ExportBundle into this tenant (RFC 0098). ALWAYS dry-run first:
\`--dry-run\` returns a PLAN — what would be created / updated / skipped, and any
CONFLICTS — and makes ZERO writes. Without --dry-run the host applies the bundle
idempotently and re-owns every imported entity to your identity.

Secrets are refs, never values: the host rejects (422) a bundle that carries a
literal credential value before it applies anything; the CLI never prints secret
material (responses run through a redactor). The result reports \`secretsToRebind\`
references you bind via the host's credential flow afterward.

  --dry-run   Preview the plan (creates/updates/skips/conflicts); no writes.
  --json      Print the raw (redacted) plan/result JSON.

Exit codes:
  0  applied (or a clean dry-run plan)
  2  the plan has conflicts (nothing destructive was overwritten)
  1  error — e.g. the bundle carried a literal credential or a dependsOn cycle (422), or you lack import scope (403)

Examples:
  openwop import estate.json --dry-run        # preview first (no writes)
  openwop import estate.json                  # apply (idempotent, re-owned to you)
`;

const SECRET_KEY = /secret|token|password|private[-_]?key|client[-_]?secret|api[-_]?key|credential/i;
// Refs-only fields whose NAME trips SECRET_KEY (e.g. "secretsToRebind" contains
// "secret") but which carry references, never values, by RFC 0098 contract — keep
// them, but still recurse so any stray secret-named value INSIDE is caught.
const REF_ONLY_KEY = /^secretsToRebind$/;

/** Defense-in-depth: the bundle is refs-only by host contract, but never let a
 *  secret-named value reach stdout or disk through this surface. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && !REF_ONLY_KEY.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

async function ensureAdvertised(ctx: Ctx): Promise<void> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return; // can't prove absence — let the real request decide
  const body = wk.body && typeof wk.body === 'object' ? (wk.body as any) : {};
  const advertised = !!(body.capabilities?.portability ?? body.portability);
  if (!advertised) {
    throw new CliError(
      'portability: this host does not advertise the export/import capability (capabilities.portability is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
      1,
    );
  }
}

function gate404(err: unknown, verb: string): never {
  if (err instanceof HttpError && err.status === 404) {
    throw new CliError(
      `${verb}: the host does not mount /v1/host/sample/${verb} (the CLI renders the host's portability surface, it never fabricates a bundle).`,
      1,
    );
  }
  throw err;
}

// ---- export ----------------------------------------------------------------

export async function runExport(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--out'], multi: ['--kinds'] });
  if (options.help) {
    write(ctx.io.stdout, EXPORT_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  const kinds = Array.isArray(options.kinds) ? options.kinds : [];
  const path = kinds.length ? `/v1/host/sample/export?kinds=${encodeURIComponent(kinds.join(','))}` : '/v1/host/sample/export';
  let res;
  try {
    res = await requestJson(ctx, path);
  } catch (err) {
    gate404(err, 'export');
  }
  const bundle = redact(res!.body ?? {}) as any;
  if (options.out !== undefined) {
    const dest = resolve(ctx.cwd, options.out);
    writeFileSync(dest, `${JSON.stringify(bundle, null, 2)}\n`);
    writeLine(ctx.io.stdout, `✓ Wrote export bundle to ${dest} (${summarizeKinds(bundle)}; refs only, no secret values).`);
    return 0;
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, bundle);
    return 0;
  }
  const items = Array.isArray(bundle.items) ? bundle.items : [];
  if (items.length === 0) {
    writeLine(ctx.io.stdout, 'Export bundle is empty (no exportable estate for the requested kinds).');
    return 0;
  }
  const byKind: Record<string, number> = {};
  for (const it of items) byKind[it.kind ?? 'unknown'] = (byKind[it.kind ?? 'unknown'] ?? 0) + 1;
  const rows = Object.entries(byKind).map(([kind, count]) => ({ kind, count: String(count) }));
  writeLine(ctx.io.stdout, formatTable(rows, ['kind', 'count']));
  const rebind = Array.isArray(bundle.secretsToRebind) ? bundle.secretsToRebind : [];
  writeLine(ctx.io.stdout, `\nsecretsToRebind: ${rebind.length} reference(s)${rebind.length ? ` — ${rebind.map((r: any) => r.provider ?? r.ref ?? r).join(', ')}` : ''} (refs only — bind at the destination).`);
  if (bundle.source?.origin) writeLine(ctx.io.stdout, `source.origin: ${bundle.source.origin}`);
  return 0;
}

function summarizeKinds(bundle: any): string {
  const items = Array.isArray(bundle.items) ? bundle.items : [];
  return `${items.length} item(s)`;
}

// ---- import ----------------------------------------------------------------

export async function runImport(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--dry-run'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, IMPORT_HELP);
    return options.help ? 0 : 2;
  }
  let bundle: unknown;
  try {
    const raw = readFileSync(resolve(ctx.cwd, positionals[0]), 'utf8');
    bundle = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`import: could not read bundle file ${positionals[0]} — ${err instanceof Error ? err.message : 'invalid JSON'}`, 2);
  }
  await ensureAdvertised(ctx);
  const path = options.dryRun ? '/v1/host/sample/import?dryRun=true' : '/v1/host/sample/import';
  let res;
  try {
    res = await requestJson(ctx, path, { method: 'POST', body: bundle });
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      const detail = (err.body as { message?: string } | undefined)?.message
        ?? 'the bundle carried a literal credential value or a dependsOn cycle';
      throw new CliError(`import: the host refused the bundle (422) — ${detail}.`, 1);
    }
    if (err instanceof HttpError && err.status === 403) {
      throw new CliError(`import: the host refused the import (403) — you lack import scope (the host is the authority).`, 1);
    }
    gate404(err, 'import');
  }
  const out = redact(res!.body ?? {}) as any;
  if (ctx.json) {
    writeJson(ctx.io.stdout, out);
    return exitForImport(out);
  }
  return options.dryRun ? renderPlan(ctx, out) : renderResult(ctx, out);
}

/** 0 clean · 2 conflicts present (nothing overwritten). Used for both the
 *  dry-run plan and the applied result. */
function exitForImport(out: any): number {
  const conflicts = Array.isArray(out.conflicts) ? out.conflicts : (Array.isArray(out.items) ? out.items.filter((i: any) => i.result === 'conflict') : []);
  return conflicts.length > 0 ? 2 : 0;
}

function renderPlan(ctx: Ctx, plan: any): number {
  const creates = Array.isArray(plan.creates) ? plan.creates : [];
  const updates = Array.isArray(plan.updates) ? plan.updates : [];
  const skips = Array.isArray(plan.skips) ? plan.skips : [];
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
  writeLine(ctx.io.stdout, `Import plan (dry-run — no writes made):`);
  writeLine(ctx.io.stdout, `  create:   ${creates.length}`);
  writeLine(ctx.io.stdout, `  update:   ${updates.length}`);
  writeLine(ctx.io.stdout, `  skip:     ${skips.length}`);
  writeLine(ctx.io.stdout, `  conflict: ${conflicts.length}`);
  if (conflicts.length) {
    writeLine(ctx.io.stdout, `\nConflicts (resolve before applying — nothing will be overwritten):`);
    for (const c of conflicts) writeLine(ctx.io.stdout, `  · ${c.kind ?? ''} ${c.id ?? c.key ?? ''}${c.reason ? `: ${c.reason}` : ''}`);
  }
  const rebind = Array.isArray(plan.secretsToRebind) ? plan.secretsToRebind : [];
  if (rebind.length) writeLine(ctx.io.stdout, `\nsecretsToRebind after apply: ${rebind.length} reference(s) (refs only).`);
  return exitForImport(plan);
}

function renderResult(ctx: Ctx, result: any): number {
  const items = Array.isArray(result.items) ? result.items : [];
  const counts = result.counts ?? tally(items);
  writeLine(ctx.io.stdout, `Import applied (idempotent; entities re-owned to you):`);
  writeLine(ctx.io.stdout, `  created: ${counts.created ?? 0}`);
  writeLine(ctx.io.stdout, `  updated: ${counts.updated ?? 0}`);
  writeLine(ctx.io.stdout, `  skipped: ${counts.skipped ?? 0}`);
  if (counts.conflict) writeLine(ctx.io.stdout, `  conflict: ${counts.conflict}`);
  if (counts.failed) writeLine(ctx.io.stdout, `  failed: ${counts.failed}`);
  const rebind = Array.isArray(result.secretsToRebind) ? result.secretsToRebind : [];
  writeLine(ctx.io.stdout, `\nsecretsToRebind: ${rebind.length} reference(s)${rebind.length ? ` — ${rebind.map((r: any) => r.provider ?? r.ref ?? r).join(', ')}` : ''} (bind via the host's credential flow).`);
  return exitForImport(result);
}

function tally(items: any[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const it of items) c[it.result ?? 'unknown'] = (c[it.result ?? 'unknown'] ?? 0) + 1;
  return { created: c.created ?? 0, updated: c.updated ?? 0, skipped: c.skipped ?? 0, conflict: c.conflict ?? 0, failed: c.failed ?? 0 };
}

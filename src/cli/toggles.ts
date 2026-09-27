import type { Ctx } from '../context.js';
/** `openwop toggles ...` — render the host's resolved feature-toggle assignments (host-extension). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { gatedRequest, readBodyOption, arrayOf } from './adminShared.js';

const TOGGLES_BASE = '/v1/host/openwop-app/feature-toggles';

export const TOGGLES_HELP = `Usage:
  openwop toggles list [--json]
  openwop toggles get <toggleId> [--json]

  Super-admin configuration:
  openwop toggles admin list [--json]
  openwop toggles admin get <toggleId> [--json]
  openwop toggles admin features [--json]
  openwop toggles admin env-governed [--json]
  openwop toggles admin set <toggleId> [--status on|off|beta] [--body <json> | --body-file <path>] [--json]
  openwop toggles admin reset <toggleId> --yes [--json]

Render the caller's RESOLVED feature-toggle assignments (sample host extension under
${TOGGLES_BASE}/assignments). This is a NON-NORMATIVE vendor surface — not part of the
openwop wire contract and not advertised in /.well-known/openwop.

CAPABILITY HONESTY (critical): the HOST is the sole authority for toggle/variant
resolution — it runs server-side from the authenticated principal. This command only
RENDERS the host's resolved view (status / enabled / variant / bindings, verbatim). It
NEVER computes, asserts, or overrides a toggle decision locally. If the host doesn't serve
the surface the command fails closed legibly (exit 2).

The \`admin\` family drives the SUPER-ADMIN configuration surface (${TOGGLES_BASE}/admin/*).
It edits the host's stored config; the host still resolves every assignment. Without a
super-admin principal it fails closed with exit 4 and says how to get one.
  admin list          GET    /admin/configs          every toggle's effective config
  admin get <id>      GET    /admin/configs/:id      one config (+ overridden / defaultDrift)
  admin features      GET    /admin/features         the feature console (dependencies, state)
  admin env-governed  GET    /admin/env-governed     capabilities governed by server env vars (read-only)
  admin set <id>      PUT    /admin/configs/:id      READ-MODIFY-WRITE: fetches the current config,
                                                     applies --status and/or merges --body, PUTs the
                                                     whole config (the host REPLACES on write). The
                                                     host refuses (409) to disable a toggle an enabled
                                                     feature depends on, naming the dependents.
  admin reset <id>    DELETE /admin/configs/:id      drop the stored override → back to the code default

  list            'GET /assignments' — every toggle's resolved state for the caller (incl. off).
  get <toggleId>  'GET /assignments/:id' — one toggle's resolved assignment.

Resolved fields (host-authored): status (on | off | beta) · enabled (bool) · variant (key | none)
· bindings (slot → ref@version for the assigned variant, when present).

Exit codes: 0 ok · 1 host error · 2 usage error / surface not served / unknown toggle /
            dependency conflict · 4 not a super-admin (admin family).

Examples:
  openwop toggles list
  openwop toggles list --json
  openwop toggles get crm.triageAgent
  openwop toggles admin set crm --status beta
  openwop toggles admin set crm --body '{"variants":[{"key":"A","weight":50},{"key":"B","weight":50}]}'
  openwop toggles admin reset crm --yes
`;

// Probe + fail closed: a 404 on the assignments COLLECTION means the host doesn't serve the
// toggle surface — render that legibly instead of a bare HTTP 404. (A 404 on a specific
// :id is a legitimate "no such toggle", handled at the call site.)
async function togglesRequest(ctx: Ctx, path: string) {
  try {
    return await requestJson(ctx, path);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404 && path.endsWith('/assignments')) {
      throw new CliError(
        `Host does not serve the feature-toggle surface at ${TOGGLES_BASE} (non-normative host extension — not enabled). Failing closed.`,
        2,
      );
    }
    throw err;
  }
}

export async function runToggles(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, TOGGLES_HELP);
    return 0;
  }
  switch (sub) {
    case 'list':
      return await runTogglesList(ctx, argv.slice(1));
    case 'get':
      return await runTogglesGet(ctx, argv.slice(1));
    case 'admin':
      return await runTogglesAdmin(ctx, argv.slice(1));
    default:
      throw new CliError(`Unknown toggles command: ${sub}\nRun \`openwop toggles --help\` for usage.`);
  }
}

async function runTogglesList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, TOGGLES_HELP);
    return 0;
  }
  const res = await togglesRequest(ctx, `${TOGGLES_BASE}/assignments`);
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const assignments = Array.isArray(res.body?.assignments) ? res.body.assignments : [];
  if (assignments.length === 0) {
    writeLine(ctx.io.stdout, 'No feature toggles resolved for this caller.');
    return 0;
  }
  // Render the host's resolved fields verbatim — no local derivation of enabled/variant.
  const rows = assignments.map((a: any) => ({
    id: a.id,
    status: a.status ?? '',
    enabled: a.enabled === true ? 'yes' : a.enabled === false ? 'no' : '',
    variant: a.variant ?? '—',
    bindings: Array.isArray(a.bindings) ? String(a.bindings.length) : '0',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['id', 'status', 'enabled', 'variant', 'bindings']));
  return 0;
}

async function runTogglesGet(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop toggles get <toggleId> [--json]\n');
    return options.help ? 0 : 2;
  }
  let res;
  try {
    res = await togglesRequest(ctx, `${TOGGLES_BASE}/assignments/${encodeURIComponent(positionals[0])}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(`No such feature toggle: ${positionals[0]}`, 2);
    }
    throw err;
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const a = res.body ?? {};
  writeLine(ctx.io.stdout, `id: ${a.id ?? positionals[0]}`);
  writeLine(ctx.io.stdout, `status: ${a.status ?? ''}`);
  writeLine(ctx.io.stdout, `enabled: ${a.enabled === true ? 'yes' : a.enabled === false ? 'no' : ''}`);
  writeLine(ctx.io.stdout, `variant: ${a.variant ?? '(none)'}`);
  if (Array.isArray(a.bindings) && a.bindings.length) {
    writeLine(ctx.io.stdout, 'bindings:');
    for (const b of a.bindings) {
      const ref = b?.ref ?? {};
      writeLine(ctx.io.stdout, `  ${b?.slot ?? '?'} → ${ref.kind ?? '?'}:${ref.name ?? '?'}@${ref.version ?? '?'}`);
    }
  }
  return 0;
}

const ADMIN_SURFACE = 'Feature-toggle administration';
const OVERLAY_FIELDS = ['overridden', 'defaultDrift', 'label', 'description', 'category'];

async function runTogglesAdmin(ctx: Ctx, argv: string[]) {
  const verb = argv[0] ?? 'list';
  if (verb === '--help' || verb === '-h') { write(ctx.io.stdout, TOGGLES_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help', '--yes'], value: ['--status', '--body', '--body-file'] });
  if (options.help) { write(ctx.io.stdout, TOGGLES_HELP); return 0; }
  const admin = `${TOGGLES_BASE}/admin`;
  const emit = (body: any, human: () => void) => { if (ctx.json) writeJson(ctx.io.stdout, body); else human(); };
  switch (verb) {
    case 'list': {
      const res = await gatedRequest(ctx, `${admin}/configs`, undefined, ADMIN_SURFACE, 'superadmin');
      emit(res.body, () => {
        const configs = arrayOf(res.body, 'configs');
        if (configs.length === 0) { writeLine(ctx.io.stdout, 'No feature toggles declared.'); return; }
        writeLine(ctx.io.stdout, formatTable(configs.map((c: any) => ({
          id: c.id, status: c.status ?? '', variants: Array.isArray(c.variants) ? c.variants.map((v: any) => `${v.key}:${v.weight}`).join(',') : '',
          overridden: c.overridden ? 'yes' : '', drift: c.defaultDrift ? 'yes' : '',
        })), ['id', 'status', 'variants', 'overridden', 'drift']));
      });
      return 0;
    }
    case 'get': {
      if (!positionals[0]) throw new CliError('Usage: openwop toggles admin get <toggleId>', 2);
      const res = await gatedRequest(ctx, `${admin}/configs/${encodeURIComponent(positionals[0])}`, undefined, ADMIN_SURFACE, 'superadmin');
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'features': {
      const res = await gatedRequest(ctx, `${admin}/features`, undefined, ADMIN_SURFACE, 'superadmin');
      emit(res.body, () => {
        const features = arrayOf(res.body, 'features');
        const list = (v: unknown) => (Array.isArray(v) ? v.join(',') : '');
        writeLine(ctx.io.stdout, formatTable(features.map((f: any) => ({
          id: f.id ?? '', dependsOn: list(f.dependsOn), dependents: list(f.dependents),
          blockedBy: list(f.blockedByDependents), packs: Array.isArray(f.packs) ? String(f.packs.length) : '0',
        })), ['id', 'dependsOn', 'dependents', 'blockedBy', 'packs']));
      });
      return 0;
    }
    case 'env-governed': {
      const res = await gatedRequest(ctx, `${admin}/env-governed`, undefined, ADMIN_SURFACE, 'superadmin');
      emit(res.body, () => {
        for (const c of arrayOf(res.body, 'capabilities')) {
          writeLine(ctx.io.stdout, `${c.id} (${c.envVar}): ${c.enabled ? 'on' : 'off'}`);
          for (const l of Array.isArray(c.levers) ? c.levers : []) writeLine(ctx.io.stdout, `  ${l.id} (${l.envVar}): ${l.enabled ? 'on' : 'off'}`);
        }
      });
      return 0;
    }
    case 'set': {
      const id = positionals[0];
      const patch = readBodyOption(ctx, options) ?? {};
      if (options.status !== undefined) {
        if (!['on', 'off', 'beta'].includes(options.status)) throw new CliError('--status must be on, off, or beta.', 2);
        patch.status = options.status;
      }
      if (!id || Object.keys(patch).length === 0) throw new CliError('Usage: openwop toggles admin set <toggleId> [--status on|off|beta] [--body <json> | --body-file <path>]', 2);
      const path = `${admin}/configs/${encodeURIComponent(id)}`;
      const current = await gatedRequest(ctx, path, undefined, ADMIN_SURFACE, 'superadmin');
      const base: Record<string, any> = { ...(current.body ?? {}) };
      for (const k of OVERLAY_FIELDS) delete base[k];
      const res = await gatedRequest(ctx, path, { method: 'PUT', body: { ...base, ...patch, id } }, ADMIN_SURFACE, 'superadmin');
      emit(res.body, () => writeLine(ctx.io.stdout, `Saved ${res.body?.id ?? id}: status ${res.body?.status ?? '?'}${Array.isArray(res.body?.variants) && res.body.variants.length ? `, ${res.body.variants.length} variant(s)` : ''}.`));
      return 0;
    }
    case 'reset': {
      const id = positionals[0];
      if (!id) throw new CliError('Usage: openwop toggles admin reset <toggleId> --yes', 2);
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to reset ${id} to its code default without --yes.`); return 2; }
      const res = await gatedRequest(ctx, `${admin}/configs/${encodeURIComponent(id)}`, { method: 'DELETE' }, ADMIN_SURFACE, 'superadmin');
      emit(res.body, () => writeLine(ctx.io.stdout, `Reset ${id} to its code default (status ${res.body?.status ?? '?'}).`));
      return 0;
    }
    default:
      throw new CliError(`Unknown toggles admin command: ${verb}\nRun \`openwop toggles --help\` for usage.`);
  }
}

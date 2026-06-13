import type { Ctx } from '../context.js';
/** `openwop toggles ...` — render the host's resolved feature-toggle assignments (host-extension). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const TOGGLES_BASE = '/v1/host/sample/feature-toggles';

export const TOGGLES_HELP = `Usage:
  openwop toggles list [--json]
  openwop toggles get <toggleId> [--json]

Render the caller's RESOLVED feature-toggle assignments (sample host extension under
${TOGGLES_BASE}/assignments). This is a NON-NORMATIVE vendor surface — not part of the
openwop wire contract and not advertised in /.well-known/openwop.

CAPABILITY HONESTY (critical): the HOST is the sole authority for toggle/variant
resolution — it runs server-side from the authenticated principal. This command only
RENDERS the host's resolved view (status / enabled / variant / bindings, verbatim). It
NEVER computes, asserts, or overrides a toggle decision locally, and it does not author
config (the superadmin /admin/configs surface is intentionally not exposed here). If the
host doesn't serve the surface the command fails closed legibly (exit 2).

  list            'GET /assignments' — every toggle's resolved state for the caller (incl. off).
  get <toggleId>  'GET /assignments/:id' — one toggle's resolved assignment.

Resolved fields (host-authored): status (on | off | beta) · enabled (bool) · variant (key | none)
· bindings (slot → ref@version for the assigned variant, when present).

Exit codes: 0 ok · 1 host error · 2 usage error / surface not served / unknown toggle.

Examples:
  openwop toggles list
  openwop toggles list --json
  openwop toggles get crm.triageAgent
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

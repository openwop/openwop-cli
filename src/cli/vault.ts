import type { Ctx } from '../context.js';
/**
 * `openwop vault ...` — the super-admin secrets vault (host extension, openwop-app
 * `routes/adminVault.ts`; ADR 0024 delegated credentials, ADR 0176 host-global
 * Stripe refs). One inventory of every credential REF the host holds — tenant
 * secrets, host-global secrets, OAuth connections, OAuth clients, developer keys.
 *
 * SECRET BOUNDARY: refs and status only. `set`/`rotate` send a value the operator
 * supplies (file or no-echo prompt — never argv); nothing here ever prints one.
 * The host's `/reveal` route is deliberately NOT driven (see help).
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { gatedRequest, readSecretInput } from './adminShared.js';

const BASE = '/v1/host/openwop-app/vault';
const SURFACE = 'The secrets vault';

export const VAULT_HELP = `Usage:
  openwop vault list [--json]
  openwop vault set <credentialRef> [--scope tenant|host] [--value-file <path>] [--json]
  openwop vault rotate <credentialRef> [--scope tenant|host] [--value-file <path>] [--json]
  openwop vault delete <credentialRef> [--scope tenant|host] [--force] --yes [--json]

The super-admin secrets vault (host extension). Every route is SUPER-ADMIN gated:
without a super-admin principal the command fails closed with exit 4 and says how to
get one (OPENWOP_SUPERADMIN_TENANTS on the server).

  list     GET    ${BASE}                                  inventory of refs (never values)
  set      POST   ${BASE}/secrets                          store a new secret under a ref
  rotate   POST   ${BASE}/secrets/:credentialRef/rotate    overwrite an EXISTING secret
  delete   DELETE ${BASE}/secrets/:credentialRef           remove (refused while the ref has live consumers unless --force)

SECRETS ARE REFS, NEVER VALUES. The value for set/rotate is read from --value-file or a
no-echo prompt (a piped line also works) — never from a command-line flag. The host's
POST /vault/secrets/:ref/reveal route is intentionally NOT exposed: it returns plaintext,
and this CLI never prints a secret. Use the in-app vault (with a fresh sign-in) to reveal.
\`connection:*\` refs belong to the connections lifecycle and are refused by the host.

  --scope tenant|host  tenant (default) = the signed-in workspace's bucket; host = the
                       host-global bucket (e.g. billing:stripe-key).
  --value-file <path>  Read the secret from a file (a trailing newline is trimmed).
  --force              (delete) Delete even when the host reports live or unknown consumers.
  --yes                (delete) Required confirmation.

Exit codes: 0 ok · 2 usage / validation / conflict · 4 not a super-admin.

Examples:
  openwop vault list
  openwop vault set billing:stripe-key --scope host --value-file ./stripe.key
  openwop vault rotate slack-bot --value-file ./new-token
  openwop vault delete old-key --yes
`;

export async function runVault(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, VAULT_HELP); return 0; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': return await vaultList(ctx, rest);
    case 'set': return await vaultWrite(ctx, rest, 'set');
    case 'rotate': return await vaultWrite(ctx, rest, 'rotate');
    case 'delete': return await vaultDelete(ctx, rest);
    case 'reveal':
      throw new CliError('`vault reveal` is not available: this CLI never prints a secret value. Reveal it in the app\'s vault page after a fresh sign-in.', 2);
    default:
      throw new CliError(`Unknown vault command: ${sub}\nRun \`openwop vault --help\` for usage.`);
  }
}

function scopeOf(options: Record<string, any>): 'tenant' | 'host' {
  const s = options.scope ?? 'tenant';
  if (s !== 'tenant' && s !== 'host') throw new CliError('--scope must be tenant or host.', 2);
  return s;
}

async function vaultList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, VAULT_HELP); return 0; }
  const res = await gatedRequest(ctx, BASE, undefined, SURFACE, 'superadmin');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  const rows: any[] = [
    ...(b.tenantSecrets ?? []).map((s: any) => ({ scope: 'tenant', ref: s.credentialRef, kind: s.kind ?? '', status: '' })),
    ...(b.hostSecrets ?? []).map((s: any) => ({ scope: 'host', ref: s.credentialRef, kind: s.kind ?? '', status: '' })),
    ...(b.connections ?? []).map((c: any) => ({ scope: 'tenant', ref: `connection:${c.connectionId}`, kind: `connection/${c.provider ?? '?'}`, status: c.status ?? '' })),
    ...(b.oauthClients ?? []).map((c: any) => ({ scope: 'host', ref: `oauth-client:${c.provider ?? '?'}`, kind: 'oauth-client', status: c.configured === false ? 'unconfigured' : 'configured' })),
    ...(b.apiKeys ?? []).map((k: any) => ({ scope: 'tenant', ref: k.keyId ?? '', kind: 'developer-key', status: k.revokedAt ? 'revoked' : 'active' })),
  ];
  if (rows.length === 0) { writeLine(ctx.io.stdout, 'The vault is empty.'); return 0; }
  writeLine(ctx.io.stdout, formatTable(rows, ['scope', 'ref', 'kind', 'status']));
  return 0;
}

async function vaultWrite(ctx: Ctx, argv: string[], verb: 'set' | 'rotate') {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--scope', '--value-file'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, `Usage: openwop vault ${verb} <credentialRef> [--scope tenant|host] [--value-file <path>] [--json]\n`);
    return options.help ? 0 : 2;
  }
  const ref = positionals[0];
  const scope = scopeOf(options);
  const value = await readSecretInput(ctx, options, `Secret value for "${ref}"`);
  const body: Record<string, any> = { value, ...(scope === 'host' ? { scope: 'host' } : {}) };
  const path = verb === 'set' ? `${BASE}/secrets` : `${BASE}/secrets/${encodeURIComponent(ref)}/rotate`;
  if (verb === 'set') body.credentialRef = ref;
  const res = await gatedRequest(ctx, path, { method: 'POST', body }, SURFACE, 'superadmin');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, verb === 'set' ? `Stored ${ref} (${scope} scope).` : `Rotated ${ref} (${scope} scope).`);
  return 0;
}

async function vaultDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes', '--force'], value: ['--scope'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop vault delete <credentialRef> [--scope tenant|host] [--force] --yes [--json]\n');
    return options.help ? 0 : 2;
  }
  if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete ${positionals[0]} without --yes.`); return 2; }
  const qs = new URLSearchParams();
  if (scopeOf(options) === 'host') qs.set('scope', 'host');
  if (options.force) qs.set('force', 'true');
  const q = qs.toString() ? `?${qs}` : '';
  const res = await gatedRequest(ctx, `${BASE}/secrets/${encodeURIComponent(positionals[0])}${q}`, { method: 'DELETE' }, SURFACE, 'superadmin');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Deleted ${positionals[0]}.`);
  return 0;
}

import type { Ctx } from '../context.js';
/** `openwop auth ...` (alias `sso`) — enterprise SSO/SAML/SCIM identity config (RFC 0050). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest, probeEndpoint } from '../api.js';

export const AUTH_HELP = `Usage:
  openwop auth status [--json]
  openwop auth saml metadata [--json]
  openwop auth saml login-url [--return-to <path>] [--json]
  openwop auth saml validate --idp-url <url> --variant <name> [--json]
  openwop auth scim provision --op <create-user|assign-group|deactivate-user>
                              [--user-name <u>] [--external-id <id>] [--email <e>] [--display-name <n>] [--group <g>] [--json]

Enterprise identity-provider configuration (RFC 0050): SAML 2.0 SSO + SCIM 2.0
provisioning. The host is the authority — this command surfaces status, public SP
metadata, and provisioning results; every auth surface 404s when the host has not
configured it (SAML/SCIM are env-gated host-side), and the command fails closed
legibly in that case.

SECRET BOUNDARY (critical): SAML signing certs, SCIM bearer tokens, and client
secrets are HOST-SIDE only — they are never returned, printed, or logged. The CLI
additionally runs every host response through a recursive redactor before printing,
so a secret-looking field can never leak even if a host returns one by mistake.
(SP metadata XML is the exception — it is PUBLIC by design, meant to be uploaded to
your IdP, and contains only the SP's public certificate.)

BOUNDARY: \`auth\` is SSO/SAML/SCIM identity-provider config (hits /v1/host/sample/auth/*).
It is NOT the user directory (\`users\`), NOT RBAC (\`orgs\`), and NOT BYOK provider
credentials (\`byok\`/\`providers\`).

Subcommands → endpoint:
  status        GET  /.well-known/openwop + probe   Which auth profiles this host advertises/serves.
  saml metadata GET  /auth/saml/sso/metadata        SP metadata XML (upload to your IdP).
  saml login-url GET /auth/saml/sso/login           The SP-initiated IdP redirect URL (not followed).
  saml validate POST /auth/saml/validate            Conformance seam: validate a synthetic-IdP assertion.
  scim provision POST /auth/scim/provision          Provisioning seam: create/assign-group/deactivate.

  --return-to <path>   (saml login-url) Same-site return path after login (default /).
  --idp-url <url>      (saml validate) The operator-configured synthetic IdP origin.
  --variant <name>     (saml validate) The assertion variant to fetch + validate.
  --op <op>            (scim provision) create-user | assign-group | deactivate-user.
  --user-name/--external-id/--email/--display-name/--group  (scim provision) SCIM user/group fields.

Exit codes: 0 success (saml validate: 0 = authenticated) · 1 host/HTTP error or not configured
            (saml validate: 1 = rejected) · 2 usage error.

Examples:
  openwop auth status
  openwop auth saml metadata
  openwop auth saml login-url --return-to /dashboard
  openwop auth saml validate --idp-url http://localhost:9100/idp --variant valid
  openwop auth scim provision --op create-user --user-name jo@acme.com --email jo@acme.com
`;

const BASE = '/v1/host/sample/auth';

// Belt-and-suspenders: never emit a secret-looking field, even if a host returns
// one. `cert`/`assertion`/`pem`/`bearer` join the connections-group list because
// SAML certs and assertions are sensitive. SP metadata XML is printed raw (public).
const SECRET_KEY = /secret|token|password|private[-_]?key|client[-_]?secret|api[-_]?key|credential|bearer|assertion|certificate|cert|pem/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

/** Map the host's "not configured" 404 onto a legible fail-closed error. */
async function authRequest(ctx: Ctx, path: string, options: Parameters<typeof requestJson>[2] | undefined, notConfiguredMsg: string) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError(notConfiguredMsg, 1);
    }
    throw err;
  }
}

export async function runAuth(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'status';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, AUTH_HELP);
    return 0;
  }
  if (sub === 'saml') {
    const psub = argv[1] ?? '';
    const rest = argv.slice(2);
    if (psub === 'metadata') return await runSamlMetadata(ctx, rest);
    if (psub === 'login-url') return await runSamlLoginUrl(ctx, rest);
    if (psub === 'validate') return await runSamlValidate(ctx, rest);
    throw new CliError(`Unknown auth saml command: ${psub || '(none)'}\nRun \`openwop auth --help\` for usage.`);
  }
  if (sub === 'scim') {
    const psub = argv[1] ?? '';
    if (psub === 'provision') return await runScimProvision(ctx, argv.slice(2));
    throw new CliError(`Unknown auth scim command: ${psub || '(none)'}\nRun \`openwop auth --help\` for usage.`);
  }
  if (sub === 'status') return await runStatus(ctx, argv.slice(1));
  throw new CliError(`Unknown auth command: ${sub}\nRun \`openwop auth --help\` for usage.`);
}

async function runStatus(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop auth status [--json]\n'); return 0; }
  // Discovery is authoritative for what the host advertises (never throws).
  const disc = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  const profiles: string[] = disc.ok && Array.isArray(disc.body?.capabilities?.auth?.profiles)
    ? disc.body.capabilities.auth.profiles
    : [];
  const samlAdvertised = profiles.includes('openwop-auth-saml');
  const scimAdvertised = profiles.includes('openwop-auth-scim');
  // Discovery is the AUTHORITY for what the host serves. Only when SAML is advertised
  // do we probe the SP-metadata endpoint to distinguish a real SSO deployment (SP
  // metadata reachable) from the conformance-only test seam (advertised, no SP). We do
  // NOT probe an unadvertised profile: a host's SPA catch-all can 200 any path, which
  // would dishonestly report a surface as live that the host never claimed.
  const metaReachable = samlAdvertised ? (await probeEndpoint(ctx, `${BASE}/saml/sso/metadata`)).ok : false;
  if (ctx.json) {
    writeJson(ctx.io.stdout, {
      authProfilesAdvertised: profiles,
      saml: { advertised: samlAdvertised, ssoMetadataReachable: metaReachable },
      scim: { advertised: scimAdvertised },
    });
    return 0;
  }
  const rows = [
    { surface: 'SAML SSO (login/ACS/metadata)', advertised: samlAdvertised ? 'yes' : 'no', live: !samlAdvertised ? 'no' : (metaReachable ? 'yes' : 'seam-only') },
    { surface: 'SCIM provisioning', advertised: scimAdvertised ? 'yes' : 'no', live: scimAdvertised ? '—' : 'no' },
  ];
  writeLine(ctx.io.stdout, formatTable(rows, ['surface', 'advertised', 'live']));
  if (!samlAdvertised && !scimAdvertised) {
    writeLine(ctx.io.stdout, 'This host advertises no enterprise-auth profiles (SAML/SCIM are env-gated host-side).');
  }
  return 0;
}

async function runSamlMetadata(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop auth saml metadata [--json]\n'); return 0; }
  // SP metadata is served as application/xml; requestJson wraps non-JSON as {raw}.
  const res = await authRequest(ctx, `${BASE}/saml/sso/metadata`, { auth: false }, 'SAML SSO is not configured on this host (set OPENWOP_SAML_*).');
  const xml = typeof res.body?.raw === 'string' ? res.body.raw : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
  if (ctx.json) { writeJson(ctx.io.stdout, { metadata: xml }); return 0; }
  // PUBLIC SP metadata (meant to be uploaded to the IdP) — printed verbatim.
  write(ctx.io.stdout, xml.endsWith('\n') ? xml : `${xml}\n`);
  return 0;
}

async function runSamlLoginUrl(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--return-to'] });
  if (options.help) { write(ctx.io.stdout, 'Usage: openwop auth saml login-url [--return-to <path>] [--json]\n'); return 0; }
  const returnTo = options.returnTo ?? '/';
  // The login route 302-redirects to the IdP; capture the Location WITHOUT following
  // it (the CLI can't complete a browser SSO flow — it just surfaces the URL).
  const base = ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`;
  const url = new URL(`${BASE}/saml/sso/login?returnTo=${encodeURIComponent(returnTo)}`.replace(/^\//, ''), base);
  const res = await ctx.fetchImpl(url, { method: 'GET', redirect: 'manual' });
  if (res.status === 404) {
    throw new CliError('SAML SSO is not configured on this host (set OPENWOP_SAML_*).', 1);
  }
  const location = res.headers.get('location');
  if (!location) {
    throw new CliError(`Expected a redirect to the IdP but got HTTP ${res.status} with no Location header.`, 1);
  }
  if (ctx.json) { writeJson(ctx.io.stdout, { loginUrl: location }); return 0; }
  writeLine(ctx.io.stdout, location);
  return 0;
}

async function runSamlValidate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--idp-url', '--variant'] });
  if (options.help || options.idpUrl === undefined || options.variant === undefined) {
    write(ctx.io.stdout, 'Usage: openwop auth saml validate --idp-url <url> --variant <name> [--json]\n');
    return options.help ? 0 : 2;
  }
  const body = { idpUrl: options.idpUrl, variant: options.variant };
  let res;
  try {
    res = await requestJson(ctx, `${BASE}/saml/validate`, { method: 'POST', body });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new CliError('SAML validation seam not configured on this host (set OPENWOP_TEST_SAML_IDP_URL).', 1);
    }
    // A rejected assertion is a 401 with {authenticated:false, reason}; surface it
    // as a first-class result (exit 1), not an opaque HTTP error.
    if (err instanceof HttpError && err.status === 401) {
      const reason = (err.body as { reason?: string })?.reason ?? 'unauthenticated';
      if (ctx.json) { writeJson(ctx.io.stdout, redact({ authenticated: false, reason })); return 1; }
      writeLine(ctx.io.stdout, `authenticated: no (${reason})`);
      return 1;
    }
    throw err;
  }
  const safe = redact(res.body ?? {}) as any;
  if (ctx.json) { writeJson(ctx.io.stdout, safe); return 0; }
  writeLine(ctx.io.stdout, `authenticated: ${safe.authenticated === true ? 'yes' : 'no'}`);
  if (safe.principal !== undefined) writeLine(ctx.io.stdout, `principal: ${typeof safe.principal === 'string' ? safe.principal : JSON.stringify(safe.principal)}`);
  return safe.authenticated === true ? 0 : 1;
}

async function runScimProvision(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--op', '--user-name', '--external-id', '--email', '--display-name', '--group'],
  });
  const OPS = ['create-user', 'assign-group', 'deactivate-user'];
  if (options.help || options.op === undefined) {
    write(ctx.io.stdout, 'Usage: openwop auth scim provision --op <create-user|assign-group|deactivate-user> [--user-name <u>] [--external-id <id>] [--email <e>] [--display-name <n>] [--group <g>] [--json]\n');
    return options.help ? 0 : 2;
  }
  if (!OPS.includes(options.op)) throw new CliError(`--op must be one of ${OPS.join(', ')}`, 2);
  const user: Record<string, string> = {};
  if (options.userName !== undefined) user.userName = options.userName;
  if (options.externalId !== undefined) user.externalId = options.externalId;
  if (options.email !== undefined) user.email = options.email;
  if (options.displayName !== undefined) user.displayName = options.displayName;
  const body: Record<string, unknown> = { op: options.op, user };
  if (options.group !== undefined) body.group = options.group;
  const res = await authRequest(ctx, `${BASE}/scim/provision`, { method: 'POST', body }, 'SCIM provisioning seam not configured on this host (set OPENWOP_TEST_SCIM_URL).');
  const safe = redact(res.body ?? {}) as any;
  if (ctx.json) { writeJson(ctx.io.stdout, safe); return 0; }
  writeLine(ctx.io.stdout, `op: ${safe.op ?? options.op}`);
  if (safe.principal) {
    const p = safe.principal;
    writeLine(ctx.io.stdout, `principal: ${p.userName ?? p.userId ?? ''}${p.status ? ` (${p.status})` : ''}`);
    if (Array.isArray(p.groups)) writeLine(ctx.io.stdout, `groups: ${p.groups.length ? p.groups.join(', ') : '(none)'}`);
  }
  if (safe.resolvable !== undefined) writeLine(ctx.io.stdout, `resolvable: ${safe.resolvable ? 'yes' : 'no'}`);
  return 0;
}

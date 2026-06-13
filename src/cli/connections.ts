import type { Ctx } from '../context.js';
/** `openwop connections ...` — inspect host connections + their OAuth client config.
 *
 * Drives the connections feature (sample host-extension, ADR 0024):
 *   GET  /v1/host/sample/connections                      — the connection list
 *   POST /v1/host/sample/connections/{id}/test            — health-probe one
 *   POST /v1/host/sample/connections/{provider}/authorize — mint a consent URL
 *   GET  /v1/host/sample/connections-oauth-clients         — host OAuth client config
 *
 * SECRET BOUNDARY (the whole point of being careful here): OAuth client secrets,
 * access/refresh tokens and stored credentials are HOST-SIDE only. The host never
 * returns them — and to stay honest even if a host misbehaves, the CLI runs every
 * response through a recursive redactor before printing. This group surfaces
 * REFS + STATUS, never values, and never completes an OAuth round-trip in the CLI
 * (authorize returns the URL; the browser + host callback do the exchange).
 *
 * The host is the authority: we render its resolved view, capability-gate against
 * its advertisement, and fail closed legibly when the surface isn't offered.
 */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson, safeRequest } from '../api.js';

export const CONNECTIONS_HELP = `Usage:
  openwop connections list [--json]
  openwop connections get <connectionId> [--json]
  openwop connections test <connectionId> [--json]
  openwop connections authorize <provider> [--scope <s>]... [--write] [--return-to <url>] [--json]
  openwop connections oauth-clients list [--json]
  openwop connections oauth-clients get <provider> [--json]

Inspect the host's third-party connections and their OAuth client configuration
(ADR 0024). \`list\`/\`get\` render connection metadata + status; \`test\` health-probes
one credential (the host refreshes OAuth on the way); \`authorize\` mints a consent
URL for a provider — it returns the URL only, the CLI never completes the OAuth
exchange. \`oauth-clients\` shows the host-configured OAuth apps (superadmin).

SECRET BOUNDARY: client secrets and tokens are host-side and are NEVER returned,
printed, or logged — only refs and status. The CLI additionally redacts any
secret-looking field defensively before printing.

The host is the authority — the CLI renders its resolved view and fails closed if
the connections surface isn't advertised (/.well-known/openwop).

Endpoints:
  list           GET  /v1/host/sample/connections
  get            GET  /v1/host/sample/connections  (filtered to <id> client-side;
                 the host exposes no single-connection GET)
  test           POST /v1/host/sample/connections/{id}/test
  authorize      POST /v1/host/sample/connections/{provider}/authorize
  oauth-clients  GET  /v1/host/sample/connections-oauth-clients[/{provider} filtered]

  --scope <s>     (authorize) An OAuth scope to request (repeatable).
  --write         (authorize) Request write scopes (re-consent for write access).
  --return-to <u> (authorize) Where the host should bounce the browser back to.
  --json          Print the (redacted) raw host response instead of the table.

Exit codes:
  list/get/authorize/oauth-clients  0 ok · 2 usage · 1 not-found/error
  test                              0 connection healthy · 1 unhealthy/error

Examples:
  openwop connections list
  openwop connections get conn:abc --json
  openwop connections test conn:abc
  openwop connections authorize google --scope https://www.googleapis.com/auth/calendar --write
  openwop connections oauth-clients list
`;

// Keys whose VALUES must never leave the host. Matched case-insensitively as a
// substring of the field name. `clientId` is intentionally NOT secret (the host
// returns it); `secret`/`token`/`password`/`privateKey`/`clientSecret`/`apiKey`
// /`credential` are.
const SECRET_KEY = /secret|token|password|private[-_]?key|client[-_]?secret|api[-_]?key|credential/i;

/** Recursively replace any secret-looking field's value with `[redacted]`. A
 *  belt-and-suspenders guard so the CLI cannot emit a secret even if a host
 *  returns one by mistake. Returns a fresh structure; never mutates input. */
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

const TOP = ['list', 'get', 'test', 'authorize', 'oauth-clients', 'oauth-client'];

export async function runConnections(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, CONNECTIONS_HELP);
    return 0;
  }
  const args = argv.slice(TOP.includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list':
      return await runList(ctx, args);
    case 'get':
      return await runGet(ctx, args);
    case 'test':
      return await runTest(ctx, args);
    case 'authorize':
      return await runAuthorize(ctx, args);
    case 'oauth-clients':
    case 'oauth-client':
      return await runOAuthClients(ctx, args);
    default:
      throw new CliError(`Unknown connections command: ${sub}\nRun \`openwop connections --help\` for usage.`);
  }
}

/** Capability honesty: confirm the host advertises the connections surface. A
 *  reachable discovery doc that omits it ⇒ fail closed; an unreachable one is
 *  inconclusive (defer to the live call's 404 translation). */
async function ensureAdvertised(ctx: Ctx): Promise<void> {
  const wk = await safeRequest(ctx, '/.well-known/openwop', { auth: false });
  if (!wk.ok) return;
  const paths = wk.body && typeof wk.body === 'object' ? (wk.body as { paths?: unknown }).paths : undefined;
  const advertised =
    paths !== null && typeof paths === 'object' &&
    Object.keys(paths as Record<string, unknown>).some((p) => p.startsWith('/v1/host/sample/connections'));
  if (!advertised) {
    throw new CliError(
      'connections: this host does not advertise the connections surface (/v1/host/sample/connections is absent from /.well-known/openwop). The host is the authority — refusing to guess.',
      1,
    );
  }
}

function gate404(err: unknown): never {
  if (err instanceof HttpError && err.status === 404) {
    const detail =
      err.body && typeof err.body === 'object' && typeof (err.body as { message?: string }).message === 'string'
        ? (err.body as { message?: string }).message
        : 'not found';
    throw new CliError(
      `connections: ${detail} (the host must mount /v1/host/sample/connections; the CLI renders the host's view, it never holds credentials).`,
      1,
    );
  }
  throw err;
}

/** user/org/workspace axis a connection is bound to (display only). */
function scopeAxis(c: any): string {
  if (c.orgId) return 'org';
  if (c.userId) return 'user';
  return 'workspace';
}

async function fetchConnections(ctx: Ctx): Promise<any[]> {
  let res;
  try {
    res = await requestJson(ctx, '/v1/host/sample/connections');
  } catch (err) {
    gate404(err);
  }
  return Array.isArray(res!.body?.connections) ? res!.body.connections : [];
}

async function runList(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, CONNECTIONS_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  const connections = (await fetchConnections(ctx)).map(redact) as any[];
  if (ctx.json) {
    writeJson(ctx.io.stdout, { connections });
    return 0;
  }
  if (connections.length === 0) {
    writeLine(ctx.io.stdout, 'No connections on this host.');
    return 0;
  }
  const rows = connections.map((c) => ({
    connectionId: c.connectionId,
    provider: c.provider,
    kind: c.kind,
    scope: scopeAxis(c),
    status: c.status,
    displayName: c.displayName ?? '',
    expiresAt: c.expiresAt ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['connectionId', 'provider', 'kind', 'scope', 'status', 'displayName', 'expiresAt']));
  return 0;
}

async function runGet(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop connections get <connectionId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  // No single-connection GET on the host — select from the list. The host still
  // owns the data; the CLI only filters its resolved view.
  const c = (await fetchConnections(ctx)).find((x: any) => x.connectionId === positionals[0]);
  if (!c) {
    throw new CliError(`connections: no connection found with id ${positionals[0]}.`, 1);
  }
  const safe = redact(c) as any;
  if (ctx.json) {
    writeJson(ctx.io.stdout, safe);
    return 0;
  }
  writeLine(ctx.io.stdout, `connectionId: ${safe.connectionId}`);
  writeLine(ctx.io.stdout, `provider: ${safe.provider}`);
  writeLine(ctx.io.stdout, `kind: ${safe.kind}`);
  writeLine(ctx.io.stdout, `scope: ${scopeAxis(safe)}`);
  writeLine(ctx.io.stdout, `status: ${safe.status}`);
  if (safe.displayName) writeLine(ctx.io.stdout, `displayName: ${safe.displayName}`);
  if (Array.isArray(safe.scopes)) writeLine(ctx.io.stdout, `scopes: ${safe.scopes.length ? safe.scopes.join(', ') : '(none)'}`);
  if (safe.createdAt) writeLine(ctx.io.stdout, `createdAt: ${safe.createdAt}`);
  if (safe.expiresAt) writeLine(ctx.io.stdout, `expiresAt: ${safe.expiresAt}`);
  return 0;
}

async function runTest(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop connections test <connectionId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/connections/${encodeURIComponent(positionals[0])}/test`, { method: 'POST' });
  } catch (err) {
    gate404(err);
  }
  const result = redact(res!.body ?? {}) as any;
  if (ctx.json) {
    writeJson(ctx.io.stdout, result);
    return result.ok === true ? 0 : 1;
  }
  writeLine(ctx.io.stdout, `connection: ${positionals[0]}`);
  writeLine(ctx.io.stdout, `ok: ${result.ok === true ? 'yes' : 'no'}`);
  writeLine(ctx.io.stdout, `status: ${result.status ?? 'unknown'}`);
  if (result.expiresAt) writeLine(ctx.io.stdout, `expiresAt: ${result.expiresAt}`);
  if (result.detail) writeLine(ctx.io.stdout, `detail: ${result.detail}`);
  return result.ok === true ? 0 : 1;
}

async function runAuthorize(ctx: Ctx, argv: string[]): Promise<number> {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--write'],
    value: ['--return-to'],
    multi: ['--scope'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop connections authorize <provider> [--scope <s>]... [--write] [--return-to <url>] [--json]\n');
    return options.help ? 0 : 2;
  }
  await ensureAdvertised(ctx);
  const body: Record<string, unknown> = {};
  if (Array.isArray(options.scope) && options.scope.length) body.scopes = options.scope;
  if (options.write) body.write = true;
  if (options.returnTo !== undefined) body.returnTo = options.returnTo;
  let res;
  try {
    res = await requestJson(ctx, `/v1/host/sample/connections/${encodeURIComponent(positionals[0])}/authorize`, { method: 'POST', body });
  } catch (err) {
    // 409 = OAuth not configured for this provider on the host.
    if (err instanceof HttpError && err.status === 409) {
      const detail = (err.body as { message?: string } | undefined)?.message ?? `OAuth is not configured for '${positionals[0]}' on this host.`;
      throw new CliError(`connections: ${detail}`, 1);
    }
    gate404(err);
  }
  const out = redact(res!.body ?? {}) as any;
  if (ctx.json) {
    writeJson(ctx.io.stdout, out);
    return 0;
  }
  if (!out.authorizeUrl) {
    throw new CliError('connections: host did not return an authorizeUrl.', 1);
  }
  // Print the URL alone so it is pipeable / copy-pasteable. The CLI does NOT
  // open it or complete the exchange — the browser + host callback do that.
  writeLine(ctx.io.stdout, out.authorizeUrl);
  return 0;
}

async function runOAuthClients(ctx: Ctx, argv: string[]): Promise<number> {
  const action = argv[0] ?? 'list';
  if (action === '--help' || action === '-h') {
    write(ctx.io.stdout, CONNECTIONS_HELP);
    return 0;
  }
  const rest = argv.slice(['list', 'get'].includes(action) ? 1 : 0);
  if (action !== 'list' && action !== 'get') {
    throw new CliError(`Unknown connections oauth-clients command: ${action}\nRun \`openwop connections --help\` for usage.`);
  }
  const { options, positionals } = parseOptions(rest, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, CONNECTIONS_HELP);
    return 0;
  }
  await ensureAdvertised(ctx);
  let res;
  try {
    res = await requestJson(ctx, '/v1/host/sample/connections-oauth-clients');
  } catch (err) {
    gate404(err);
  }
  const clients = (Array.isArray(res!.body?.clients) ? res!.body.clients : []).map(redact) as any[];

  if (action === 'get') {
    if (positionals.length !== 1) {
      write(ctx.io.stdout, 'Usage: openwop connections oauth-clients get <provider> [--json]\n');
      return 2;
    }
    const client = clients.find((c) => c.provider === positionals[0]);
    if (!client) {
      throw new CliError(`connections: no OAuth client configured for provider ${positionals[0]}.`, 1);
    }
    if (ctx.json) {
      writeJson(ctx.io.stdout, client);
      return 0;
    }
    writeLine(ctx.io.stdout, `provider: ${client.provider}`);
    writeLine(ctx.io.stdout, `clientId: ${client.clientId ?? ''}`);
    writeLine(ctx.io.stdout, `configured: ${client.configured === true ? 'yes' : 'no'}`);
    if (client.updatedAt) writeLine(ctx.io.stdout, `updatedAt: ${client.updatedAt}`);
    if (client.updatedBy) writeLine(ctx.io.stdout, `updatedBy: ${client.updatedBy}`);
    return 0;
  }

  // list
  if (ctx.json) {
    writeJson(ctx.io.stdout, { clients });
    return 0;
  }
  if (clients.length === 0) {
    writeLine(ctx.io.stdout, 'No host OAuth clients configured.');
    return 0;
  }
  const rows = clients.map((c) => ({
    provider: c.provider,
    clientId: c.clientId ?? '',
    configured: c.configured === true ? 'yes' : 'no',
    updatedAt: c.updatedAt ?? '',
    updatedBy: c.updatedBy ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['provider', 'clientId', 'configured', 'updatedAt', 'updatedBy']));
  return 0;
}

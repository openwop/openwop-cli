import { hostname } from 'node:os';
import type { Ctx } from '../context.js';
/**
 * `openwop login` / `openwop logout` — sign this terminal in to an openwop-app
 * host without copying a key (openwop-app ADR 0799, a device-code flow under
 * the host extension `/v1/host/openwop-app/cli-login`).
 *
 *   login    start → show a code → you approve it in the app → the host hands
 *            this CLI a key, once. It is saved to the config file (0600) and
 *            NEVER printed.
 *   logout   the saved key revokes itself on the host, then is removed locally.
 *
 * Host-agnostic rule: a host that does not serve the extension gets a legible
 * "not available" and a non-zero exit, never a guess.
 */
import { requestJson } from '../api.js';
import { configPathFor, mergeConfig, readConfigSafe, saveConfig, unsetByPath } from '../config.js';
import { CliError, HttpError } from '../errors.js';
import { write, writeJson, writeLine } from '../io.js';
import { parseOptions } from '../options.js';

const BASE = '/v1/host/openwop-app/cli-login';

export const LOGIN_HELP = `Usage:
  openwop login [--label <name>] [--timeout <seconds>] [--profile <name>] [--json]
  openwop logout [--profile <name>] [--json]

Sign this terminal in to an openwop-app host without copying an API key
(host extension under ${BASE}).

  login    Shows a short code. Open the host's Access → API keys page, type the
           code under "Sign in the OpenWOP CLI", and approve. The host then issues
           this CLI a key (30 days by default), saved to your config file.
  logout   Revokes that key on the host and removes it from your config file.

The key is never printed. It is listed in the app as "CLI: <label>", where you can
revoke it. Sign in again to renew.

  --label <name>      What to call this terminal in the app (default: this machine's hostname).
  --timeout <seconds> Give up waiting for approval after this long (default: the host's own limit).
  --profile <name>    Use the named config profile.

Approve a code ONLY if you just ran \`openwop login\` yourself.

Exit codes: 0 signed in / signed out · 1 denied, expired or not available on this host · 2 usage.

Examples:
  export OPENWOP_BASE_URL=https://api.openwop.dev
  openwop login
  openwop login --label "work laptop"
  openwop logout
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The page a person opens. A host that names its web origin outright
 * (`verificationUri`, openwop-app ADR 0827) wins: its protocol origin may serve no
 * web app, so base origin + path would land on a JSON error. Only an https URL
 * (http on a loopback host) is taken; anything else falls back to the host's
 * web origin plus the path it named.
 */
function approvalUrl(baseUrl: string, path: unknown, uri?: unknown): string {
  if (typeof uri === 'string') {
    try {
      const u = new URL(uri);
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u.toString();
    } catch { /* fall through */ }
  }
  const p = typeof path === 'string' && path.startsWith('/') ? path : '/access?tab=api-keys';
  try { return `${new URL(baseUrl).origin}${p}`; } catch { return p; }
}

function notAvailable(ctx: Ctx): CliError {
  return new CliError(
    `${ctx.baseUrl} does not serve the CLI sign-in (${BASE}/start is not there). `
    + 'Create an API key on the host and set OPENWOP_API_KEY instead.',
    1,
  );
}

export async function runLogin(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--label', '--timeout', '--profile'] });
  if (options.help) { write(ctx.io.stdout, LOGIN_HELP); return 0; }
  const timeoutS = options.timeout === undefined ? undefined : Number(options.timeout);
  if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS > 0)) {
    writeLine(ctx.io.stderr, '--timeout must be a positive number of seconds.');
    return 2;
  }
  const label = String(options.label ?? hostname() ?? 'this machine').slice(0, 60);
  // The sign-in routes take no credential. Do not send a saved (possibly dead) key with them.
  const anon: Ctx = { ...ctx, apiKey: undefined };

  let started: any;
  try {
    started = (await requestJson(anon, `${BASE}/start`, { method: 'POST', body: { label } })).body;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw notAvailable(ctx);
    throw err;
  }
  const deviceCode = started?.deviceCode;
  const userCode = started?.userCode;
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string') throw notAvailable(ctx);

  // Human-facing instructions go to STDERR so `--json` stdout stays one document.
  writeLine(ctx.io.stderr, '');
  writeLine(ctx.io.stderr, `  1. Open   ${approvalUrl(ctx.baseUrl, started.verificationPath, started.verificationUri)}`);
  writeLine(ctx.io.stderr, `  2. Enter  ${userCode}   under "Sign in the OpenWOP CLI", and approve.`);
  writeLine(ctx.io.stderr, '');
  writeLine(ctx.io.stderr, 'Waiting for approval…');

  const hostLimitS = Number.isFinite(Number(started.expiresIn)) ? Number(started.expiresIn) : 600;
  const deadline = Date.now() + Math.min(timeoutS ?? hostLimitS, hostLimitS) * 1000;
  let intervalS = Number.isFinite(Number(started.interval)) ? Number(started.interval) : 3;
  for (;;) {
    if (Date.now() >= deadline) throw new CliError('Timed out waiting for approval. Run `openwop login` again for a new code.', 1);
    await sleep(Math.max(0, intervalS) * 1000);
    let res: any;
    try {
      res = (await requestJson(anon, `${BASE}/poll`, { method: 'POST', body: { deviceCode } })).body;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw new CliError('That sign-in expired or was already used. Run `openwop login` again for a new code.', 1);
      }
      throw err;
    }
    if (res?.status === 'pending') {
      if (Number.isFinite(Number(res.interval))) intervalS = Number(res.interval);
      continue;
    }
    if (res?.status === 'denied') throw new CliError('The sign-in was denied in the app.', 1);
    if (res?.status === 'failed') throw new CliError(`The host could not issue a key: ${String(res.message ?? 'unknown reason')}`, 1);
    if (res?.status === 'approved' && typeof res.token === 'string') {
      const configPath = configPathFor(options.profile, ctx.env);
      saveConfig(configPath, mergeConfig(readConfigSafe(configPath), { host: { baseUrl: ctx.baseUrl, apiKey: res.token } }));
      const key = res.key ?? {};
      if (ctx.json) {
        // Never the token: it lives in the config file only.
        writeJson(ctx.io.stdout, { status: 'signed-in', keyId: key.keyId ?? null, name: key.name ?? null, expiresAt: key.expiresAt ?? null, configPath });
        return 0;
      }
      writeLine(ctx.io.stdout, `Signed in to ${ctx.baseUrl} as “${key.name ?? `CLI: ${label}`}”.`);
      if (key.expiresAt) writeLine(ctx.io.stdout, `The key expires ${String(key.expiresAt).slice(0, 10)}; run \`openwop login\` again to renew.`);
      writeLine(ctx.io.stdout, `Saved to ${configPath}. Revoke it any time with \`openwop logout\` or in the app.`);
      return 0;
    }
    throw new CliError('The host answered the sign-in in a shape this CLI does not understand.', 1);
  }
}

export async function runLogout(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--profile'] });
  if (options.help) { write(ctx.io.stdout, LOGIN_HELP); return 0; }
  const configPath = configPathFor(options.profile, ctx.env);
  const config = readConfigSafe(configPath);
  const saved = config?.host?.apiKey;
  if (typeof saved !== 'string' || saved.length === 0) {
    if (ctx.json) writeJson(ctx.io.stdout, { status: 'not-signed-in' });
    else writeLine(ctx.io.stdout, 'Not signed in: no key is saved in your config.');
    return 0;
  }
  // Revoke the SAVED key, whatever --api-key / OPENWOP_API_KEY says: that is the one being signed out.
  let revoked = false;
  let note = '';
  try {
    await requestJson({ ...ctx, apiKey: saved }, `${BASE}/logout`, { method: 'POST', body: {} });
    revoked = true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) note = 'The host no longer recognised the key (already revoked or expired).';
    else if (err instanceof HttpError && err.status === 404) note = 'This host has no sign-out route; the key was NOT revoked there — revoke it in the app.';
    else if (err instanceof HttpError && err.status === 400) note = 'The saved key is not one a sign-in issued; it was NOT revoked on the host — revoke it in the app.';
    else throw err;
  }
  unsetByPath(config, 'host.apiKey');
  saveConfig(configPath, config);
  if (ctx.json) { writeJson(ctx.io.stdout, { status: 'signed-out', revokedOnHost: revoked, ...(note ? { note } : {}) }); return 0; }
  writeLine(ctx.io.stdout, revoked ? 'Signed out. The key was revoked on the host and removed from your config.' : `Removed the key from your config. ${note}`);
  return 0;
}

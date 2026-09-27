import type { Ctx } from '../context.js';
/**
 * Shared helpers for the identity / operator-administration groups (vault,
 * developer-keys, billing, environments, site-config, …).
 *
 * - `gatedRequest` maps the host's auth refusals onto ONE legible, actionable
 *   message with exit 4 (the root help's "auth/permission denied" code), so a
 *   super-admin / admin-token / scope-gated surface fails CLOSED instead of
 *   printing a bare `HTTP 403`. The host is the authority; the CLI never
 *   pre-judges who is allowed — it only explains the refusal it got.
 * - `readBodyOption` (re-exported from contentHelpers) reads `--body <json>` /
 *   `--body-file <path>` for routes whose request bodies are too rich for flags.
 * - `readSecretInput` reads secret material from a file / stdin / a no-echo
 *   prompt — never from argv, where it would land in shell history and `ps`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError, HttpError } from '../errors.js';
import { requestJson, type RequestOptions } from '../api.js';
import { readSecret } from '../prompt.js';
import { pickArray } from './contentHelpers.js';

// The --body / --body-file parser is shared with the content groups (one copy).
export { readBodyOption } from './contentHelpers.js';

export type Gate = 'superadmin' | 'admin-token' | 'scope' | 'signed-in';

function hostDetail(err: HttpError): string {
  const b = err.body as { message?: unknown; details?: { hint?: unknown; requiredScope?: unknown } } | null;
  const parts: string[] = [];
  if (b && typeof b.message === 'string' && b.message) parts.push(/[.!?]$/.test(b.message) ? b.message : `${b.message}.`);
  if (b?.details && typeof b.details.hint === 'string') parts.push(`Hint: ${String(b.details.hint).replace(/\.+$/, '')}.`);
  return parts.length ? ` Host said: ${parts.join(' ')}` : '';
}

function gateAdvice(gate: Gate, surface: string): string {
  switch (gate) {
    case 'superadmin':
      return `${surface} requires a super-admin principal. Add your tenant id to OPENWOP_SUPERADMIN_TENANTS on the server and authenticate the CLI as that tenant (openwop onboard / --api-key).`;
    case 'admin-token':
      return `${surface} requires the host admin token. Pass the server's OPENWOP_ADMIN_TOKEN via --api-key.`;
    case 'scope':
      return `${surface} requires a role with the needed scope in this workspace (see \`openwop orgs effective\`).`;
    case 'signed-in':
      return `${surface} requires a signed-in user (not an anonymous session). Authenticate with --api-key or \`openwop onboard\`.`;
  }
}

/** requestJson with the auth refusal (401/403) mapped to an actionable exit-4 error. */
export async function gatedRequest(ctx: Ctx, path: string, options: RequestOptions | undefined, surface: string, gate: Gate) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new CliError(`${gateAdvice(gate, surface)}${hostDetail(err)}`, 4);
    }
    if (err instanceof HttpError && err.status === 503 && gate === 'admin-token') {
      throw new CliError(`${surface} is disabled on this host (the server has no OPENWOP_ADMIN_TOKEN of at least 16 characters).${hostDetail(err)}`, 1);
    }
    throw err;
  }
}

/** Read secret material: --value-file <path> (trailing newline trimmed) or a no-echo prompt
 *  (which also reads one line from a pipe). Never accepted as a plain argv value. */
export async function readSecretInput(ctx: Ctx, options: Record<string, any>, label: string): Promise<string> {
  let value: string;
  if (options.valueFile !== undefined) {
    try {
      value = readFileSync(resolve(ctx.cwd, String(options.valueFile)), 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new CliError(`Cannot read --value-file ${options.valueFile}: ${err instanceof Error ? err.message : String(err)}`, 2);
    }
  } else {
    const entered = await readSecret(ctx, `${label}: `);
    value = typeof entered === 'string' ? entered : String(entered ?? '');
  }
  if (!value) throw new CliError('A non-empty secret value is required.', 2);
  return value;
}

/** First array under `key` on `body` (or `body` itself when it is an array). */
export function arrayOf(body: any, key: string): any[] {
  return pickArray(body, key);
}

export function parseBool(flag: string, value: unknown): boolean {
  const v = String(value).toLowerCase();
  if (v === 'true' || v === 'on' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'off' || v === 'no' || v === '0') return false;
  throw new CliError(`${flag} must be true or false, got '${value}'.`, 2);
}

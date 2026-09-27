import type { Ctx } from '../context.js';
/**
 * Request helpers shared by the protocol/run command groups:
 *
 *  - `requestNormativeOrHost` — prefer a normative `/v1/<op>` read and fall
 *    back to the host-extension `/v1/host/openwop-app/<op>` twin when the host
 *    does not serve the normative operation (404 / 405 / 501), or refuses it
 *    for want of ANY credential (RFC 0200 §B.1) while the demo twin still
 *    admits anonymous callers. Golden rule 1: prefer normative, fall back for
 *    demo surfaces, and say which.
 *  - `hostRunSegment` — a run id as one host-extension path segment (v2-projected).
 *  - `failClosedOn404` — translate a surface-absent 404/501 into a
 *    capability-honest CliError (exit 1) instead of a bare "HTTP 404".
 */
import { CliError, HttpError, errorEnvelope, isNoCredentialChallenge } from '../errors.js';
import { writeLine } from '../io.js';
import { requestJson, type RequestOptions } from '../api.js';
import { negotiateMajor } from '../protocol.js';
import { projectTenantBoundId } from '../ids.js';

/** Statuses that mean "this host does not serve that operation" (not "that record is absent"). */
const NOT_SERVED = new Set([404, 405, 501]);

export interface NormativeResult {
  status: number;
  headers: Headers;
  body: any;
  /** The path that answered. */
  path: string;
  /** Which surface answered. */
  via: 'normative' | 'host';
}

/**
 * True when this request presents a credential: the CLI's `--api-key` bearer
 * (unless the caller opted out with `auth: false`), or an `authorization` /
 * `cookie` header the caller supplied. A 401 on such a request is a REFUSAL of
 * that credential, and must never be retried anonymously (a silent identity
 * switch — openwop-app ADR 0434).
 */
function presentsCredential(ctx: Ctx, req: RequestOptions): boolean {
  if (req.auth !== false && ctx.apiKey) return true;
  return Object.keys(req.headers ?? {}).some((h) => /^(authorization|cookie)$/i.test(h));
}

/**
 * GET (or `options.method`) the normative path, and retry the host-extension
 * path when:
 *
 *  - the host does not serve the normative operation (404 / 405 / 501); or
 *  - the request presented NO credential and the host answered the RFC 0200
 *    §B.1 no-credential challenge (`401` + `Bearer`, no `error=`). A v2 host
 *    MUST refuse an anonymous protocol read that way, while a host's demo
 *    surface (the reference host's `/host/openwop-app/*`) still admits the
 *    caller as an anonymous visitor. That answer comes from a throwaway
 *    anonymous tenant, so it is ALWAYS announced on stderr, not only under
 *    `--verbose`; stdout stays clean for `--json`.
 *
 * If a no-credential fallback itself fails as unserved (404/405/501) or
 * unauthenticated (401), the ORIGINAL 401 is re-thrown — on a host with no such
 * demo surface, "sign in" is the honest answer, not "not found".
 * `forceHost` skips the normative attempt.
 */
export async function requestNormativeOrHost(
  ctx: Ctx,
  normativePath: string,
  hostPath: string,
  options: RequestOptions & { forceHost?: boolean } = {},
): Promise<NormativeResult> {
  const { forceHost, ...req } = options;
  let anonymousRetryOf: HttpError | undefined;
  if (!forceHost) {
    try {
      const res = await requestJson(ctx, normativePath, req);
      if (ctx.verbose) writeLine(ctx.io.stderr, `openwop: served by the normative path ${normativePath}`);
      return { ...res, path: normativePath, via: 'normative' };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (isNoCredentialChallenge(err) && !presentsCredential(ctx, req)) anonymousRetryOf = err;
      else if (!NOT_SERVED.has(err.status)) throw err;
    }
  }
  let res;
  try {
    res = await requestJson(ctx, hostPath, req);
  } catch (err) {
    if (anonymousRetryOf && err instanceof HttpError && (NOT_SERVED.has(err.status) || err.status === 401)) throw anonymousRetryOf;
    throw err;
  }
  if (anonymousRetryOf) {
    writeLine(ctx.io.stderr, `openwop: not signed in — showing this host's anonymous demo view (${hostPath}). Sign in or pass --api-key to read your workspace.`);
  } else if (ctx.verbose) {
    writeLine(ctx.io.stderr, `openwop: served by the host-extension path ${hostPath}`);
  }
  return { ...res, path: hostPath, via: 'host' };
}

/**
 * Re-throw a 404/501 as a capability-honest CliError (exit 1) naming the
 * surface; every other error passes through to the dispatcher's defaults
 * (401/403 → exit 4).
 */
export function failClosedOn404(err: unknown, surface: string): never {
  if (err instanceof HttpError && (err.status === 404 || err.status === 501)) {
    const env = errorEnvelope(err.body);
    const detail = env.message ?? env.code ?? 'not found';
    throw new CliError(`${surface}: ${detail} (HTTP ${err.status} — the host does not serve this, or the record does not exist).`, 1);
  }
  throw err;
}

/**
 * One path segment for a run id on a HOST-EXTENSION route (`/v1/host/openwop-app/runs/{runId}/…`).
 * Manifest routes get the identity.md §5 projection automatically (src/protocol.ts); host
 * routes do not, so under major 2 — where a runId is tenant-bound (`acme/r-…`) — project it
 * here too (`acme~2Fr-…`): a percent-encoded `%2F` is decoded by some front doors into two
 * segments and 404s. Under major 1 it is plain `encodeURIComponent`.
 */
export async function hostRunSegment(ctx: Ctx, runId: string): Promise<string> {
  return (await negotiateMajor(ctx)) === 2 ? projectTenantBoundId(runId) : encodeURIComponent(runId);
}

import type { Ctx } from './context.js';
/** Host HTTP client — typed-ish wrapper over ctx.fetchImpl with bearer + JSON. */

import { HttpError, httpErrorLine } from './errors.js';
import { resolveRequest } from './protocol.js';
import { checkMinClientVersion } from './wire.js';

const floorWarned = new WeakSet<object>();

/**
 * One stderr warning per process when the host's `minClientVersion`
 * (versioning.md §1.5, read from the discovery document negotiation already
 * fetched — no extra request) is above the version this CLI speaks. A warning,
 * not a refusal: whether to refuse is the host's decision (`426
 * client_version_unsupported`, which the error renderer explains).
 */
function warnIfBelowClientFloor(ctx: Ctx): void {
  if (floorWarned.has(ctx) || !ctx.discovery || !ctx.protocolMajor) return;
  floorWarned.add(ctx);
  const floor = checkMinClientVersion((ctx.discovery.doc as { minClientVersion?: unknown } | null)?.minClientVersion, ctx.protocolMajor);
  if (floor.status === 'below') {
    ctx.io.stderr.write(`openwop: warning: this host requires minClientVersion ${floor.required}; this CLI speaks ${floor.client}. Requests may be refused (426) — run \`openwop upgrade\`.\n`);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
}

/** Perform a JSON request against `ctx.baseUrl`; throws HttpError on non-2xx. */
export async function requestJson(ctx: Ctx, requestedPath: string, options: RequestOptions = {}): Promise<{ status: number; headers: Headers; body: any }> {
  // Negotiate the protocol major once per process and rewrite manifest-named
  // `/v1/<op>` paths for it (src/protocol.ts). Commands keep their literals.
  const { path, headers } = await resolveRequest(ctx, requestedPath, {
    accept: 'application/json',
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  });
  warnIfBelowClientFloor(ctx);
  // Join path RELATIVE to the base so a base with a path prefix
  // (e.g. https://app.openwop.dev/api) is preserved. `new URL(path, base)`
  // with an absolute `path` would otherwise reset the base path to '/' —
  // silently breaking any host that proxies under a prefix.
  const url = new URL(path.replace(/^\//, ''), ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
  if (options.auth !== false && ctx.apiKey) {
    headers.authorization = `Bearer ${ctx.apiKey}`;
  }
  const res = await ctx.fetchImpl(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const body = text.length > 0 ? parseJsonResponse(text) : null;
  if (!res.ok) {
    throw new HttpError(httpErrorLine(res.status, body), res.status, body, res.headers);
  }
  return { status: res.status, headers: res.headers, body };
}

/** requestJson that never throws — returns {ok,...} for diagnostics (doctor). */
export async function safeRequest(ctx: Ctx, path: string, options: RequestOptions = {}): Promise<any> {
  try {
    const res = await requestJson(ctx, path, options);
    return { ok: true, path, status: res.status, body: res.body };
  } catch (err) {
    return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Unauthenticated reachability probe — returns {ok, message}. */
export async function probeEndpoint(ctx: Ctx, path: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await requestJson(ctx, path, { auth: false });
    return { ok: true, message: String(res.status) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function parseJsonResponse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

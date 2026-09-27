/** CLI error types + the unknown-error narrowing helper. Leaf module. */

/** A user-facing CLI error. `code` is the process exit code (default 2). */
export class CliError extends Error {
  code: number;
  constructor(message: string, code = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/** A non-2xx HTTP response from a host/registry. */
export class HttpError extends Error {
  status: number;
  body: unknown;
  /** Response headers when the request reached a host (absent for synthetic errors). */
  headers: Headers | undefined;
  constructor(message: string, status: number, body: unknown, headers?: Headers) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
  /** The registered (or vendor) error code from the envelope, when the host sent one. */
  get errorCode(): string | undefined {
    return errorEnvelope(this.body).code;
  }
}

/**
 * Read an error body in every envelope shape a host may answer with.
 *
 * - v2 (`spec/v2/core/errors.md` §The envelope, closed): `{ error: "<code>", message, details? }`.
 *   A client routes on `error`, never on `message`.
 * - v1 hosts answer the same flat shape (`{ error: "run_not_found", message }`
 *   on app.openwop.dev), and older ones a nested `{ error: { code, message } }`
 *   or a bare `{ code, message }` / `{ message }`.
 *
 * Anything else yields `{}` so the caller falls back to the bare status.
 */
export function errorEnvelope(body: unknown): { code?: string; message?: string; details?: Record<string, unknown> } {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const nested = b.error && typeof b.error === 'object' ? (b.error as Record<string, unknown>) : undefined;
  const code = typeof b.error === 'string' ? b.error
    : typeof nested?.code === 'string' ? nested.code
    : typeof b.code === 'string' ? b.code
    : undefined;
  const message = typeof b.message === 'string' && b.message.length > 0 ? b.message
    : typeof nested?.message === 'string' && nested.message.length > 0 ? nested.message
    : undefined;
  const rawDetails = b.details ?? nested?.details;
  const details = rawDetails && typeof rawDetails === 'object' ? (rawDetails as Record<string, unknown>) : undefined;
  return { ...(code ? { code } : {}), ...(message ? { message } : {}), ...(details ? { details } : {}) };
}

/**
 * The one-line rendering of an HttpError: `HTTP <status> <code>: <message>`,
 * plus a hint for the version-negotiation refusals a user can act on
 * (versioning.md §1.3/§1.5) and the `Retry-After` a 429 MUST carry
 * (errors.md §Retry timing — the header is the only home of retry timing).
 */
export function describeHttpError(err: HttpError): string {
  const env = errorEnvelope(err.body);
  const line = httpErrorLine(err.status, err.body);
  const hint = httpErrorHint(err, env);
  return hint ? `${line}\n  ${hint}` : line;
}

/** `HTTP <status>[ <code>][: <message>]` — the HttpError message `requestJson` throws. */
export function httpErrorLine(status: number, body: unknown): string {
  const env = errorEnvelope(body);
  let line = `HTTP ${status}`;
  if (env.code) line += ` ${env.code}`;
  if (env.message) line += `: ${env.message}`;
  return line;
}

function httpErrorHint(err: HttpError, env: ReturnType<typeof errorEnvelope>): string | undefined {
  if (err.status === 426 || env.code === 'client_version_unsupported') {
    return 'The host requires a newer client (its discovery document names the floor as `minClientVersion`). Run `openwop upgrade`, then retry.';
  }
  if (err.status === 406 || env.code === 'protocol_version_unsupported') {
    const listed = Array.isArray(env.details?.protocolVersions) ? ` (host serves ${(env.details!.protocolVersions as unknown[]).join(', ')})` : '';
    return `The host does not serve the protocol major this CLI selected${listed}. Pin one it does with OPENWOP_PROTOCOL_MAJOR=1|2.`;
  }
  if (env.code === 'protocol_version_mismatch') {
    return 'An OpenWOP-Version header other than 1 was sent on a /v1/ path. Pin OPENWOP_PROTOCOL_MAJOR=1 and report this as a CLI bug.';
  }
  if (err.status === 429) {
    const after = err.headers?.get?.('retry-after');
    return after ? `Rate limited — retry after ${after}s.` : 'Rate limited — retry later.';
  }
  return undefined;
}

/** Narrow an unknown caught value to a printable message (strict catch vars). */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tenant-bound id wire form — `spec/v2/core/identity.md` §5 "Wire form".
 *
 * Under major 2 a `runId` is tenant-bound: `<tenantId>/<opaque>` (a run minted
 * under v1 and read under v2 is projected the same way, versioning.md §5). On
 * the wire it travels as ONE path segment, projected: every UTF-8 byte outside
 * `[A-Za-z0-9._-]` becomes `~` + two uppercase hex digits, so `acme/r-9f3c…`
 * travels as `acme~2Fr-9f3c…`.
 *
 * A host MUST also accept `acme%2Fr-…`, but a front door that decodes `%2F`
 * before routing (runs.md §Create — a CDN rewrite, a proxy) turns that into
 * two segments and a 404. Measured on app.openwop.dev (2026-09-27): the
 * percent form 404s, the projected form answers 200. The projected form is the
 * one every host MUST accept and every link is emitted in, so it is what the
 * CLI sends under major 2.
 *
 * A projected id is ONE segment, so it never carries a raw `/`. A value with
 * `~` and no `/` is taken to be projected already and passes through —
 * projecting twice would send `~7E`. A value that still has its `/` is the
 * unprojected `<tenantId>/<opaque>` form whatever else it carries, and is
 * projected in full. That case is real: a host whose tenant ids fall outside
 * the corpus grammar emits the tenant half already escaped
 * (`user~3Ad4d0…/0c0f…`, measured on app.openwop.dev 2026-10-01), and the
 * path form it links to — and answers on — is the full projection
 * (`user~7E3Ad4d0…~2F0c0f…`). Passing that id through sent the raw `/` and
 * every read of a personal-workspace run was a 404.
 */

/** Project one tenant-bound id into its single-segment wire form. */
export function projectTenantBoundId(id: string): string {
  if (id.includes('~') && !id.includes('/')) return id;
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Re-encode the tenant-bound `{runId}` parameters of an UNVERSIONED (major-2)
 * manifest path into the projected wire form: the segment after `/runs/`
 * (every manifest template carrying `{runId}` is `/runs/{runId}…`, with an
 * optional `:fork`/`:diff`/`:pause`/`:resume` suffix) and the `against=` query
 * parameter of `diffRun`. Commands keep building `/v1/…` paths with
 * `encodeURIComponent`, so the segment is decoded first; under major 1 this is
 * never called and the `/v1/` path is sent exactly as written.
 */
export function projectRunIdsInPath(path: string): string {
  const q = path.indexOf('?');
  const bare = q === -1 ? path : path.slice(0, q);
  let query = q === -1 ? '' : path.slice(q);
  const m = /^\/runs\/([^/:]+)(.*)$/.exec(bare);
  const projectedBare = m ? `/runs/${projectTenantBoundId(decodeSegment(m[1]))}${m[2]}` : bare;
  if (m && query) {
    query = query.replace(/([?&]against=)([^&]*)/, (_all, key: string, value: string) => `${key}${projectTenantBoundId(decodeSegment(value))}`);
  }
  return `${projectedBare}${query}`;
}

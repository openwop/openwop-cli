import type { Ctx } from './context.js';
/**
 * Protocol-major negotiation — the one place the CLI decides which wire it speaks.
 *
 * `spec/v2/core/versioning.md` §1.5: a client selects the highest major it
 * implements that the host advertises in `protocolVersions[]`. This CLI
 * implements 2 and 1. Every command keeps its `/v1/<op>` literal; at the
 * request boundary (`resolveRequest`) a literal whose unversioned twin is an
 * operation named in `spec/v2/path-manifest.json` is rewritten to that twin
 * with `OpenWOP-Version` set (§1.2 — the `/v1/` keys are the same operations
 * through the overlap; §1.3 — the header is what selects major 2 on an
 * unversioned name). Paths the manifest does not name — the host-sample
 * `/v1/host/sample/*` routes, any host-proprietary root — are left exactly as
 * written: they have no v2 home (versioning.md §5, open gap), so rewriting
 * them would send a request the host has never served.
 *
 * Negotiation happens once per process: `/.well-known/openwop` is read
 * header-less (both representations carry `protocolVersions`) and the answer
 * is memoized on `ctx.protocolMajor`. `OPENWOP_PROTOCOL_MAJOR=1|2` pins it
 * without a probe — the escape hatch for a host whose discovery lies.
 */

/** Majors this CLI implements, highest first (§1.5 precedence). */
export const CLI_PROTOCOL_MAJORS = [2, 1] as const;
export type ProtocolMajor = (typeof CLI_PROTOCOL_MAJORS)[number];

/**
 * Operation + channel path templates from `spec/v2/path-manifest.json` at
 * corpus `v2.0.8`. `/.well-known/openwop` and `/openapi.json` are omitted: they
 * carry no `/v1/` prefix and are addressed by the same name under both majors.
 * Regenerate with:
 *   python3 -c "import json;m=json.load(open('spec/v2/path-manifest.json'));
 *     print(sorted({o['path'] for o in m['operations']}|{c['address'] for c in m['channels']}))"
 */
export const V2_PATH_TEMPLATES: readonly string[] = [
  '/agents',
  '/agents/org-chart',
  '/agents/org-chart/{departmentId}',
  '/agents/roster',
  '/agents/roster/{rosterId}',
  '/agents/{agentId}',
  '/agents/{agentId}/deployments',
  '/audit/verify',
  '/content/pages',
  '/content/pages/{pageId}/sections/{sectionId}',
  '/content/pages/{slug}',
  '/content/settings',
  '/host/effect-seams',
  '/host/events',
  '/interrupts/{token}',
  '/prompts',
  '/prompts/{templateId}',
  '/prompts:render',
  '/runs',
  '/runs/{runId}',
  '/runs/{runId}/ancestry',
  '/runs/{runId}/annotations',
  '/runs/{runId}/artifacts/{artifactId}',
  '/runs/{runId}/cancel',
  '/runs/{runId}/compensation',
  '/runs/{runId}/effects',
  '/runs/{runId}/eval-summary',
  '/runs/{runId}/events',
  '/runs/{runId}/events/poll',
  '/runs/{runId}/interrupts/{nodeId}',
  '/runs/{runId}:diff',
  '/runs/{runId}:fork',
  '/runs/{runId}:pause',
  '/runs/{runId}:resume',
  '/runs:bulk-cancel',
  '/tools',
  '/tools/{toolId}',
  '/trigger-subscriptions',
  '/webhooks',
  '/webhooks/{webhookId}',
  '/workflows/{workflowId}',
];

const V2_MATCHERS: readonly RegExp[] = V2_PATH_TEMPLATES.map(
  (t) => new RegExp(`^${t.replace(/[.:]/g, '\\$&').replace(/\{[A-Za-z]+\}/g, '[^/]+')}$`),
);

/**
 * The unversioned twin of a `/v1/<op>` path when `<op>` is a manifest-named
 * operation, else null. A query string is carried over untouched.
 */
export function v2Twin(path: string): string | null {
  const q = path.indexOf('?');
  const bare = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? '' : path.slice(q);
  if (!bare.startsWith('/v1/')) return null;
  const unversioned = bare.slice('/v1'.length);
  return V2_MATCHERS.some((m) => m.test(unversioned)) ? `${unversioned}${query}` : null;
}

/** Highest major the CLI implements among those the host advertises; 1 when the host says nothing usable. */
export function selectMajor(protocolVersions: unknown): ProtocolMajor {
  const advertised = Array.isArray(protocolVersions) ? protocolVersions.filter((v): v is string => typeof v === 'string') : [];
  for (const major of CLI_PROTOCOL_MAJORS) {
    if (advertised.some((v) => v.startsWith(`${major}.`))) return major;
  }
  return 1;
}

/** Read `/.well-known/openwop` once and memoize the selected major on ctx. */
export async function negotiateMajor(ctx: Ctx): Promise<ProtocolMajor> {
  if (ctx.protocolMajor !== undefined) return ctx.protocolMajor;
  const pinned = ctx.env?.OPENWOP_PROTOCOL_MAJOR;
  if (pinned === '1' || pinned === '2') {
    ctx.protocolMajor = Number(pinned) as ProtocolMajor;
    return ctx.protocolMajor;
  }
  let major: ProtocolMajor = 1;
  try {
    const url = new URL('.well-known/openwop', ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`);
    const res = await ctx.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (res.ok) {
      const doc: unknown = JSON.parse(await res.text());
      major = selectMajor((doc as { protocolVersions?: unknown } | null)?.protocolVersions);
    }
  } catch {
    // Unreachable or non-JSON discovery: stay on the v1 default (§1.3). The
    // command's own request reports the failure with its usual message.
  }
  ctx.protocolMajor = major;
  return major;
}

/**
 * Rewrite a request for the negotiated major. Under major 2 a manifest-named
 * `/v1/<op>` becomes `/<op>` + `OpenWOP-Version: 2.0`; everything else — major
 * 1, an already-unversioned path, a proprietary `/v1/host/*` route — passes
 * through unchanged.
 */
export async function resolveRequest(
  ctx: Ctx,
  path: string,
  headers: Record<string, string>,
): Promise<{ path: string; headers: Record<string, string> }> {
  const major = await negotiateMajor(ctx);
  if (major !== 2) return { path, headers };
  const twin = v2Twin(path);
  if (twin === null) return { path, headers };
  return { path: twin, headers: { ...headers, 'openwop-version': '2.0' } };
}

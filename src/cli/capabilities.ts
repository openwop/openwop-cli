import type { Ctx } from '../context.js';
/**
 * `openwop capabilities` — read + summarize /.well-known/openwop.
 *
 * `/.well-known/openwop` is read with `OpenWOP-Version: 2` (the closed v2 root,
 * spec/v2/core/capabilities.md §1 — src/protocol.ts reads it once per
 * process). The renderer still tolerates a document without v2 capability
 * records (a minimal or pre-v2-shaped host), listing its root families.
 */
import { requestJson } from '../api.js';
import { write, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { negotiateMajor } from '../protocol.js';
import { checkMinClientVersion } from '../wire.js';

export const CAPABILITIES_HELP = `Usage: openwop capabilities [--base-url url] [--json]

Reads /.well-known/openwop and prints the implementation, protocol versions, and
advertised capability families. It requests the v2 representation
(OpenWOP-Version: 2): capability records with their status, the metadata keys
(minClientVersion, eventLogSchemaVersion, …) and the \`extensions.<org>.<name>\`
vendor records. A host that serves only protocol major 1 (end of support
2026-10-04) is refused. Use --json to print the raw discovery document.
`;

/**
 * v2 root metadata keys (capabilities.md §3.1) — not capability records, so
 * they are rendered as fields, never counted as families.
 */
const V2_METADATA_KEYS = new Set([
  'protocolVersion', 'protocolVersions', 'preferredVersion', 'extensions', 'implementation', 'engineVersion',
  'eventLogSchemaVersion', 'configurable', 'observability', 'minClientVersion', 'runtimeCapabilities', 'testing',
  'conformance', 'fixtures', 'compliance', 'discovery', 'supportedTransports',
]);

/** Non-family keys of the v1 document (plus the v2 metadata keys a v1 document may also carry). */
const V1_NON_FAMILY_KEYS = new Set([...V2_METADATA_KEYS, 'capabilities', 'contractProvenance', 'stream', 'x-host-openwop-workforce']);

export async function runCapabilities(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, CAPABILITIES_HELP);
    return 0;
  }
  const { doc, servedVersion } = await readDiscovery(ctx);
  if (ctx.json) {
    writeJson(ctx.io.stdout, doc);
    return 0;
  }
  write(ctx.io.stdout, summarizeCapabilities(doc, { servedVersion }));
  return 0;
}

/**
 * The v2 discovery document. Reuses the one `negotiateMajor` already fetched
 * (with `OpenWOP-Version: 2`) — no second request. Only under the
 * `OPENWOP_PROTOCOL_MAJOR=2` pin (which skips that read), or when discovery
 * could not be parsed, is it fetched here. Throws HttpError like any request
 * when the host cannot serve it, and CliError when the host serves only major 1.
 */
export async function readDiscovery(ctx: Ctx): Promise<{ doc: any; servedVersion: string | undefined; major: 2 }> {
  const major = await negotiateMajor(ctx);
  if (ctx.discovery) return { doc: ctx.discovery.doc, servedVersion: ctx.discovery.servedVersion, major };
  const res = await requestJson(ctx, '/.well-known/openwop', { auth: false, headers: { 'openwop-version': '2' } });
  const servedVersion = res.headers?.get?.('openwop-version') ?? undefined;
  ctx.discovery = { doc: res.body, servedVersion };
  return { doc: res.body, servedVersion, major };
}

/**
 * The capability record `pick` selects from the v2 discovery document
 * (`readDiscovery`). Returns the record, `null` when the document was read and
 * does not advertise it, or `undefined` when no document could be read at all
 * (inconclusive: defer to the live call).
 */
export async function advertisedRecord(ctx: Ctx, pick: (doc: any) => any): Promise<any> {
  let negotiated: any;
  try {
    ({ doc: negotiated } = await readDiscovery(ctx));
  } catch {
    return undefined;
  }
  return pick(negotiated && typeof negotiated === 'object' ? negotiated : {}) || null;
}

/** True when a discovery document is the closed v2 root (capabilities.md §3). */
export function isV2Discovery(caps: any, servedVersion?: string): boolean {
  if (typeof servedVersion === 'string' && servedVersion.startsWith('2.')) return true;
  if (!caps || typeof caps !== 'object' || 'capabilities' in caps || 'supportedTransports' in caps) return false;
  return Object.entries(caps).some(([k, v]) => !V2_METADATA_KEYS.has(k) && !!v && typeof v === 'object' && typeof (v as { witness?: unknown }).witness === 'string');
}

export function summarizeCapabilities(caps: any, opts: { servedVersion?: string } = {}) {
  if (isV2Discovery(caps, opts.servedVersion)) return summarizeV2(caps, opts);
  const wrapped = caps.capabilities && typeof caps.capabilities === 'object' ? Object.keys(caps.capabilities) : [];
  // v1 capabilities.md: families live at the document ROOT; the `capabilities`
  // wrapper is a deprecated mirror. Prefer the wrapper when present (older
  // hosts), else list the root families.
  const capabilities = wrapped.length > 0 ? wrapped : Object.keys(caps).filter((k) => !V1_NON_FAMILY_KEYS.has(k) && caps[k] && typeof caps[k] === 'object').sort();
  const impl = caps.implementation ?? {};
  const lines = [
    `Implementation: ${impl.name ?? 'unknown'} ${impl.version ?? ''}`.trim(),
    `Protocol: ${caps.protocolVersion ?? 'unknown'}`,
    ...(Array.isArray(caps.protocolVersions) ? [`Protocol versions: ${caps.protocolVersions.join(', ')}${caps.preferredVersion ? ` (preferred ${caps.preferredVersion})` : ''}`] : []),
    `Transports: ${(caps.supportedTransports ?? []).join(', ') || 'unknown'}`,
    `Stream modes: ${caps.stream?.modes?.join(', ') ?? 'unknown'}`,
    `Fixtures: ${Array.isArray(caps.fixtures) ? caps.fixtures.length : 0}`,
    `Capability blocks: ${capabilities.join(', ') || 'none'}`,
    '',
  ];
  return lines.join('\n');
}

function summarizeV2(caps: any, opts: { servedVersion?: string }) {
  const impl = caps.implementation ?? {};
  const families = Object.keys(caps).filter((k) => !V2_METADATA_KEYS.has(k) && caps[k] && typeof caps[k] === 'object').sort();
  const byStatus = new Map<string, string[]>();
  for (const name of families) {
    const rec = caps[name];
    const status = typeof rec.status === 'string' ? rec.status : 'unknown';
    const label = typeof rec.until === 'string' ? `${name} (until ${rec.until})` : name;
    byStatus.set(status, [...(byStatus.get(status) ?? []), label]);
  }
  const extensions = caps.extensions && typeof caps.extensions === 'object' ? Object.keys(caps.extensions).sort() : [];
  const floor = checkMinClientVersion(caps.minClientVersion, 2);
  const floorText = floor.status === 'unknown'
    ? (caps.minClientVersion === undefined ? 'not advertised' : `${String(caps.minClientVersion)} (unreadable)`)
    : `${floor.required} (this CLI speaks ${floor.client}${floor.status === 'below' ? ' — BELOW the floor; run `openwop upgrade`' : ''})`;
  const lines = [
    `Implementation: ${[impl.name ?? 'unknown', impl.version ?? '', impl.vendor ? `(${impl.vendor})` : ''].filter(Boolean).join(' ')}`,
    `Representation: v2${opts.servedVersion ? ` (OpenWOP-Version ${opts.servedVersion})` : ''}`,
    `Protocol versions: ${Array.isArray(caps.protocolVersions) ? caps.protocolVersions.join(', ') : 'unknown'}${caps.preferredVersion ? ` (preferred ${caps.preferredVersion})` : ''}`,
    `Min client version: ${floorText}`,
    `Event log schema version: ${caps.eventLogSchemaVersion ?? 'unknown'}`,
    `Engine version: ${caps.engineVersion ?? 'unknown'}`,
    `Capability families: ${families.length}`,
    ...[...byStatus.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, names]) => `  ${status}: ${names.join(', ')}`),
    `Extensions: ${extensions.join(', ') || 'none'}`,
    '',
  ];
  return lines.join('\n');
}

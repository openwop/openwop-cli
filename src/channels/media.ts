/**
 * Outbound media for the relay channels (openwop-app ADR 1043 D5 "full media",
 * hardened by its security review, H1).
 *
 * The relay runs on a person's own machine, so a media URL the server hands it
 * must never reach that machine's own network: no loopback, link-local, private
 * (RFC 1918, CGNAT, IPv6 ULA / link-local), cloud metadata or other special
 * address, and never plain http. Every channel downloads attachments ITSELF —
 * WhatsApp too, which then gets the bytes, not the URL — through one fetch that:
 *
 *  - accepts only `https:` URLs with no user info;
 *  - refuses a hostname that is an IP literal in a blocked range;
 *  - resolves the name and checks EVERY resolved address, and checks again the
 *    address the socket actually connects to (a lookup hook), so DNS rebinding
 *    between the check and the connect cannot reach a private address;
 *  - follows no redirects, caps the size (25 MB), and writes 0600 files in a
 *    0700 temp directory that is removed after the send.
 *
 * A refused URL is a PERMANENT delivery failure; a network error is transient.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DeliveryError, type ChannelAttachment } from './types.js';

export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/** The WhatsApp message kind for a MIME type (unknown or missing → document). */
export function mediaKindOf(a: ChannelAttachment): MediaKind {
  const t = (a.mimeType ?? '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (!t) {
    const ext = (a.filename ?? a.url).toLowerCase().split('?')[0];
    if (/\.(png|jpe?g|gif|webp)$/.test(ext)) return 'image';
    if (/\.(mp4|mov|webm)$/.test(ext)) return 'video';
    if (/\.(mp3|m4a|ogg|opus|wav)$/.test(ext)) return 'audio';
  }
  return 'document';
}

/** Baileys content for one attachment's BYTES, the caption on the first only. */
export function whatsappMediaContent(a: ChannelAttachment, data: Buffer, caption?: string): Record<string, unknown> {
  const kind = mediaKindOf(a);
  const cap = caption ? { caption } : {};
  if (kind === 'image') return { image: data, ...cap };
  if (kind === 'video') return { video: data, ...cap, ...(a.mimeType ? { mimetype: a.mimeType } : {}) };
  // Baileys sends audio without a caption; the caption then goes as its own text.
  if (kind === 'audio') return { audio: data, mimetype: a.mimeType ?? 'audio/mpeg' };
  let name = a.filename ?? '';
  if (!name) { try { name = basename(new URL(a.url).pathname); } catch { name = ''; } }
  return { document: data, mimetype: a.mimeType ?? 'application/octet-stream', fileName: name || 'attachment', ...cap };
}

// ── address policy ─────────────────────────────────────────────────────────

function v4Octets(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function blockedV4(ip: string): boolean {
  const o = v4Octets(ip);
  if (!o) return true;
  const [a, b, c] = o;
  return a === 0 // "this" network
    || a === 10 // RFC 1918
    || (a === 100 && b >= 64 && b <= 127) // CGNAT RFC 6598
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local, incl. 169.254.169.254 metadata
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol assignments, TEST-NET-1
    || (a === 192 && b === 88 && c === 99) // 6to4 relay anycast
    || (a === 192 && b === 168) // RFC 1918
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224; // multicast, reserved, broadcast
}

/** Expand an IPv6 literal to its 8 hextets (null when it is not one). */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4Octets(v4[2]);
    if (!o) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (parts.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const words = [...head, ...Array(parts.length === 2 ? fill : 0).fill('0'), ...rest].map((h) => parseInt(h, 16));
  const all = [...words, ...tail];
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

function blockedV6(ip: string): boolean {
  const h = v6Hextets(ip);
  if (!h) return true;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (h.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return blockedV4(embeddedV4(h[6], h[7])); // IPv4-mapped
  if (h[0] === 0x64 && h[1] === 0xff9b) return blockedV4(embeddedV4(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return blockedV4(embeddedV4(h[1], h[2])); // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7 (incl. fd00:ec2::254 metadata)
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2001 && h[1] < 0x0200) return true; // Teredo / IETF special (2001::/23)
  return false;
}

/** True when an address may be fetched: a public unicast address. */
export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip.replace(/^\[|\]$/g, ''));
  if (fam === 4) return !blockedV4(ip);
  if (fam === 6) return !blockedV6(ip);
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = (host) => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (err, addrs: LookupAddress[]) => (err ? reject(err) : resolve(addrs.map((a) => a.address))));
});

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * Check a media URL and every address its host resolves to. Throws a PERMANENT
 * DeliveryError when refused. Returns the parsed URL.
 */
export async function assertSafeMediaUrl(raw: string, resolver: Resolver = systemResolver): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new DeliveryError(`media URL is not valid: ${raw}`, true); }
  if (u.protocol !== 'https:') throw new DeliveryError(`media URL must be https (got ${u.protocol})`, true);
  if (u.username || u.password) throw new DeliveryError('media URL must not carry user info', true);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new DeliveryError(`media URL points at a non-public address (${host})`, true);
    return u;
  }
  if (BLOCKED_NAMES.test(host) || !host.includes('.')) throw new DeliveryError(`media URL host is not public (${host})`, true);
  let addrs: string[];
  try { addrs = await resolver(host); } catch (err) { throw new DeliveryError(`media host did not resolve: ${(err as Error).message}`); }
  if (addrs.length === 0) throw new DeliveryError(`media host did not resolve (${host})`);
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) throw new DeliveryError(`media URL host ${host} resolves to a non-public address (${bad})`, true);
  return u;
}

/** A lookup hook for the socket: refuses a non-public address at CONNECT time (DNS rebinding). */
function safeLookup(hostname: string, options: unknown, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void): void {
  const opts = (options ?? {}) as { all?: boolean };
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs: LookupAddress[]) => {
    if (err) return callback(err, '');
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad || addrs.length === 0) return callback(new DeliveryError(`media host resolves to a non-public address (${bad?.address ?? 'none'})`, true), '');
    if (opts.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

export type MediaGetter = (u: URL, maxBytes: number) => Promise<Buffer>;

/** GET over https with the connect-time address check, no redirects, a size cap. */
const httpsGetChecked: MediaGetter = (u, maxBytes) => new Promise((resolve, reject) => {
  const req = httpsRequest(u, { method: 'GET', lookup: safeLookup as never, timeout: 30_000 }, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) { res.resume(); reject(new DeliveryError(`media URL redirected (${status}); redirects are not followed`, true)); return; }
    if (status < 200 || status >= 300) { res.resume(); reject(new DeliveryError(`media download failed: HTTP ${status}`, status === 404 || status === 410)); return; }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > maxBytes) { res.destroy(); reject(new DeliveryError(`media is ${declared} bytes, over the ${maxBytes}-byte limit`, true)); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { res.destroy(); reject(new DeliveryError(`media is over the ${maxBytes}-byte limit`, true)); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', (e) => reject(new DeliveryError(`media download failed: ${e.message}`)));
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', (e) => reject(e instanceof DeliveryError ? e : new DeliveryError(`media download failed: ${e.message}`)));
  req.end();
});

export interface DownloadOptions { maxBytes?: number; resolver?: Resolver; get?: MediaGetter }

// Test seam: the channel plugins call downloadMedia() with no options; a test
// injects a resolver and getter here instead of touching the network.
let defaultMediaOptions: DownloadOptions = {};
export function setMediaOptionsForTests(o: DownloadOptions | undefined): void { defaultMediaOptions = o ?? {}; }

/** Download every attachment (checked) to a private temp dir; `cleanup()` removes it. */
export async function downloadMedia(
  media: readonly ChannelAttachment[],
  given: DownloadOptions = {},
): Promise<{ files: Array<{ path: string; attachment: ChannelAttachment; data: Buffer }>; cleanup: () => void }> {
  const opts = { ...defaultMediaOptions, ...given };
  const max = opts.maxBytes ?? MEDIA_MAX_BYTES;
  // Check every URL BEFORE anything is fetched or written.
  const urls: URL[] = [];
  for (const a of media) urls.push(await assertSafeMediaUrl(a.url, opts.resolver));
  const dir = mkdtempSync(join(tmpdir(), 'openwop-relay-'));
  try { chmodSync(dir, 0o700); } catch { /* best-effort on Windows */ }
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  const files: Array<{ path: string; attachment: ChannelAttachment; data: Buffer }> = [];
  try {
    for (const [i, a] of media.entries()) {
      const data = await (opts.get ?? httpsGetChecked)(urls[i], max);
      if (data.length > max) throw new DeliveryError(`media is ${data.length} bytes, over the ${max}-byte limit`, true);
      const safeName = (a.filename ?? basename(urls[i].pathname) ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
      const path = join(dir, `${i}-${safeName}`);
      writeFileSync(path, data, { mode: 0o600 });
      files.push({ path, attachment: a, data });
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { files, cleanup };
}

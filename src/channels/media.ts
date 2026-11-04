/**
 * Outbound media for the relay channels (openwop-app ADR 1043 D5 "full media").
 *
 * WhatsApp (Baileys) fetches a URL itself, so it only needs the kind. Signal and
 * iMessage send local files, so each attachment is downloaded to a private
 * temporary directory first: `https` only (or `http` to loopback), at most
 * 25 MB, deleted after the send. A failed download is transient (the bridge
 * retries); a size or scheme the relay refuses is permanent.
 */
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

/** Baileys content for one attachment, the caption on the first only. */
export function whatsappMediaContent(a: ChannelAttachment, caption?: string): Record<string, unknown> {
  const kind = mediaKindOf(a);
  const cap = caption ? { caption } : {};
  if (kind === 'image') return { image: { url: a.url }, ...cap };
  if (kind === 'video') return { video: { url: a.url }, ...cap, ...(a.mimeType ? { mimetype: a.mimeType } : {}) };
  // Baileys sends audio without a caption; the caption then goes as its own text.
  if (kind === 'audio') return { audio: { url: a.url }, mimetype: a.mimeType ?? 'audio/mpeg' };
  return {
    document: { url: a.url },
    mimetype: a.mimeType ?? 'application/octet-stream',
    fileName: a.filename ?? (basename(new URL(a.url).pathname) || 'attachment'),
    ...cap,
  };
}

function assertMediaUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new DeliveryError(`media URL is not valid: ${raw}`, true); }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new DeliveryError(`media URL must be https (got ${u.protocol})`, true);
  }
  return u;
}

/** Download every attachment to a private temp dir; `cleanup()` removes it. */
export async function downloadMedia(
  media: readonly ChannelAttachment[],
  opts: { fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<{ files: Array<{ path: string; attachment: ChannelAttachment }>; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'openwop-relay-'));
  try { chmodSync(dir, 0o700); } catch { /* best-effort on Windows */ }
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  const max = opts.maxBytes ?? MEDIA_MAX_BYTES;
  const files: Array<{ path: string; attachment: ChannelAttachment }> = [];
  try {
    for (const [i, a] of media.entries()) {
      const u = assertMediaUrl(a.url);
      let res: Response;
      try { res = await (opts.fetchImpl ?? fetch)(u); }
      catch (err) { throw new DeliveryError(`media download failed: ${(err as Error).message}`); }
      if (!res.ok) throw new DeliveryError(`media download failed: HTTP ${res.status}`, res.status === 404 || res.status === 410);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > max) throw new DeliveryError(`media is ${declared} bytes, over the ${max}-byte limit`, true);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) throw new DeliveryError(`media is ${buf.length} bytes, over the ${max}-byte limit`, true);
      const safeName = (a.filename ?? basename(u.pathname) ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
      const path = join(dir, `${i}-${safeName}`);
      writeFileSync(path, buf, { mode: 0o600 });
      files.push({ path, attachment: a });
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { files, cleanup };
}

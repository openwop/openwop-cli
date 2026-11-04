/**
 * Pure normalizers: platform-specific inbound payload → canonical
 * InboundMessage. These are the unit-test target for B4 — they isolate the
 * fiddly per-platform parsing from the I/O (spawn / sqlite / socket), so the
 * receive path is verifiable without a live platform.
 *
 * Each returns null for payloads that aren't deliverable inbound text
 * (receipts, typing indicators, our own outgoing echoes, empty bodies).
 */

import type { InboundMessage, RelayChannel } from './types.js';

/** ADR 1043 D6 — what a normalizer needs to recognise the note-to-self chat. */
export interface NormalizeOptions { accountId?: string }

/**
 * The device's own account id in the SAME form the channel's conversation ids
 * take, so the host's note-to-self check (chat id === account id, ADR 1042 N1)
 * can match: WhatsApp a JID (`15551234567@s.whatsapp.net`), Signal an E.164
 * number, iMessage the handle as typed (an E.164 number or an Apple ID email).
 * Returns undefined for an empty or malformed id.
 */
export function normalizeAccountId(channel: RelayChannel | string, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  // The id comes from inbound peer data, so bound it before ANY regex runs (an
  // address is at most 254 characters; RFC 5321). CodeQL js/polynomial-redos.
  if (!v || v.length > 254) return undefined;
  if (channel === 'whatsapp') {
    if (/^\d{6,15}@s\.whatsapp\.net$/.test(v)) return v;
    const digits = v.replace(/[\s()+-]/g, '');
    return /^\d{6,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : undefined;
  }
  if (channel === 'signal') {
    const e164 = v.replace(/[\s()-]/g, '');
    return /^\+\d{6,15}$/.test(e164) ? e164 : undefined;
  }
  if (channel === 'imessage') {
    // Non-overlapping labels: no character can match both sides of a dot, so the
    // test is linear even without the length cap above.
    if (/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(v)) return v.toLowerCase();
    const e164 = v.replace(/[\s()-]/g, '');
    return /^\+\d{6,15}$/.test(e164) ? e164 : undefined;
  }
  return /^[A-Za-z0-9_.:+@-]{1,128}$/.test(v) ? v : undefined;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: { message?: unknown; groupInfo?: { groupId?: string }; mentions?: Array<{ uuid?: string; number?: string }> };
  syncMessage?: { sentMessage?: { destination?: string; destinationNumber?: string; timestamp?: number; message?: unknown; groupInfo?: { groupId?: string } } };
}
interface SignalRaw { envelope?: SignalEnvelope; params?: { envelope?: SignalEnvelope } }

interface WaContext { mentionedJid?: string[] }
interface WaMessage {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string; contextInfo?: WaContext };
    imageMessage?: { caption?: string; mimetype?: string; contextInfo?: WaContext };
    videoMessage?: { caption?: string; mimetype?: string; contextInfo?: WaContext };
    documentMessage?: { caption?: string; mimetype?: string; fileName?: string; contextInfo?: WaContext };
  };
  pushName?: string;
  messageTimestamp?: number | string;
}

/**
 * signal-cli `receive --json` / JSON-RPC envelope. Shape (subset):
 *   { envelope: { source, sourceName, timestamp, dataMessage: { message, groupInfo? } } }
 * Group messages route on the groupId; DMs route on the source number.
 */
export function parseSignalEnvelope(raw: unknown, opts: NormalizeOptions = {}): InboundMessage | null {
  const r = raw as SignalRaw;
  const env = r?.envelope ?? r?.params?.envelope;
  if (!env || typeof env !== 'object') return null;
  // ADR 1043 D6 — a sync of a message this account sent. Only the note-to-self
  // chat (destination === the account) is forwarded, marked from-me.
  const sent = env.syncMessage?.sentMessage;
  if (sent) {
    const dest = sent.destination ?? sent.destinationNumber;
    if (!opts.accountId || sent.groupInfo?.groupId || dest !== opts.accountId) return null;
    if (typeof sent.message !== 'string' || sent.message.length === 0) return null;
    const ts = typeof sent.timestamp === 'number' ? sent.timestamp : (typeof env.timestamp === 'number' ? env.timestamp : Date.now());
    return {
      platformMessageId: `${opts.accountId}:${ts}`,
      conversationId: opts.accountId,
      peerId: opts.accountId,
      text: sent.message,
      timestamp: new Date(ts).toISOString(),
      fromMe: true,
    };
  }
  const data = env.dataMessage;
  if (!data || typeof data.message !== 'string' || data.message.length === 0) return null;
  const source: string | undefined = env.source ?? env.sourceNumber ?? env.sourceUuid;
  if (!source) return null;
  const groupId: string | undefined = data.groupInfo?.groupId;
  const conversationId = groupId ? `group:${groupId}` : source;
  const ts = typeof env.timestamp === 'number' ? env.timestamp : Date.now();
  const mentions = (data.mentions ?? []).map((m) => m.uuid ?? m.number).filter((m): m is string => typeof m === 'string' && m.length > 0);
  return {
    platformMessageId: `${source}:${env.timestamp ?? ts}`,
    conversationId,
    peerId: source,
    ...(typeof env.sourceName === 'string' && env.sourceName ? { peerDisplay: env.sourceName } : {}),
    text: data.message,
    timestamp: new Date(ts).toISOString(),
    ...(groupId ? { channelMeta: { groupId } } : {}),
    ...(mentions.length ? { mentions } : {}),
  };
}

/**
 * A macOS Messages `chat.db` row joined across message + handle + chat. We poll
 * by a monotonic ROWID cursor; this maps one row. `is_from_me=1` rows are our
 * own sends — skipped. Apple's `date` is ns since 2001-01-01; callers may pass
 * an already-ISO `dateUtc` instead (the poller computes it), preferred when set.
 */
export function parseImessageRow(row: Record<string, unknown>, opts: NormalizeOptions = {}): InboundMessage | null {
  // ADR 1043 D6 — from-me rows are forwarded only in the note-to-self chat (the
  // handle is the account), marked from-me. The mirrored received copy of a
  // note-to-self (is_from_me = 0 from your own handle) is dropped so it is not
  // also taken as a contact's message.
  const handleRaw = (row.handle_id_str ?? row.handle ?? row.sender) as string | undefined;
  const ownHandle = !!opts.accountId && typeof handleRaw === 'string' && handleRaw.toLowerCase() === opts.accountId.toLowerCase();
  const fromMe = Number(row.is_from_me) === 1;
  if (fromMe && !ownHandle) return null;
  if (!fromMe && ownHandle) return null;
  // On modern macOS `message.text` is frequently NULL and the visible body lives
  // in the `attributedBody` BLOB (a serialized NSAttributedString). The poller
  // selects it as hex (`hex(attributedBody) AS attributed_body_hex`); fall back
  // to decoding it when `text` is empty, else most inbound messages parse blank.
  let text = typeof row.text === 'string' ? row.text : '';
  if (text.length === 0) {
    const hex = (row.attributed_body_hex ?? row.attributedBody) as string | undefined;
    text = decodeAttributedBodyHex(hex) ?? '';
  }
  if (text.length === 0) return null;
  const handle = (row.handle_id_str ?? row.handle ?? row.sender) as string | undefined;
  if (!handle) return null;
  const chatGuid = (row.chat_guid ?? row.cache_roomnames) as string | undefined;
  const conversationId = chatGuid ? `chat:${chatGuid}` : handle;
  const timestamp = typeof row.dateUtc === 'string' && row.dateUtc
    ? row.dateUtc
    : appleNsToIso(row.date);
  const rowid = row.ROWID ?? row.rowid ?? row.message_id ?? `${handle}:${timestamp}`;
  return {
    platformMessageId: String(rowid),
    conversationId: fromMe ? opts.accountId ?? conversationId : conversationId,
    peerId: handle,
    text,
    timestamp,
    ...(fromMe ? { fromMe: true } : {}),
  };
}

/**
 * A Baileys `messages.upsert` message object (WhatsApp Web). Shape (subset):
 *   { key: { remoteJid, fromMe, id }, message: { conversation? | extendedTextMessage:{text} },
 *     pushName?, messageTimestamp? }
 */
export function parseWhatsappMessage(raw: unknown, opts: NormalizeOptions = {}): InboundMessage | null {
  const m = raw as WaMessage;
  if (!m?.key) return null;
  const remoteJid: string | undefined = m.key.remoteJid;
  if (!remoteJid) return null;
  // ADR 1043 D6 — from-me is forwarded only in the note-to-self chat.
  const fromMe = m.key.fromMe === true;
  if (fromMe && (!opts.accountId || remoteJid !== opts.accountId)) return null;
  const msg = m.message ?? {};
  const text: string | undefined =
    msg.conversation ?? msg.extendedTextMessage?.text
    ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? msg.documentMessage?.caption;
  if (typeof text !== 'string' || text.length === 0) return null;
  const mentioned = msg.extendedTextMessage?.contextInfo?.mentionedJid
    ?? msg.imageMessage?.contextInfo?.mentionedJid ?? msg.videoMessage?.contextInfo?.mentionedJid ?? [];
  const tsSec = Number(m.messageTimestamp ?? 0);
  const timestamp = tsSec > 0 ? new Date(tsSec * 1000).toISOString() : new Date().toISOString();
  // The peer is the participant in groups (remoteJid is the group), else remoteJid.
  const peerId: string = m.key.participant ?? remoteJid;
  return {
    platformMessageId: String(m.key.id ?? `${remoteJid}:${tsSec}`),
    conversationId: remoteJid,
    peerId,
    ...(typeof m.pushName === 'string' && m.pushName ? { peerDisplay: m.pushName } : {}),
    text,
    timestamp,
    ...(mentioned.length ? { mentions: mentioned } : {}),
    ...(fromMe ? { fromMe: true } : {}),
  };
}

interface DiscordMessageLike {
  id?: string;
  content?: string;
  channelId?: string;
  guildId?: string | null;
  author?: { id?: string; username?: string; bot?: boolean };
  createdTimestamp?: number;
  reference?: { messageId?: string } | null;
  attachments?: Iterable<{ url?: string; contentType?: string; name?: string }> | { values?: () => Iterable<{ url?: string; contentType?: string; name?: string }> };
}

/**
 * A discord.js Message → canonical InboundMessage. conversationId is the
 * channelId (DMs have one too); peerId/peerDisplay come from the author; the
 * guildId rides in channelMeta. Bot messages (incl. our own) are dropped — the
 * plugin also filters on the bot's user id, but this is a pure backstop.
 * `attachments` may be a discord.js Collection (has .values()) or a plain array.
 */
export function parseDiscordMessage(raw: unknown): InboundMessage | null {
  const m = raw as DiscordMessageLike;
  if (!m || m.author?.bot) return null;
  const channelId = m.channelId;
  const authorId = m.author?.id;
  if (!channelId || !authorId) return null;
  const text = typeof m.content === 'string' ? m.content : '';
  // Collect attachments from a Collection (.values()) or an array.
  const attIter = m.attachments && typeof (m.attachments as { values?: unknown }).values === 'function'
    ? (m.attachments as { values: () => Iterable<{ url?: string; contentType?: string; name?: string }> }).values()
    : (m.attachments as Iterable<{ url?: string; contentType?: string; name?: string }> | undefined);
  const media: InboundMessage['media'] = [];
  if (attIter) {
    for (const a of attIter) {
      if (a && typeof a.url === 'string') {
        media.push({ url: a.url, ...(a.contentType ? { mimeType: a.contentType } : {}), ...(a.name ? { filename: a.name } : {}) });
      }
    }
  }
  if (text.length === 0 && media.length === 0) return null;
  const ts = typeof m.createdTimestamp === 'number' ? m.createdTimestamp : Date.now();
  return {
    platformMessageId: String(m.id ?? `${channelId}:${ts}`),
    conversationId: channelId,
    peerId: authorId,
    ...(m.author?.username ? { peerDisplay: m.author.username } : {}),
    text,
    timestamp: new Date(ts).toISOString(),
    ...(media.length ? { media } : {}),
    ...(m.reference?.messageId ? { quotedMessageId: m.reference.messageId } : {}),
    ...(m.guildId ? { channelMeta: { guildId: m.guildId } } : {}),
  };
}

/**
 * Apple Core Data timestamp → ISO string. Modern macOS stores `message.date`
 * as nanoseconds since 2001-01-01 UTC; pre-High-Sierra stored seconds. Detect
 * by magnitude (ns for a recent date is ~1e17; seconds ~5e8) so both decode.
 */
function appleNsToIso(raw: unknown): string {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return new Date().toISOString();
  const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
  const offsetMs = v > 1e12 ? v / 1_000_000 : v * 1000; // ns vs seconds
  return new Date(APPLE_EPOCH_MS + offsetMs).toISOString();
}

/**
 * Extract the visible text from a hex-encoded `attributedBody` BLOB (a
 * `streamtyped`-archived NSAttributedString). Heuristic — no NSKeyedUnarchiver
 * available in Node: locate the `NSString` class marker, then the `+` (0x2B)
 * value marker, then a length prefix (1 byte; or 0x81 + 2-byte LE; 0x82 +
 * 4-byte LE for long strings), then read that many UTF-8 bytes. Returns null
 * when the shape isn't recognized rather than guessing.
 */
export function decodeAttributedBodyHex(hex: unknown): string | null {
  if (typeof hex !== 'string' || hex.length < 4) return null;
  let buf: Buffer;
  try { buf = Buffer.from(hex, 'hex'); } catch { return null; }
  if (buf.length === 0) return null;
  const marker = buf.indexOf('NSString', 0, 'latin1');
  if (marker < 0) return null;
  let i = buf.indexOf(0x2b, marker); // '+' value marker
  if (i < 0) return null;
  i += 1;
  if (i >= buf.length) return null;
  let len = buf[i]; i += 1;
  if (len === 0x81) { len = buf[i] | (buf[i + 1] << 8); i += 2; }
  else if (len === 0x82) { len = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24); i += 4; }
  if (!Number.isFinite(len) || len <= 0 || i + len > buf.length) return null;
  const text = buf.subarray(i, i + len).toString('utf8');
  return text.length ? text : null;
}

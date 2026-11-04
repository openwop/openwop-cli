/**
 * Channel plugin registry (A4). Each plugin wraps one platform's tooling;
 * the parsing logic lives in `normalize.ts` (unit-tested), so these modules
 * are thin spawn/socket adapters. Delivery mirrors the previously-inline
 * signal-cli / AppleScript logic; receive (B4) streams inbound back.
 *
 * Platform tooling can't run in CI, so `isAvailable` fails closed and the
 * receive loops are exercised in tests via a mock ChannelPlugin + the pure
 * normalizers — the same way you'd test this without a live account.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { DeliveryError, type ChannelAvailability, type ChannelPlugin, type DeliverResult, type InboundMessage, type OutboundMessage, type RelayChannel } from './types.js';
import { parseImessageRow, parseSignalEnvelope, parseWhatsappMessage, parseDiscordMessage } from './normalize.js';
import { computeBackoff, sleep } from './reliability.js';
import { downloadMedia, mediaKindOf, whatsappMediaContent } from './media.js';

const IS_DARWIN = process.platform === 'darwin';
// Named `_require` so it doesn't clash with the esbuild bundle banner's own
// `require` shim; used only to synchronously detect optional channel deps.
const _require = createRequire(import.meta.url);

/** True when an optional channel dependency is installed (sync resolve). */
function depInstalled(pkg: string): boolean {
  try { _require.resolve(pkg); return true; } catch { return false; }
}

function signalAvailable(env: NodeJS.ProcessEnv): ChannelAvailability {
  // Daemon mode: a configured signal-cli HTTP daemon makes the channel usable
  // without the local binary on PATH (it can run on another host).
  if (env.OPENWOP_SIGNAL_DAEMON_URL) {
    return { channel: 'signal', available: true, detail: `signal-cli daemon ${env.OPENWOP_SIGNAL_DAEMON_URL}` };
  }
  const probe = spawnSync('signal-cli', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return { channel: 'signal', available: true, detail: (probe.stdout || '').trim() || 'signal-cli present' };
  return { channel: 'signal', available: false, detail: 'signal-cli not found on PATH — install from https://github.com/AsamK/signal-cli (or set OPENWOP_SIGNAL_DAEMON_URL)' };
}

/** Join a path onto a base URL, preserving any base path prefix (unlike an
 * absolute-path URL, which would discard `http://host/prefix`). */
function joinUrl(base: string, path: string): URL {
  return new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
}

/**
 * POST one JSON-RPC call to a signal-cli `daemon --http` endpoint and return
 * the parsed result. Used for daemon-mode delivery.
 */
async function signalDaemonRpc(baseUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(joinUrl(baseUrl, 'api/v1/rpc'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(`signal-cli daemon ${method} failed: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body;
}

/** Recipient params for a signal-cli JSON-RPC call: a group id or a DM recipient. */
function signalTarget(conversationId: string): { groupId: string } | { recipient: string[] } {
  if (conversationId.startsWith('group:')) return { groupId: conversationId.slice('group:'.length) };
  return { recipient: [conversationId] };
}

const signalPlugin: ChannelPlugin = {
  channel: 'signal',
  isAvailable: (env = process.env) => signalAvailable(env),
  async deliver(msg: OutboundMessage): Promise<DeliverResult> {
    const account = process.env.OPENWOP_SIGNAL_ACCOUNT;
    const daemon = process.env.OPENWOP_SIGNAL_DAEMON_URL;
    const group = msg.conversationId.startsWith('group:') ? msg.conversationId.slice('group:'.length) : undefined;
    // ADR 1043 D5 — every attachment, downloaded to a private temp dir first.
    const dl = msg.media && msg.media.length ? await downloadMedia(msg.media) : undefined;
    try {
      const attachments = dl ? dl.files.map((f) => f.path) : [];
      if (daemon) {
        const body = await signalDaemonRpc(daemon, 'send', {
          ...(account ? { account } : {}),
          ...signalTarget(msg.conversationId),
          message: msg.text,
          ...(attachments.length ? { attachments } : {}),
        }) as { result?: { timestamp?: number } };
        const ts = body?.result?.timestamp;
        return { platformMessageIds: account && typeof ts === 'number' ? [`${account}:${ts}`] : [] };
      }
      const args = [...(account ? ['-a', account] : []), 'send', '-m', msg.text, ...attachments.flatMap((a) => ['--attachment', a]), ...(group ? ['-g', group] : [msg.conversationId])];
      const r = spawnSync('signal-cli', args, { encoding: 'utf8' });
      if (r.status !== 0) {
        const err = (r.stderr || '').trim();
        // An unregistered or unknown recipient will never succeed.
        throw new DeliveryError(`signal-cli send failed: ${err || r.status}`, /unregistered|not a valid|invalid number/i.test(err));
      }
      return {};
    } finally {
      dl?.cleanup();
    }
  },
  async setTyping(conversationId: string, on: boolean) {
    const account = process.env.OPENWOP_SIGNAL_ACCOUNT;
    const daemon = process.env.OPENWOP_SIGNAL_DAEMON_URL;
    if (daemon) {
      await signalDaemonRpc(daemon, 'sendTyping', { ...(account ? { account } : {}), ...signalTarget(conversationId), ...(on ? {} : { stop: true }) });
      return;
    }
    const group = conversationId.startsWith('group:') ? conversationId.slice('group:'.length) : undefined;
    spawnSync('signal-cli', [...(account ? ['-a', account] : []), 'sendTyping', ...(on ? [] : ['-s']), ...(group ? ['-g', group] : [conversationId])], { encoding: 'utf8' });
  },
  async startReceive(onInbound, opts = {}) {
    const env = opts.env ?? process.env;
    const daemon = env.OPENWOP_SIGNAL_DAEMON_URL;
    const pause = opts.sleepFn ?? ((ms: number) => sleep(ms));
    const forward = async (payload: unknown) => {
      opts.onActivity?.();
      const msg = parseSignalEnvelope(payload, { ...(opts.accountId ? { accountId: opts.accountId } : {}) });
      if (msg) await onInbound(msg);
    };

    // Daemon mode: stream the SSE event feed (each `data:` line is a JSON-RPC
    // `receive` notification). Reconnects with backoff and full jitter (ADR 1043
    // D5), the attempt count reset by any frame. This is the production
    // transport; the spawn loop below is the local-binary fallback.
    if (daemon) {
      const eventsPath = env.OPENWOP_SIGNAL_EVENTS_PATH || '/api/v1/events';
      let stopped = false;
      const ctrl = new AbortController();
      const run = async () => {
        let attempt = 0;
        while (!stopped) {
          try {
            const res = await fetch(joinUrl(daemon, eventsPath), {
              headers: { accept: 'text/event-stream' },
              signal: ctrl.signal,
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            opts.onActivity?.();
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              attempt = 0;
              buf += decoder.decode(value, { stream: true });
              // SSE frames are separated by a blank line; each carries `data:`.
              let sep: number;
              while ((sep = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
                for (const line of frame.split('\n')) {
                  if (!line.startsWith('data:')) continue;
                  const data = line.slice(5).trim();
                  if (!data) continue;
                  try { await forward(JSON.parse(data)); } catch { /* skip malformed frame */ }
                }
              }
            }
          } catch {
            if (stopped) return;
          }
          if (!stopped) await pause(computeBackoff(attempt++));
        }
      };
      void run();
      return () => { stopped = true; ctrl.abort(); };
    }

    // Fallback: spawn `signal-cli -a <acct> receive --json` on a re-spawn loop, with backoff.
    const account = env.OPENWOP_SIGNAL_ACCOUNT;
    if (!account) throw new Error('OPENWOP_SIGNAL_ACCOUNT (the registered Signal number) is required for receive, or set OPENWOP_SIGNAL_DAEMON_URL.');
    let stopped = false;
    let attempt = 0;
    let child: ReturnType<typeof spawn> | undefined;
    const tick = () => {
      if (stopped) return;
      child = spawn('signal-cli', ['-a', account, 'receive', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const rl = createInterface({ input: child.stdout! });
      rl.on('line', async (line) => {
        if (!line.trim()) return;
        attempt = 0;
        try { await forward(JSON.parse(line)); } catch { /* skip malformed line */ }
      });
      child.on('exit', () => {
        opts.onActivity?.();
        if (!stopped) void pause(computeBackoff(attempt++)).then(tick);
      });
      child.on('error', () => { /* exit follows */ });
    };
    tick();
    return () => { stopped = true; try { child?.kill(); } catch { /* ignore */ } };
  },
};

/** AppleScript string literal (JSON escaping is a safe subset for `"`, `\\` and control chars). */
const asString = (v: string): string => JSON.stringify(v);

const imessagePlugin: ChannelPlugin = {
  channel: 'imessage',
  isAvailable: (env = process.env) =>
    (env.OPENWOP_FORCE_PLATFORM ?? process.platform) === 'darwin'
      ? { channel: 'imessage', available: true, detail: 'macOS — needs Messages signed in + Full Disk Access for chat.db' }
      : { channel: 'imessage', available: false, detail: 'iMessage requires macOS (Messages.app + chat.db)' },
  async deliver(msg: OutboundMessage): Promise<DeliverResult> {
    const buddy = asString(msg.conversationId.replace(/^chat:/, ''));
    const target = `buddy ${buddy} of (service 1 whose service type is iMessage)`;
    // ADR 1043 D5 — the text, then every attachment as a POSIX file.
    const dl = msg.media && msg.media.length ? await downloadMedia(msg.media) : undefined;
    try {
      const lines: string[] = [];
      if (msg.text) lines.push(`send ${asString(msg.text)} to ${target}`);
      for (const f of dl?.files ?? []) lines.push(`send (POSIX file ${asString(f.path)}) to ${target}`);
      if (lines.length === 0) return {};
      const script = `tell application "Messages"\n${lines.join('\n')}\nend tell`;
      const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
      if (r.status !== 0) {
        const err = (r.stderr || '').trim();
        throw new DeliveryError(`osascript send failed: ${err || r.status}`, /Can.t get buddy|Invalid key form/i.test(err));
      }
      // Messages gives no message id back; the echo guard falls back to the text hash.
      return {};
    } finally {
      // Messages copies the file when it sends; give it a moment before removal.
      if (dl) setTimeout(() => dl.cleanup(), 30_000).unref?.();
    }
  },
  async startReceive(onInbound, opts = {}) {
    if (!IS_DARWIN) throw new Error('iMessage receive requires macOS.');
    const { homedir } = await import('node:os');
    const dbPath = `${homedir()}/Library/Messages/chat.db`;
    const pause = opts.sleepFn ?? ((ms: number) => sleep(ms));
    let lastRowId = -1;
    let stopped = false;
    let attempt = 0;
    const poll = async () => {
      while (!stopped) {
        // Query via the sqlite3 CLI to avoid a native dep; -json gives rows.
        // hex(attributedBody): modern macOS leaves m.text NULL and stores the body
        // in the attributedBody BLOB; hex keeps it intact through `sqlite3 -json`.
        // The first poll only reads the cursor, so history is never replayed.
        const sql = lastRowId < 0
          ? 'SELECT COALESCE(MAX(ROWID), 0) AS ROWID FROM message;'
          : `SELECT m.ROWID as ROWID, m.text as text, hex(m.attributedBody) as attributed_body_hex, m.is_from_me as is_from_me, m.date as date, h.id as handle_id_str FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.ROWID > ${lastRowId} ORDER BY m.ROWID ASC LIMIT 50;`;
        const r = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
        if (r.status === 0) {
          attempt = 0;
          opts.onActivity?.();
          if (r.stdout.trim()) {
            try {
              const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
              if (lastRowId < 0) lastRowId = Number(rows[0]?.ROWID) || 0;
              else {
                for (const row of rows) {
                  lastRowId = Math.max(lastRowId, Number(row.ROWID) || 0);
                  const msg = parseImessageRow(row, { ...(opts.accountId ? { accountId: opts.accountId } : {}) });
                  if (msg) await onInbound(msg);
                }
              }
            } catch { /* skip */ }
          } else if (lastRowId < 0) lastRowId = 0;
          await pause(2000);
        } else {
          // chat.db unreadable (Full Disk Access revoked, Messages migrating): back off.
          await pause(computeBackoff(attempt++, { baseMs: 2000 }));
        }
      }
    };
    void poll();
    return () => { stopped = true; };
  },
};

const WA_PKG = '@whiskeysockets/baileys';

/** Baileys' `DisconnectReason.loggedOut` status (the linked device was removed). */
const WA_LOGGED_OUT = 401;

// Test seam: a recorded-fixture stand-in for the Baileys module (ADR 1043 D8).
let waModuleOverride: unknown;
export function setWhatsappModuleForTests(mod: unknown): void { waModuleOverride = mod; waConnP = undefined; }

// A single shared WhatsApp Web (Baileys) connection so deliver() and
// startReceive() use the same socket + auth session. We cache the in-flight
// PROMISE (not just the resolved socket) so two near-simultaneous callers
// (first deliver + first startReceive) can't each spawn a second login. ADR
// 1043 D5: the cache is cleared when the socket CLOSES, so the next caller
// reconnects instead of sending on a dead socket.
let waConnP: Promise<any> | undefined;
const waCloseListeners = new Set<(info: { loggedOut: boolean; error: Error }) => void>();

async function loadBaileys(): Promise<any> {
  if (waModuleOverride) return waModuleOverride;
  // Optional heavy dep — a variable specifier keeps tsc/esbuild from
  // resolving the (possibly absent) module at build time; `any` (Baileys
  // ships its own types we don't pin here).
  try { return await import(WA_PKG); }
  catch { throw new Error(`WhatsApp requires ${WA_PKG} — install it (\`npm i -g ${WA_PKG}\`) or in the CLI channel build.`); }
}

async function getWaSocket(env: NodeJS.ProcessEnv): Promise<any> {
  if (!waConnP) {
    const p: Promise<any> = (async () => {
      const baileys = await loadBaileys();
      const { makeWASocket, useMultiFileAuthState } = baileys.default ?? baileys;
      const authDir = env.OPENWOP_WHATSAPP_AUTH_DIR || `${env.HOME}/.openwop/whatsapp-auth`;
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      // printQRInTerminal: scan once to link (multi-device session persists in
      // authDir thereafter). Never in a background service: there is no one to
      // scan it, and a fresh QR there means the link was lost (ADR 1043 D5).
      const sock = makeWASocket({ auth: state, printQRInTerminal: process.stdout.isTTY === true });
      sock.ev.on('creds.update', saveCreds);
      // The socket connects asynchronously; wait for `connection: 'open'`
      // before returning so the first deliver() doesn't send on a dead socket.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WhatsApp connection timed out (scan the QR within 90s, or check the linked session)')), 90_000);
        let opened = false;
        sock.ev.on('connection.update', (u: any) => {
          if (u?.connection === 'open') { opened = true; clearTimeout(timer); resolve(); return; }
          if (u?.connection !== 'close') return;
          const status = Number(u?.lastDisconnect?.error?.output?.statusCode ?? 0);
          const loggedOut = status === WA_LOGGED_OUT;
          const error = new Error(loggedOut ? 'WhatsApp logged this device out — link it again with `openwop relay start` in a terminal' : `WhatsApp connection closed (${status || 'no status'})`);
          if (waConnP === p) waConnP = undefined;
          if (!opened) { clearTimeout(timer); reject(error); return; }
          for (const l of [...waCloseListeners]) l({ loggedOut, error });
        });
      });
      return sock;
    })().catch((err) => { if (waConnP === p) waConnP = undefined; throw err; }); // allow retry after failure
    waConnP = p;
  }
  return waConnP;
}

/** The quoted-message reference Baileys needs for a reply or a reaction. */
const waKey = (jid: string, id: string) => ({ id, remoteJid: jid, fromMe: false });

const whatsappPlugin: ChannelPlugin = {
  channel: 'whatsapp',
  isAvailable: (env = process.env) =>
    waModuleOverride || depInstalled(WA_PKG)
      ? { channel: 'whatsapp', available: true, detail: 'Baileys present (WhatsApp Web, multi-device)' }
      : { channel: 'whatsapp', available: false, detail: `WhatsApp needs ${WA_PKG} (optional dep): \`npm i -g ${WA_PKG}\`` },
  async deliver(msg: OutboundMessage): Promise<DeliverResult> {
    const sock = await getWaSocket(process.env);
    const jid = msg.conversationId;
    const ids: string[] = [];
    const record = (sent: any) => { if (sent?.key?.id) ids.push(String(sent.key.id)); };
    const quoted = msg.replyToMessageId ? { quoted: { key: waKey(jid, msg.replyToMessageId) } } : {};
    // Reactions deliver as Baileys reactions on the target message.
    if (msg.reactions && msg.reactions.length && msg.replyToMessageId) {
      for (const emoji of msg.reactions) {
        record(await sock.sendMessage(jid, { react: { text: emoji, key: waKey(jid, msg.replyToMessageId) } }));
      }
      if (!msg.text && !(msg.media && msg.media.length)) return { platformMessageIds: ids };
    }
    // Quick-reply components → appended as text (Baileys interactive buttons are
    // unreliable across WhatsApp clients; degrade gracefully rather than fail).
    let text = msg.text;
    if (msg.components && msg.components.length) {
      text = [text, ...msg.components.map((c) => `• ${c.label}`)].filter(Boolean).join('\n');
    }
    // ADR 1043 D5 — EVERY attachment, typed by MIME, the caption on the first
    // (audio cannot carry one, so its text goes as its own message).
    const media = msg.media ?? [];
    if (media.length === 0) {
      record(await sock.sendMessage(jid, { text }, quoted));
      return { platformMessageIds: ids };
    }
    // ADR 1043 H1 — never hand Baileys a URL: download it here, through the same
    // public-https-only, connect-time-checked fetch every channel uses, and send bytes.
    const dl = await downloadMedia(media);
    try {
      let captionLeft = text;
      for (const [i, f] of dl.files.entries()) {
        const a = f.attachment;
        const content = whatsappMediaContent(a, f.data, mediaKindOf(a) === 'audio' ? undefined : captionLeft || undefined);
        if (mediaKindOf(a) !== 'audio') captionLeft = '';
        record(await sock.sendMessage(jid, content, i === 0 ? quoted : {}));
      }
      if (captionLeft) record(await sock.sendMessage(jid, { text: captionLeft }));
    } finally {
      dl.cleanup();
    }
    return { platformMessageIds: ids };
  },
  async setTyping(conversationId: string, on: boolean) {
    const sock = await getWaSocket(process.env);
    await sock.sendPresenceUpdate?.(on ? 'composing' : 'paused', conversationId);
  },
  async startReceive(onInbound, opts = {}) {
    const env = opts.env ?? process.env;
    const pause = opts.sleepFn ?? ((ms: number) => sleep(ms));
    let stopped = false;
    let current: any;
    const handler = async (up: any) => {
      opts.onActivity?.();
      for (const m of up.messages ?? []) {
        const msg = parseWhatsappMessage(m, { ...(opts.accountId ? { accountId: opts.accountId } : {}) });
        if (msg) await onInbound(msg);
      }
    };
    const attach = (sock: any) => { current = sock; sock.ev.on('messages.upsert', handler); opts.onActivity?.(); };
    // ADR 1043 D5 — reconnect after a close, with backoff; a logout is fatal.
    let attempt = 0;
    const reconnect = async () => {
      while (!stopped) {
        await pause(computeBackoff(attempt++));
        if (stopped) return;
        try { attach(await getWaSocket(env)); attempt = 0; return; }
        catch (err) { if (/logged this device out/.test((err as Error).message)) { opts.onFatal?.(err as Error); return; } }
      }
    };
    const onClose = ({ loggedOut, error }: { loggedOut: boolean; error: Error }) => {
      try { current?.ev.off?.('messages.upsert', handler); } catch { /* ignore */ }
      if (stopped) return;
      if (loggedOut) { opts.onFatal?.(error); return; }
      void reconnect();
    };
    waCloseListeners.add(onClose);
    try { attach(await getWaSocket(env)); }
    catch (err) { waCloseListeners.delete(onClose); throw err; }
    return () => {
      stopped = true;
      waCloseListeners.delete(onClose);
      try { current?.ev.off?.('messages.upsert', handler); } catch { /* ignore */ }
      try { current?.end?.(); } catch { /* ignore */ }
      waConnP = undefined;
    };
  },
};

const DISCORD_PKG = 'discord.js';

// Shared discord.js Gateway client (bot) so deliver() + startReceive() share
// one connection. Cache the in-flight PROMISE (not just the resolved conn) so
// concurrent first callers can't each log in a second client.
let discordConnP: Promise<{ client: any; djs: any; botId?: string }> | undefined;

async function getDiscordClient(env: NodeJS.ProcessEnv): Promise<{ client: any; djs: any; botId?: string }> {
  if (!discordConnP) {
    discordConnP = (async () => {
      const token = env.OPENWOP_DISCORD_BOT_TOKEN;
      if (!token) throw new Error('OPENWOP_DISCORD_BOT_TOKEN (a Discord bot token) is required for Discord.');
      let djs: any;
      try { djs = await import(DISCORD_PKG); }
      catch { throw new Error(`Discord requires ${DISCORD_PKG} — install it (\`npm i -g ${DISCORD_PKG}\`) or in the CLI channel build.`); }
      const { Client, GatewayIntentBits } = djs;
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildMessageReactions,
        ],
      });
      // 'ready' (discord.js v14) / 'clientReady' (v15) — register both.
      const ready = new Promise<void>((resolve) => { client.once('clientReady', resolve); client.once('ready', resolve); });
      await client.login(token);
      await ready;
      return { client, djs, botId: client.user?.id };
    })().catch((err) => { discordConnP = undefined; throw err; }); // allow retry after failure
  }
  return discordConnP;
}

/** Build discord.js action rows from envelope-v2 components (reply→button, link→link button). */
function buildDiscordComponents(djs: any, components: NonNullable<OutboundMessage['components']>): unknown[] {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = djs;
  const row = new ActionRowBuilder();
  for (const c of components.slice(0, 5)) {
    const b = new ButtonBuilder().setLabel(c.label);
    if (c.style === 'link' && c.url) b.setStyle(ButtonStyle.Link).setURL(c.url);
    else b.setStyle(ButtonStyle.Primary).setCustomId(c.id);
    row.addComponents(b);
  }
  return [row];
}

const discordPlugin: ChannelPlugin = {
  channel: 'discord',
  isAvailable: (env = process.env) => {
    if (!depInstalled(DISCORD_PKG)) {
      return { channel: 'discord', available: false, detail: `Discord needs ${DISCORD_PKG} (optional dep): \`npm i -g ${DISCORD_PKG}\`` };
    }
    if (!env.OPENWOP_DISCORD_BOT_TOKEN) {
      return { channel: 'discord', available: false, detail: 'discord.js present but OPENWOP_DISCORD_BOT_TOKEN is unset' };
    }
    return { channel: 'discord', available: true, detail: 'discord.js present + bot token set (Gateway)' };
  },
  async deliver(msg: OutboundMessage): Promise<DeliverResult> {
    const { client, djs } = await getDiscordClient(process.env);
    const channel = await client.channels.fetch(msg.conversationId);
    if (!channel || typeof channel.send !== 'function') throw new DeliveryError(`Discord channel ${msg.conversationId} is not sendable`, true);
    if (msg.reactions && msg.reactions.length && msg.replyToMessageId) {
      const target = await channel.messages.fetch(msg.replyToMessageId).catch(() => null);
      if (target) for (const e of msg.reactions) await target.react(e);
      if (!msg.text && !(msg.media && msg.media.length) && !(msg.components && msg.components.length)) return {};
    }
    const payload: Record<string, unknown> = {};
    if (msg.text) payload.content = msg.text;
    if (msg.media && msg.media.length) payload.files = msg.media.map((a) => a.url);
    if (msg.components && msg.components.length) payload.components = buildDiscordComponents(djs, msg.components);
    if (msg.replyToMessageId) payload.reply = { messageReference: msg.replyToMessageId };
    const sent = await channel.send(payload);
    return { platformMessageIds: sent?.id ? [String(sent.id)] : [] };
  },
  async setTyping(conversationId: string, on: boolean) {
    if (!on) return; // Discord typing expires by itself (~10 s); there is no "stop".
    const { client } = await getDiscordClient(process.env);
    const channel = await client.channels.fetch(conversationId);
    await channel?.sendTyping?.();
  },
  async startReceive(onInbound, opts = {}) {
    const { client, botId } = await getDiscordClient(opts.env ?? process.env);
    const onMessage = async (m: any) => {
      opts.onActivity?.();
      if (m?.author?.id === botId) return; // skip our own sends
      const msg = parseDiscordMessage(m);
      if (msg) await onInbound(msg);
    };
    // Button clicks arrive as interactions → forward as an inbound command.
    const onInteraction = async (i: any) => {
      if (typeof i?.isButton === 'function' && i.isButton()) {
        await onInbound({
          platformMessageId: String(i.id),
          conversationId: String(i.channelId),
          peerId: String(i.user?.id ?? ''),
          ...(i.user?.username ? { peerDisplay: i.user.username } : {}),
          text: String(i.customId ?? ''),
          timestamp: new Date().toISOString(),
          kind: 'command',
          command: { name: String(i.customId ?? '') },
        });
        try { await i.deferUpdate?.(); } catch { /* ignore */ }
      }
    };
    client.on('messageCreate', onMessage);
    client.on('interactionCreate', onInteraction);
    return () => {
      try { client.off('messageCreate', onMessage); client.off('interactionCreate', onInteraction); } catch { /* ignore */ }
      try { client.destroy?.(); } catch { /* ignore */ }
      discordConnP = undefined;
    };
  },
};

const PLUGINS: Record<RelayChannel, ChannelPlugin> = {
  signal: signalPlugin,
  imessage: imessagePlugin,
  whatsapp: whatsappPlugin,
  discord: discordPlugin,
};

export function getChannelPlugin(channel: RelayChannel): ChannelPlugin {
  const p = PLUGINS[channel];
  if (!p) throw new Error(`unknown channel: ${channel}`);
  return p;
}

export type { ChannelPlugin, InboundMessage, OutboundMessage, ChannelAvailability, RelayChannel };

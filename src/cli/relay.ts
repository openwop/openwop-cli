import type { Ctx } from '../context.js';
/**
 * `openwop relay ...` — the local device relay: setup (with the risk notice and
 * consent), the bridge loop, token rotation, and the user service.
 *
 * Host contract: openwop-app ADR 1043 D1, host-extension routes under
 * /v1/host/openwop-app/messaging (non-normative; no OpenWOP wire change).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, HttpError, errText, errorEnvelope } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { processAlive, openLogStream } from '../daemon.js';
import { getChannelPlugin } from '../channels/registry.js';
import { normalizeAccountId } from '../channels/normalize.js';
import type { ChannelPlugin, InboundMessage, RelayChannel } from '../channels/types.js';
import { openwopHomeDir } from '../config.js';
import { promptText } from '../prompt.js';
import {
  MESSAGING_BASE, DEVICE_TOKEN_HEADER, RELAY_CHANNELS,
  loadRelayConfig, saveRelayConfig, assertRelayChannel,
  relayPidPath, relayLogPath, readRelayRecord, makeChannelDeliver,
} from './relayShared.js';
import { RelayBridge, classifyRelayError, RelayAuthError, RELAY_FAILING_REASONS, type RelayCreds } from './relayBridge.js';
import {
  assertRelayServerUrl, buildRelayServicePlan, isPersonalChannel, riskNotice, RISK_NOTICE_VERSION,
} from './relayService.js';

export const RELAY_HELP = `Usage:
  openwop relay setup --channel <signal|whatsapp|imessage|discord> [--account <id>] [--name n] [--accept-risk]
  openwop relay register --channel <ch> [--account <id>] [--name n] [--accept-risk]
  openwop relay activate --relay-id <id> --code <activationCode> [--account <id>]
  openwop relay status
  openwop relay devices
  openwop relay send --conversation <id> --text <msg> [--relay-id <id>]
  openwop relay start [--daemon] [--once] [--no-receive] [--debounce-ms <ms>]
  openwop relay stop
  openwop relay logs [-f]
  openwop relay rotate
  openwop relay revoke [--relay-id <id>]
  openwop relay service <install|uninstall|status> [--dry-run]

The relay links YOUR OWN messaging account on THIS machine (signal-cli /
WhatsApp Web / Messages) to the OpenWOP server, through the server's
host-extension routes under /v1/host/openwop-app/messaging.

  setup    Shows the risk of linking a personal account and asks you to type
           "yes" (or pass --accept-risk when there is no terminal), then
           registers + activates this device. --account is the device's own
           account (WhatsApp number, Signal number, iMessage handle): only
           messages you write to yourself in that chat run as you, with full
           tools. The device token is stored in ~/.openwop/relay-credentials.json
           (0600), never in config.json. The server address is the one you pass
           with --base-url (or your config); it is never taken from a link, and
           \`relay start\` only ever talks to the address the relay was set up with.
  start    Runs the bridge: heartbeat, token rotation, outbound delivery with
           retries and failure reports, inbound forwarding with burst batching
           and typing indicators, backoff with jitter on errors, and a 30-minute
           watchdog that restarts receiving. Stops (exit 0) if the server refuses
           the token. --daemon backgrounds it (pid + logs under ~/.openwop/);
           \`relay service install\` runs it as a launchd/systemd user service.
  rotate   Rotates the device token now (start does this automatically).
  devices  Lists this workspace's relay devices: online or offline, who owns
           each, and which you may revoke (your own, or any as a workspace
           admin).
  status   Probes the server with a heartbeat to confirm the token is live.
  send     Operator-side: queue an outbound message for the relay to deliver.

Exit codes: 0 ok · 1 failed / offline · 2 usage.

Examples:
  openwop --base-url https://app.openwop.dev/api relay setup --channel signal --account +15551234567
  openwop relay service install
  openwop relay devices --json
`;

export async function runRelay(ctx: Ctx, argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, RELAY_HELP);
    return sub ? 0 : 2;
  }
  const args = argv.slice(1);
  switch (sub) {
    case 'register': return await runRelayRegister(ctx, args);
    case 'activate': return await runRelayActivate(ctx, args);
    case 'setup': return await runRelaySetup(ctx, args);
    case 'revoke': return await runRelayRevoke(ctx, args);
    case 'send': return await runRelaySend(ctx, args);
    case 'status': return await runRelayStatus(ctx, args);
    case 'devices': return await runRelayDevices(ctx, args);
    case 'start': return await runRelayStart(ctx, args);
    case 'stop': return await runRelayStop(ctx, args);
    case 'logs': return await runRelayLogs(ctx, args);
    case 'rotate': return await runRelayRotate(ctx, args);
    case 'service': return await runRelayService(ctx, args);
    default:
      throw new CliError(`Unknown relay command: ${sub}\nRun \`openwop relay --help\` for usage.`);
  }
}

const isInteractive = (ctx: Ctx): boolean => ctx.relaySeams?.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
const ask = (ctx: Ctx, q: string): Promise<string> => (ctx.relaySeams?.prompt ? ctx.relaySeams.prompt(q) : promptText(ctx, q, ''));

/**
 * ADR 1041 D2 / ADR 1043 D6 — show the risk and take explicit consent before a
 * personal account is linked. Returns the consent record, or throws.
 */
async function requireConsent(ctx: Ctx, channel: string, acceptRisk: boolean): Promise<{ riskAcceptedAt?: string; riskNoticeVersion?: number }> {
  if (!isPersonalChannel(channel)) return {};
  writeLine(ctx.io.stderr, riskNotice(channel));
  if (acceptRisk) {
    writeLine(ctx.io.stderr, 'Risk accepted with --accept-risk.');
  } else {
    if (!isInteractive(ctx)) {
      throw new CliError('Linking a personal account needs your consent. Re-run in a terminal, or pass --accept-risk after reading the notice above.', 2);
    }
    const answer = (await ask(ctx, 'Type "yes" to link your own account on this machine: ')).trim().toLowerCase();
    if (answer !== 'yes') throw new CliError('Setup cancelled; nothing was registered.', 1);
  }
  return { riskAcceptedAt: new Date().toISOString(), riskNoticeVersion: RISK_NOTICE_VERSION };
}

/** The device's own account id, normalized for the channel (or a usage error). */
async function resolveAccountId(ctx: Ctx, channel: string, raw: unknown, allowPrompt: boolean): Promise<string | undefined> {
  let value = typeof raw === 'string' ? raw : undefined;
  if (value === undefined && allowPrompt && isPersonalChannel(channel) && isInteractive(ctx)) {
    value = (await ask(ctx, `Your own ${channel} account (for note-to-self commands; Enter to skip): `)).trim() || undefined;
  }
  if (value === undefined) return undefined;
  const id = normalizeAccountId(channel, value);
  if (!id) throw new CliError(`--account is not a valid ${channel} account id: ${value}`, 2);
  return id;
}

function pinnedServer(ctx: Ctx): string {
  return assertRelayServerUrl(ctx.baseUrl);
}

async function register(ctx: Ctx, server: string, channel: string, name: unknown, accountId: string | undefined) {
  return requestJson({ ...ctx, baseUrl: server }, `${MESSAGING_BASE}/relay/register`, {
    method: 'POST',
    body: { channel, ...(typeof name === 'string' && name ? { deviceName: name } : {}), ...(accountId ? { accountId } : {}) },
  });
}

async function activate(ctx: Ctx, server: string, relayId: string, activationCode: string, accountId: string | undefined) {
  try {
    return await requestJson({ ...ctx, baseUrl: server }, `${MESSAGING_BASE}/relay/activate`, {
      method: 'POST',
      body: { relayId, activationCode, ...(accountId ? { accountId } : {}) },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      const env = errorEnvelope(err.body);
      if (env.details?.reason === 'activation_locked') throw new CliError('Activation is locked after too many wrong codes. Run `openwop relay setup` to register again.', 1);
      if (env.details?.reason === 'activation_user_mismatch') throw new CliError('Only the person who registered this relay can activate it. Sign in as them, or register again.', 1);
      if (typeof env.details?.attemptsLeft === 'number') throw new CliError(`Wrong or expired activation code (${env.details.attemptsLeft} attempt(s) left).`, 1);
    }
    throw err;
  }
}

function credsFrom(act: any, server: string, extra: Partial<RelayCreds>): RelayCreds {
  return {
    relayId: act.relayId,
    channel: act.channel,
    deviceToken: act.deviceToken,
    ...(act.tokenExpiresAt ? { tokenExpiresAt: act.tokenExpiresAt } : {}),
    ...(act.rotateAfter ? { rotateAfter: act.rotateAfter } : {}),
    baseUrl: server,
    ...extra,
  };
}

async function runRelayRegister(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--channel', '--name', '--account'], bool: ['--accept-risk'] });
  if (!options.channel) throw new CliError('--channel is required (one of: ' + RELAY_CHANNELS.join(', ') + ').');
  assertRelayChannel(options.channel);
  const server = pinnedServer(ctx);
  const accountId = await resolveAccountId(ctx, options.channel, options.account, false);
  await requireConsent(ctx, options.channel, options.acceptRisk === true);
  const res = await register(ctx, server, options.channel, options.name, accountId);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `✓ Registered relay ${res.body.relayId} (${res.body.channel})`);
  writeLine(ctx.io.stdout, `  Activate with: openwop relay activate --relay-id ${res.body.relayId} --code ${res.body.activationCode}`);
  return 0;
}

async function runRelayActivate(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--relay-id', '--code', '--account'] });
  if (!options.relayId || !options.code) throw new CliError('--relay-id and --code are required.');
  const server = pinnedServer(ctx);
  const res = await activate(ctx, server, options.relayId, options.code, undefined);
  const accountId = typeof options.account === 'string' ? normalizeAccountId(res.body.channel, options.account) : undefined;
  saveRelayConfig(ctx, credsFrom(res.body, server, accountId ? { accountId } : {}));
  if (ctx.json) { writeJson(ctx.io.stdout, redactToken(res.body)); return 0; }
  writeLine(ctx.io.stdout, `✓ Activated relay ${res.body.relayId} — device token stored in ${join(openwopHomeDir(ctx.env), 'relay-credentials.json')}.`);
  return 0;
}

async function runRelaySetup(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--channel', '--name', '--account'], bool: ['--accept-risk'] });
  if (!options.channel) throw new CliError('--channel is required (one of: ' + RELAY_CHANNELS.join(', ') + ').');
  assertRelayChannel(options.channel);
  const server = pinnedServer(ctx);
  const consent = await requireConsent(ctx, options.channel, options.acceptRisk === true);
  const accountId = await resolveAccountId(ctx, options.channel, options.account, true);
  const reg = await register(ctx, server, options.channel, options.name, accountId);
  const act = await activate(ctx, server, reg.body.relayId, reg.body.activationCode, accountId);
  saveRelayConfig(ctx, credsFrom(act.body, server, { ...(accountId ? { accountId } : {}), ...consent }));
  if (ctx.json) { writeJson(ctx.io.stdout, { ...redactToken(act.body), ...(accountId ? { accountId } : {}) }); return 0; }
  writeLine(ctx.io.stdout, `✓ Relay ${act.body.relayId} (${act.body.channel}) registered + activated against ${server}.`);
  if (act.body.ownerBound === false) writeLine(ctx.io.stdout, '  Note: no signed-in person activated it, so it has no owner: messages can start workflows but never chat turns.');
  writeLine(ctx.io.stdout, '  Start the bridge with: openwop relay start   (or keep it running: openwop relay service install)');
  return 0;
}

/** Never echo the device token to stdout (a bearer-equivalent credential). */
function redactToken(body: any) {
  if (!body || typeof body !== 'object') return body;
  const { deviceToken: _t, ...rest } = body;
  return { ...rest, deviceToken: '[stored]' };
}

async function runRelayRevoke(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--relay-id'] });
  const relayId = options.relayId ?? loadRelayConfig(ctx).relayId;
  if (!relayId) throw new CliError('No relay to revoke. Pass --relay-id or run `openwop relay setup` first.');
  const res = await requestJson(ctx, `${MESSAGING_BASE}/relay/revoke`, { method: 'POST', body: { relayId } });
  if (!options.relayId) saveRelayConfig(ctx, {});
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `✓ Revoked relay ${relayId}`);
  return 0;
}

async function runRelaySend(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { value: ['--relay-id', '--conversation', '--text', '--reply-to'] });
  const relayId = options.relayId ?? loadRelayConfig(ctx).relayId;
  if (!relayId) throw new CliError('No relay configured. Pass --relay-id or run `openwop relay setup` first.');
  if (!options.conversation || !options.text) throw new CliError('--conversation and --text are required.');
  const body = {
    relayId,
    conversationId: options.conversation,
    text: options.text,
    ...(options.replyTo ? { replyToMessageId: options.replyTo } : {}),
  };
  const res = await requestJson(ctx, `${MESSAGING_BASE}/relay/enqueue`, { method: 'POST', body });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `✓ Queued egress ${res.body.egressId} → conversation ${res.body.conversationId}`);
  return 0;
}

async function runRelayDevices(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, RELAY_HELP); return 0; }
  const res = await requestJson(ctx, `${MESSAGING_BASE}/relay/devices`);
  const devices: any[] = Array.isArray(res.body?.devices) ? res.body.devices : [];
  if (ctx.json) { writeJson(ctx.io.stdout, { devices }); return 0; }
  if (devices.length === 0) { writeLine(ctx.io.stdout, 'No relay devices.'); return 0; }
  for (const d of devices) {
    // `presence` (ADR 1043) when the host sends it, else the CHAN-P0-8 `online` flag.
    const state = typeof d.presence === 'string' ? d.presence : d.online === true ? 'online' : d.online === false ? 'offline' : 'unknown';
    const owner = d.owner === null ? '  no owner' : d.owner?.ownedByCaller ? '  yours' : d.owner ? '  another member\'s' : '';
    const revoke = d.canRevoke === true ? '  (you can revoke)' : '';
    writeLine(ctx.io.stdout, `${d.relayId}  ${d.channel}  ${d.status}  ${state}${owner}${d.lastHeartbeatAt ? `  last seen ${d.lastHeartbeatAt}` : ''}${d.deviceName ? `  (${d.deviceName})` : ''}${revoke}`);
  }
  return 0;
}

/** The relay's own context: the PINNED server, never a different explicit one (ADR 1043 D7). */
function relayCtx(ctx: Ctx, relay: RelayCreds): Ctx {
  const pinned = assertRelayServerUrl(relay.baseUrl ?? ctx.baseUrl);
  if (ctx.explicitBaseUrl) {
    const asked = assertRelayServerUrl(ctx.explicitBaseUrl);
    if (asked !== pinned) {
      throw new CliError(`This relay was set up against ${pinned}; refusing to send its token to ${asked}. Run \`openwop relay setup\` against the new server instead.`, 2);
    }
  }
  return { ...ctx, baseUrl: pinned };
}

function requireRelay(ctx: Ctx): RelayCreds {
  const relay = loadRelayConfig(ctx);
  if (!relay.relayId || !relay.deviceToken) {
    throw new CliError('No relay configured. Run `openwop relay setup --channel <signal|whatsapp|imessage|discord>` first.');
  }
  return relay as RelayCreds;
}

async function runRelayStatus(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, RELAY_HELP); return 0; }
  const relay = loadRelayConfig(ctx);
  if (!relay.relayId) {
    writeLine(ctx.io.stdout, 'No relay configured. Run `openwop relay setup --channel <signal|whatsapp|imessage|discord>`.');
    return ctx.json ? (writeJson(ctx.io.stdout, { configured: false }), 0) : 1;
  }
  const rctx = relayCtx(ctx, relay);
  // A heartbeat doubles as a liveness probe against the host.
  let online = false;
  let detail = '';
  try {
    const res = await requestJson(rctx, `${MESSAGING_BASE}/device/heartbeat`, {
      method: 'POST',
      auth: false,
      headers: { [DEVICE_TOKEN_HEADER]: relay.deviceToken },
      body: { status: 'status-probe' },
    });
    online = res.body?.ok === true;
  } catch (err) {
    const c = classifyRelayError(err);
    detail = c instanceof RelayAuthError ? c.message : err instanceof HttpError ? `HTTP ${err.status}` : errText(err);
  }
  if (ctx.json) {
    writeJson(ctx.io.stdout, { configured: true, relayId: relay.relayId, channel: relay.channel, online, ...(relay.tokenExpiresAt ? { tokenExpiresAt: relay.tokenExpiresAt } : {}), ...(detail ? { detail } : {}) });
    return online ? 0 : 1;
  }
  writeLine(ctx.io.stdout, `relayId:  ${relay.relayId}`);
  writeLine(ctx.io.stdout, `channel:  ${relay.channel}`);
  writeLine(ctx.io.stdout, `host:     ${rctx.baseUrl}`);
  if (relay.accountId) writeLine(ctx.io.stdout, `account:  ${relay.accountId}`);
  if (relay.tokenExpiresAt) writeLine(ctx.io.stdout, `token:    valid until ${relay.tokenExpiresAt} (rotates automatically while running)`);
  writeLine(ctx.io.stdout, `status:   ${online ? 'online (host reachable, token valid)' : `offline${detail ? ` — ${detail}` : ''}`}`);
  return online ? 0 : 1;
}

async function runRelayRotate(ctx: Ctx, argv: string[]) {
  parseOptions(argv, {});
  const relay = requireRelay(ctx);
  const bridge = new RelayBridge({ ctx: relayCtx(ctx, relay), creds: relay, saveCreds: (c) => saveRelayConfig(ctx, c), deliver: async () => undefined });
  try { await bridge.rotate(); }
  catch (err) { if (err instanceof RelayAuthError) throw new CliError(err.message, 1); throw err; }
  if (ctx.json) writeJson(ctx.io.stdout, { relayId: relay.relayId, tokenExpiresAt: bridge.creds.tokenExpiresAt, rotateAfter: bridge.creds.rotateAfter });
  return 0;
}

/**
 * Start the plugin's receive side feeding the bridge. Kept as an export: it is
 * the B4 seam the channel tests drive with a fake plugin.
 */
export async function startInboundReceive(
  ctx: any,
  relay: { channel: RelayChannel; deviceToken: string; accountId?: string },
  deviceHeaders: Record<string, string>,
  hooks: { onInbound?: (msg: InboundMessage) => Promise<void>; onActivity?: () => void; onFatal?: (err: Error) => void } = {},
): Promise<(() => void) | undefined> {
  const plugin: ChannelPlugin = ctx.relayPlugin ?? getChannelPlugin(relay.channel);
  const avail = plugin.isAvailable(ctx.env);
  if (!avail.available) {
    writeLine(ctx.io.stderr, `inbound receive skipped: ${avail.detail}`);
    return undefined;
  }
  const forward = hooks.onInbound ?? (async (msg: InboundMessage) => {
    try {
      await requestJson(ctx, `${MESSAGING_BASE}/device/inbound`, { method: 'POST', auth: false, headers: deviceHeaders, body: msg });
      writeLine(ctx.io.stdout, `← [${relay.channel}] ${msg.conversationId}: ${msg.text}`);
    } catch (err) {
      writeLine(ctx.io.stderr, `inbound forward failed: ${errText(err)}`);
    }
  });
  try {
    const stop = await plugin.startReceive(forward, {
      env: ctx.env,
      ...(relay.accountId ? { accountId: relay.accountId } : {}),
      ...(hooks.onActivity ? { onActivity: hooks.onActivity } : {}),
      ...(hooks.onFatal ? { onFatal: hooks.onFatal } : {}),
    });
    writeLine(ctx.io.stdout, `Inbound receive active for ${relay.channel}.`);
    return stop;
  } catch (err) {
    writeLine(ctx.io.stderr, `inbound receive unavailable: ${errText(err)}`);
    return undefined;
  }
}

/** The CLI's own entry file (the bundle runs from dist/; `openwop.js` sits beside it). */
function cliEntry(): string {
  return fileURLToPath(new URL('./openwop.js', import.meta.url));
}

async function runRelayStart(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help', '--once', '--daemon', '--no-receive'], value: ['--interval', '--debounce-ms'] });
  if (options.help) { write(ctx.io.stdout, RELAY_HELP); return 0; }
  const relay = requireRelay(ctx);
  const rctx = relayCtx(ctx, relay);

  // Daemonize: re-spawn `relay start` (foreground) detached, log to a file,
  // and record the pid. Mirrors `demo start --detach`.
  if (options.daemon) {
    const existing = readRelayRecord(ctx.env);
    if (existing && processAlive(existing.pid)) {
      throw new CliError(`Relay already running (pid ${existing.pid}). Stop it with \`openwop relay stop\`.`);
    }
    const logPath = relayLogPath(ctx.env);
    const fd = openLogStream(logPath);
    const childArgs = [cliEntry(), '--base-url', rctx.baseUrl, 'relay', 'start'];
    if (options.debounceMs) childArgs.push('--debounce-ms', String(options.debounceMs));
    const child = spawn(process.execPath, childArgs, {
      cwd: ctx.cwd ?? process.cwd(),
      env: ctx.env,
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      detached: true,
    });
    child.unref();
    const record = { pid: child.pid, relayId: relay.relayId, channel: relay.channel, baseUrl: rctx.baseUrl, logPath, startedAt: new Date().toISOString() };
    mkdirSync(dirname(relayPidPath(ctx.env)), { recursive: true });
    writeFileSync(relayPidPath(ctx.env), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    if (ctx.json) writeJson(ctx.io.stdout, record);
    else {
      writeLine(ctx.io.stdout, `✓ Relay bridge started in background (pid ${child.pid}, ${relay.channel} ${relay.relayId}).`);
      writeLine(ctx.io.stdout, `  Logs: ${logPath} — follow with \`openwop relay logs -f\`, stop with \`openwop relay stop\`.`);
    }
    return 0;
  }

  let plugin: ChannelPlugin | undefined = ctx.relayPlugin;
  if (!plugin) { try { plugin = getChannelPlugin(relay.channel as RelayChannel); } catch { plugin = undefined; } }
  const deliver = ctx.relayDeliver ?? makeChannelDeliver(relay.channel, ctx);
  const debounce = options.debounceMs !== undefined ? Number(options.debounceMs) : 1500;
  const bridge = new RelayBridge({
    ctx: rctx,
    creds: relay,
    saveCreds: (c) => saveRelayConfig(ctx, c),
    deliver: async (e) => (await deliver(e)) ?? undefined,
    plugin: plugin && plugin.isAvailable(ctx.env).available ? plugin : undefined,
    deliveredPath: join(openwopHomeDir(ctx.env), 'relay-delivered.json'),
    debounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 1500,
    ...(ctx.relaySeams?.sleep ? { sleepFn: ctx.relaySeams.sleep } : {}),
  });

  if (options.once) {
    let n: { delivered: number; failed: number };
    try { n = await bridge.cycle(); }
    catch (err) { if (err instanceof RelayAuthError) { writeLine(ctx.io.stderr, err.message); return RELAY_FAILING_REASONS.has(err.reason) ? 1 : 0; } throw err; }
    if (ctx.json) writeJson(ctx.io.stdout, n);
    else writeLine(ctx.io.stdout, `Bridge cycle complete — delivered ${n.delivered} message(s)${n.failed ? `, ${n.failed} failed` : ''}.`);
    return 0;
  }

  // Inbound: platform messages → echo guard → batcher → POST /device/inbound.
  const headers = { [DEVICE_TOKEN_HEADER]: relay.deviceToken };
  const hooks = {
    onInbound: (m: InboundMessage) => bridge.onInbound(m),
    onActivity: () => bridge.watchdog.touch(),
    onFatal: (err: Error) => bridge.fail('platform', 'platform_session_ended', err.message),
  };
  let stopReceive = options.noReceive ? undefined : await startInboundReceive(rctx, relay as RelayCreds & { channel: RelayChannel }, headers, hooks);
  const restartReceive = options.noReceive ? undefined : async () => {
    try { stopReceive?.(); } catch { /* ignore */ }
    stopReceive = await startInboundReceive(rctx, relay as RelayCreds & { channel: RelayChannel }, headers, hooks);
  };

  const ctrl = new AbortController();
  const onSignal = () => ctrl.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  writeLine(ctx.io.stdout, `Relay bridge running for ${relay.relayId} (${relay.channel}) against ${rctx.baseUrl}. Ctrl+C to stop.`);
  const signal = ctx.relaySeams?.signal ? AbortSignal.any([ctx.relaySeams.signal, ctrl.signal]) : ctrl.signal;
  const result = await bridge.run({ signal, ...(restartReceive ? { restartReceive } : {}) });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  try { stopReceive?.(); } catch { /* ignore */ }
  if (ctx.json) writeJson(ctx.io.stdout, result);
  // A refused token or an ended platform session exits 0: a service manager
  // (KeepAlive SuccessfulExit=false / Restart=on-failure) must not restart into it.
  // A SUPERSEDED token (a lost rotation answer) exits 1 instead, so the failure is
  // visible as a failed service, with the message telling the user to run setup.
  return result.stopped === 'auth' && result.reason && RELAY_FAILING_REASONS.has(result.reason) ? 1 : 0;
}

async function runRelayStop(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, RELAY_HELP); return 0; }
  const record = readRelayRecord(ctx.env);
  if (!record || !record.pid) {
    writeLine(ctx.io.stdout, 'No relay daemon recorded.');
    return ctx.json ? (writeJson(ctx.io.stdout, { stopped: false }), 0) : 0;
  }
  let stopped = false;
  if (processAlive(record.pid)) {
    try { process.kill(record.pid); stopped = true; } catch { /* already gone */ }
  }
  try { if (existsSync(relayPidPath(ctx.env))) rmSync(relayPidPath(ctx.env)); } catch { /* best-effort */ }
  if (ctx.json) writeJson(ctx.io.stdout, { stopped, pid: record.pid });
  else writeLine(ctx.io.stdout, stopped ? `✓ Stopped relay daemon (pid ${record.pid}).` : `Cleared stale relay record (pid ${record.pid} was not running).`);
  return 0;
}

async function runRelayLogs(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help', '--follow', '-f'] });
  if (options.help) { write(ctx.io.stdout, RELAY_HELP); return 0; }
  const logPath = readRelayRecord(ctx.env)?.logPath ?? relayLogPath(ctx.env);
  if (!existsSync(logPath)) {
    writeLine(ctx.io.stdout, `No relay logs at ${logPath}. Start the daemon with \`openwop relay start --daemon\`.`);
    return 0;
  }
  if (options.follow || options.f) {
    // Defer to `tail -f` for follow mode (best-effort; falls back to a dump).
    const r = spawnSync('tail', ['-f', logPath], { stdio: 'inherit' });
    if (r.status === 0 || r.signal) return 0;
  }
  write(ctx.io.stdout, readFileSync(logPath, 'utf8'));
  return 0;
}

/**
 * `relay service install|uninstall|status` — a launchd LaunchAgent (macOS) or a
 * systemd user unit (Linux) that keeps `relay start` running (ADR 1043 D6).
 */
async function runRelayService(ctx: Ctx, argv: string[]) {
  const action = argv[0];
  const { options } = parseOptions(argv.slice(1), { bool: ['--dry-run', '--help'] });
  if (!action || options.help || !['install', 'uninstall', 'status'].includes(action)) {
    write(ctx.io.stdout, RELAY_HELP);
    return action ? 2 : 0;
  }
  const platform = ctx.relaySeams?.platform ?? process.platform;
  const run = ctx.relaySeams?.runCommand ?? ((a: string[]) => spawnSync(a[0], a.slice(1), { encoding: 'utf8' }));
  const relay = action === 'install' ? requireRelay(ctx) : (loadRelayConfig(ctx) as Partial<RelayCreds>);
  const baseUrl = relay.baseUrl ? assertRelayServerUrl(relay.baseUrl) : pinnedServer(ctx);
  const plan = buildRelayServicePlan({
    platform,
    ...(ctx.relaySeams?.home ? { home: ctx.relaySeams.home } : ctx.env.HOME ? { home: ctx.env.HOME } : {}),
    nodeBin: process.execPath,
    entry: cliEntry(),
    baseUrl,
    logPath: relayLogPath(ctx.env),
    ...(ctx.env.OPENWOP_CONFIG_HOME ? { configHome: ctx.env.OPENWOP_CONFIG_HOME } : {}),
  });
  if (!plan) {
    writeLine(ctx.io.stdout, `Automatic service install is not supported on ${platform}. Run \`openwop relay start\` under your platform's process manager (Windows: a Scheduled Task at logon).`);
    return action === 'status' ? 1 : 2;
  }
  if (action === 'status') {
    const installed = existsSync(plan.path);
    const r = installed ? run(plan.status) : { status: 1 };
    const active = installed && r.status === 0;
    if (ctx.json) writeJson(ctx.io.stdout, { manager: plan.manager, path: plan.path, installed, active });
    else writeLine(ctx.io.stdout, `${plan.manager}: ${installed ? (active ? 'installed and running' : 'installed, not running') : 'not installed'} (${plan.path})`);
    return active ? 0 : 1;
  }
  if (options.dryRun) {
    const steps = action === 'install' ? plan.install : plan.uninstall;
    if (ctx.json) { writeJson(ctx.io.stdout, { manager: plan.manager, path: plan.path, ...(action === 'install' ? { contents: plan.contents } : {}), commands: steps }); return 0; }
    writeLine(ctx.io.stdout, `# ${plan.manager} — ${action} (dry run)`);
    if (action === 'install') { writeLine(ctx.io.stdout, `# write ${plan.path}`); write(ctx.io.stdout, plan.contents); }
    else writeLine(ctx.io.stdout, `# remove ${plan.path}`);
    for (const c of steps) writeLine(ctx.io.stdout, c.join(' '));
    return 0;
  }
  if (action === 'install') {
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.contents, { encoding: 'utf8', mode: 0o644 });
    for (const [i, c] of plan.install.entries()) {
      const r = run(c);
      // launchd's first step unloads an older copy and fails when there is none: fine.
      if (r.status !== 0 && !(plan.manager === 'launchd' && i === 0)) {
        throw new CliError(`${c.join(' ')} failed: ${(r.stderr ?? '').trim() || r.status}`);
      }
    }
    if (ctx.json) writeJson(ctx.io.stdout, { installed: true, manager: plan.manager, path: plan.path });
    else writeLine(ctx.io.stdout, `✓ Relay installed as a ${plan.manager} user service (${plan.path}). Logs: ${relayLogPath(ctx.env)}`);
    return 0;
  }
  for (const c of plan.uninstall) run(c);
  try { if (existsSync(plan.path)) rmSync(plan.path); } catch { /* best-effort */ }
  if (ctx.json) writeJson(ctx.io.stdout, { uninstalled: true, manager: plan.manager, path: plan.path });
  else writeLine(ctx.io.stdout, `✓ Relay ${plan.manager} user service removed.`);
  return 0;
}

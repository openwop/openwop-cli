/**
 * Relay setup consent and the user-service installer (openwop-app ADR 1043 D6/D7).
 *
 *  - The per-channel risk notice ADR 1041 D2 requires before a personal account
 *    is linked, and the explicit consent that must follow it.
 *  - The pinned server address: the relay sends its token only to the server it
 *    was activated against, which never comes from a link or a query string.
 *  - The launchd (macOS) and systemd (Linux) user-service plans. Pure: they are
 *    built here and written by `openwop relay service install`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../errors.js';

/** Bump when the notice text changes materially; stored with the consent. */
export const RISK_NOTICE_VERSION = 1;

/** Channels that link a PERSONAL account (Discord uses a bot token). */
export const PERSONAL_CHANNELS = ['whatsapp', 'signal', 'imessage'] as const;
export const isPersonalChannel = (c: string): boolean => (PERSONAL_CHANNELS as readonly string[]).includes(c);

export function riskNotice(channel: string): string {
  const common = [
    'Before you link this account, read this:',
    '',
    '  • This links YOUR OWN account on THIS machine. Never link a number or account',
    '    that your employer, a client or the server operator owns.',
    '  • Messages from people you approve become conversations in your main chat, and',
    '    the agent answers them in your name, with your access.',
    '  • You can stop it at any time: `openwop relay stop`, then `openwop relay revoke`.',
  ];
  const specific: Record<string, string[]> = {
    whatsapp: [
      '  • WhatsApp: the relay links through WhatsApp Web (Baileys), which WhatsApp does',
      '    not support. WhatsApp can BAN the number. A business number belongs on the',
      '    WhatsApp Business connection, never here.',
    ],
    imessage: [
      '  • iMessage: the relay reads Messages\' chat.db (needs Full Disk Access) and sends',
      '    through Messages. Apple has broken unofficial iMessage clients before and may',
      '    do so again; the relay can stop working without notice.',
    ],
    signal: [
      '  • Signal: signal-cli becomes a linked device with full access to the account,',
      '    and Signal does not support third-party clients.',
    ],
  };
  return [...common, ...(specific[channel] ?? []), ''].join('\n');
}

/**
 * ADR 1043 D7 — a relay server address the relay may send its token to: http(s),
 * no query string, fragment or user info, and plain http only to loopback.
 * Returns the normalized origin + path (no trailing slash).
 */
export function assertRelayServerUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new CliError(`The server address is not a valid URL: ${raw}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CliError(`The server address must be http(s), got ${u.protocol}`);
  if (u.search || u.hash) throw new CliError('The server address must not carry a query string or a fragment. Pass it with --base-url only.');
  if (u.username || u.password) throw new CliError('The server address must not carry a user name or password.');
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol === 'http:' && !loopback) throw new CliError('A relay sends its device token only over https (plain http is allowed for localhost).');
  const s = u.toString();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ── user service (launchd / systemd) ─────────────────────────────────────────

export const RELAY_SERVICE_LABEL = 'dev.openwop.relay';
export const RELAY_SYSTEMD_UNIT = 'openwop-relay.service';

export interface RelayServicePlan {
  manager: 'launchd' | 'systemd';
  path: string;
  contents: string;
  install: string[][];
  uninstall: string[][];
  status: string[];
}

const xml = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** systemd ExecStart quoting: wrap in double quotes, escape `"`, `\` and `%`. */
const sd = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

/**
 * Build the user-service plan. No secret is written into either file: the
 * device token stays in the 0600 credentials file the relay reads at start.
 * Returns null on a platform with no supported service manager.
 */
export function buildRelayServicePlan(input: {
  platform: string; home?: string; nodeBin: string; entry: string; baseUrl: string; logPath: string; uid?: number; configHome?: string;
}): RelayServicePlan | null {
  const home = input.home ?? homedir();
  const args = [input.nodeBin, input.entry, '--base-url', input.baseUrl, 'relay', 'start'];
  if (input.platform === 'darwin') {
    const path = join(home, 'Library/LaunchAgents', `${RELAY_SERVICE_LABEL}.plist`);
    const env = input.configHome ? ['  <key>EnvironmentVariables</key>', '  <dict>', '    <key>OPENWOP_CONFIG_HOME</key>', `    <string>${xml(input.configHome)}</string>`, '  </dict>'] : [];
    const contents = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${RELAY_SERVICE_LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...args.map((a) => `    <string>${xml(a)}</string>`),
      '  </array>',
      ...env,
      '  <key>RunAtLoad</key>',
      '  <true/>',
      // Restart only on a non-zero exit: a token refusal exits 0 and stays down.
      '  <key>KeepAlive</key>',
      '  <dict>',
      '    <key>SuccessfulExit</key>',
      '    <false/>',
      '  </dict>',
      '  <key>ThrottleInterval</key>',
      '  <integer>30</integer>',
      '  <key>StandardOutPath</key>',
      `  <string>${xml(input.logPath)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xml(input.logPath)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    const domain = `gui/${input.uid ?? process.getuid?.() ?? 501}`;
    return {
      manager: 'launchd',
      path,
      contents,
      install: [['launchctl', 'bootout', `${domain}/${RELAY_SERVICE_LABEL}`], ['launchctl', 'bootstrap', domain, path]],
      uninstall: [['launchctl', 'bootout', `${domain}/${RELAY_SERVICE_LABEL}`]],
      status: ['launchctl', 'print', `${domain}/${RELAY_SERVICE_LABEL}`],
    };
  }
  if (input.platform === 'linux') {
    const path = join(home, '.config/systemd/user', RELAY_SYSTEMD_UNIT);
    const contents = [
      '[Unit]',
      'Description=OpenWOP device relay (your own messaging account)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${args.map(sd).join(' ')}`,
      ...(input.configHome ? [`Environment=${sd(`OPENWOP_CONFIG_HOME=${input.configHome}`)}`] : []),
      // Restart only on failure: a token refusal exits 0 and stays down.
      'Restart=on-failure',
      'RestartSec=10',
      `StandardOutput=append:${input.logPath}`,
      `StandardError=append:${input.logPath}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      manager: 'systemd',
      path,
      contents,
      install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', RELAY_SYSTEMD_UNIT]],
      uninstall: [['systemctl', '--user', 'disable', '--now', RELAY_SYSTEMD_UNIT], ['systemctl', '--user', 'daemon-reload']],
      status: ['systemctl', '--user', 'is-active', RELAY_SYSTEMD_UNIT],
    };
  }
  return null;
}

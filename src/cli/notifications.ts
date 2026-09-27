import type { Ctx } from '../context.js';
/** `openwop notifications ...` — notification inbox (sample-extension). */

import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { enc, intFlag, renderFrame, streamHostSse } from './chatShared.js';
import { dispatchRoutes, routesHelp, type RouteCmd } from './routeKit.js';

const PREFS = '/v1/host/openwop-app/notifications/preferences';

/** Your notification preferences (ADR 0010 Phase 2) — per user, cross-device. */
export const NOTIFICATIONS_ROUTES: RouteCmd[] = [
  { words: ['preferences'], method: 'GET', path: PREFS, summary: 'Your preferences (global mute, per-type mute/desktop, quiet hours, muted conversations).' },
  { words: ['preferences', 'set'], method: 'PUT', path: PREFS, rmw: { pick: (b: any) => b?.preferences },
    summary: 'Edit your preferences. Read-modify-write: the host replaces the whole document, so the CLI starts from the current one.',
    body: [
      { flag: '--global-mute', key: 'globalMute', type: 'boolean' },
      { flag: '--quiet-hours', key: 'quietHours.enabled', type: 'boolean' },
      { flag: '--quiet-start', key: 'quietHours.start', help: 'HH:MM' },
      { flag: '--quiet-end', key: 'quietHours.end', help: 'HH:MM' },
      { flag: '--timezone', key: 'quietHours.timezone', help: 'IANA zone; quiet hours are not enforced without one' },
      { flag: '--types', key: 'types', type: 'json', help: '[{"type","muted","desktop"}]' },
      { flag: '--muted-conversations', key: 'mutedConversations', type: 'csv' },
    ] },
];

export const NOTIFICATIONS_HELP = `Usage:
  openwop notifications list [--status <s>] [--archived] [--limit n] [--json]
  openwop notifications read|unread|archive <id> [--json]
  openwop notifications mark-all-read [--json]
  openwop notifications delete <id> [--json]
  openwop notifications stream [--max-events n] [--timeout-ms ms] [--json]
  openwop notifications push config [--json]
  openwop notifications push list [--json]
  openwop notifications push subscribe --endpoint <https-url> --p256dh <key> --auth <secret> [--user-agent ua] [--json]
  openwop notifications push unsubscribe <subscriptionId> [--json]

Operate the demo notification inbox (/v1/host/openwop-app/notifications) — a
sample-extension surface, tenant-scoped, not part of the normative wire.

  stream   GET …/notifications/stream — live new notifications (server-sent events);
           stops after --max-events or --timeout-ms (default 30000 ms).
  push     Web-push delivery: GET …/notifications/push/config (is push enabled +
           the server's public VAPID key), GET …/push/subscriptions, POST
           …/push/subscribe (a browser PushSubscription's endpoint + keys), and
           DELETE …/push/subscriptions/{id}. The subscription's keys are sent once
           and never printed back.

Preferences:
${routesHelp('notifications', NOTIFICATIONS_ROUTES)}
`;

export async function runNotifications(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, NOTIFICATIONS_HELP); return 0; }
  const ext = await dispatchRoutes(ctx, 'notifications', NOTIFICATIONS_ROUTES, argv);
  if (ext !== undefined) return ext;
  const base = '/v1/host/openwop-app/notifications';
  const rest = argv.slice(1);
  switch (sub) {
    case 'list': {
      const { options } = parseOptions(rest, { bool: ['--archived'], value: ['--status', '--limit'] });
      const q = new URLSearchParams();
      if (options.status) q.set('status', options.status);
      if (options.archived) q.set('includeArchived', 'true');
      if (options.limit) q.set('limit', options.limit);
      const res = await requestJson(ctx, `${base}${q.toString() ? `?${q}` : ''}`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.notifications) ? res.body.notifications : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No notifications.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(
        items.map((n: any) => ({ id: n.notificationId, status: n.status, priority: n.priority ?? '', title: n.title ?? '', createdAt: n.createdAt ?? '' })),
        ['id', 'status', 'priority', 'title', 'createdAt'],
      ));
      return 0;
    }
    case 'read': case 'unread': case 'archive': {
      if (rest.length !== 1) { write(ctx.io.stdout, `Usage: openwop notifications ${sub} <id> [--json]\n`); return 2; }
      const res = await requestJson(ctx, `${base}/${encodeURIComponent(rest[0])}/${sub}`, { method: 'POST', body: {} });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `✓ ${rest[0]} → ${res.body.status}`);
      return 0;
    }
    case 'mark-all-read': {
      const res = await requestJson(ctx, `${base}:mark-all-read`, { method: 'POST', body: {} });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `✓ Marked ${res.body.updated} notification(s) read.`);
      return 0;
    }
    case 'delete': case 'rm': {
      if (rest.length !== 1) { write(ctx.io.stdout, 'Usage: openwop notifications delete <id> [--json]\n'); return 2; }
      const res = await requestJson(ctx, `${base}/${encodeURIComponent(rest[0])}`, { method: 'DELETE' });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `✓ Deleted ${rest[0]}`);
      return 0;
    }
    case 'stream': {
      const { options } = parseOptions(rest, { value: ['--max-events', '--timeout-ms'] });
      const timeoutMs = intFlag(options.timeoutMs, '--timeout-ms') ?? 30000;
      const frames = await streamHostSse(ctx, `${base}/stream`, {
        maxFrames: intFlag(options.maxEvents, '--max-events'),
        timeoutMs,
        onFrame: (frame) => {
          if (ctx.json) { writeLine(ctx.io.stdout, JSON.stringify(frame)); return; }
          const n: any = frame.data;
          writeLine(ctx.io.stdout, n && typeof n === 'object' ? `${n.createdAt ?? ''} [${n.priority ?? 'normal'}] ${n.title ?? ''}${n.notificationId ? ` (${n.notificationId})` : ''}` : renderFrame(frame));
        },
      });
      if (!ctx.json && frames === 0) writeLine(ctx.io.stdout, `No new notifications within ${timeoutMs} ms.`);
      return 0;
    }
    case 'push':
      return await runPush(ctx, rest);
    default:
      throw new CliError(`Unknown notifications command: ${sub}\nRun \`openwop notifications --help\` for usage.`);
  }
}

async function runPush(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const base = '/v1/host/openwop-app/notifications/push';
  const { options, positionals } = parseOptions(argv.slice(1), { value: ['--endpoint', '--p256dh', '--auth', '--user-agent'] });
  switch (sub) {
    case 'config': {
      const res = await requestJson(ctx, `${base}/config`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, res.body?.enabled ? `Web push enabled. VAPID public key: ${res.body.vapidPublicKey}` : 'Web push is not configured on this server.');
      return 0;
    }
    case 'list': {
      const res = await requestJson(ctx, `${base}/subscriptions`);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const subs = Array.isArray(res.body?.subscriptions) ? res.body.subscriptions : [];
      if (!subs.length) { writeLine(ctx.io.stdout, 'No push subscriptions.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(subs.map((s: any) => ({ subscriptionId: s.subscriptionId, endpoint: String(s.endpoint ?? '').slice(0, 60), userAgent: s.userAgent ?? '', createdAt: s.createdAt ?? '' })), ['subscriptionId', 'endpoint', 'userAgent', 'createdAt']));
      return 0;
    }
    case 'subscribe': {
      if (!options.endpoint || !options.p256dh || !options.auth) {
        throw new CliError('notifications push subscribe requires --endpoint, --p256dh, and --auth (from a browser PushSubscription).', 2);
      }
      const body: Record<string, any> = { endpoint: options.endpoint, keys: { p256dh: options.p256dh, auth: options.auth } };
      if (options.userAgent) body.userAgent = options.userAgent;
      const res = await requestJson(ctx, `${base}/subscribe`, { method: 'POST', body });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Subscribed: ${res.body?.subscriptionId}`);
      return 0;
    }
    case 'unsubscribe': case 'delete': {
      if (!positionals[0]) throw new CliError('Usage: openwop notifications push unsubscribe <subscriptionId>', 2);
      await requestJson(ctx, `${base}/subscriptions/${enc(positionals[0])}`, { method: 'DELETE' });
      if (ctx.json) { writeJson(ctx.io.stdout, { subscriptionId: positionals[0], deleted: true }); return 0; }
      writeLine(ctx.io.stdout, `Unsubscribed ${positionals[0]}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown notifications push command: ${sub}\nRun \`openwop notifications --help\` for usage.`, 2);
  }
}

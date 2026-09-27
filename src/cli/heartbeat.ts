import type { Ctx } from '../context.js';
/**
 * `openwop heartbeat ...` — the host-wide agent heartbeat switch (ADR 0318,
 * super-admin only): whether scheduled agent heartbeats run at all, their
 * default interval, an hourly run budget, and an optional auto-off time.
 *
 *   GET|PUT /v1/host/openwop-app/heartbeat/settings
 */
import { CliError } from '../errors.js';
import { gateAdvice } from './adminShared.js';
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const PATH = '/v1/host/openwop-app/heartbeat/settings';

export const HEARTBEAT_ROUTES: RouteCmd[] = [
  { words: ['settings'], method: 'GET', path: PATH, summary: 'The saved config and what is in effect now (incl. an elapsed auto-off window).' },
  { words: ['settings', 'set'], method: 'PUT', path: PATH,
    rmw: { pick: (b: any) => { const c = b?.config ?? {}; return { status: c.status, hostDefaultIntervalMs: c.hostDefaultIntervalMs, runBudgetPerHour: c.runBudgetPerHour ?? null, enabledUntil: c.enabledUntil ?? null }; } },
    summary: 'Change the settings. Read-modify-write: the host replaces the whole config, so fields you do not pass keep their current value.',
    body: [
      { flag: '--status', key: 'status', help: 'on | off' },
      { flag: '--host-default-interval-ms', key: 'hostDefaultIntervalMs', type: 'number' },
      { flag: '--run-budget-per-hour', key: 'runBudgetPerHour', type: 'number', help: '0 = unlimited' },
      { flag: '--enabled-until', key: 'enabledUntil', help: 'ISO time in the future; only kept while on' },
    ] },
];

export const HEARTBEAT_HELP = `Usage:
${routesHelp('heartbeat', HEARTBEAT_ROUTES)}
Host-wide heartbeat settings (host-extension, ADR 0318). Super-admin only: every
command needs a principal whose tenant is in the server's OPENWOP_SUPERADMIN_TENANTS.
Turning the status off clears any auto-off time. To clear the budget or the auto-off
time, send --body '{"runBudgetPerHour":null}' / '{"enabledUntil":null}'.

Exit codes: 0 ok · 2 usage error / request rejected (422 = invalid value) · 4 not a
super-admin (or not signed in) · 1 server error.

Examples:
  openwop heartbeat settings
  openwop heartbeat settings set --status on --enabled-until 2026-10-01T00:00:00Z
  openwop heartbeat settings set --run-budget-per-hour 60
`;

export async function runHeartbeat(ctx: Ctx, argv: string[]): Promise<number> {
  try {
    return await runRouteGroup(ctx, 'heartbeat', HEARTBEAT_HELP, HEARTBEAT_ROUTES, argv);
  } catch (err) {
    if (err instanceof CliError && err.code === 4) throw new CliError(`${gateAdvice('superadmin', 'Heartbeat settings')}\n${err.message}`, 4);
    throw err;
  }
}

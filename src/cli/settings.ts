import type { Ctx } from '../context.js';
/**
 * `openwop settings ...` — your personal server-side settings (ADR 0396 §4):
 * a daily token cap on your own provider keys, the reasoning-directive
 * strength, and privacy opt-outs. Self-scoped: the host keys every read and
 * write by the signed-in user, never by an id the CLI sends.
 *
 *   GET|PUT /v1/host/openwop-app/settings/prefs
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const PATH = '/v1/host/openwop-app/settings/prefs';

export const SETTINGS_ROUTES: RouteCmd[] = [
  { words: ['prefs'], method: 'GET', path: PATH, summary: 'Your settings plus today\'s token usage (your own keys, and the free tier when configured).' },
  { words: ['prefs', 'set'], method: 'PUT', path: PATH,
    rmw: { pick: (b: any) => ({ personalBudget: b?.personalBudget ?? null, reasoningDirective: b?.reasoningDirective ?? null, privacy: b?.privacy ?? null }) },
    summary: 'Change your settings. Read-modify-write, so settings you do not pass keep their value.',
    body: [
      { flag: '--daily-token-cap', key: 'personalBudget.dailyTokenCap', type: 'number', help: '0 clears the cap' },
      { flag: '--soft-warning-pct', key: 'personalBudget.softWarningPct', type: 'number', help: '1–100' },
      { flag: '--reasoning-directive', key: 'reasoningDirective', help: 'off | advisory | mandatory' },
      { flag: '--analytics-opt-out', key: 'privacy.analyticsOptOut', type: 'boolean' },
      { flag: '--crash-reports-opt-out', key: 'privacy.crashReportsOptOut', type: 'boolean' },
      { flag: '--recent-files-opt-out', key: 'privacy.recentFilesOptOut', type: 'boolean' },
    ] },
];

export const SETTINGS_HELP = `Usage:
${routesHelp('settings', SETTINGS_ROUTES)}
Personal settings (host-extension, ADR 0396). Needs a signed-in user; an anonymous
session has no settings. Boolean flags take a --no- form (--no-analytics-opt-out).

Exit codes: 0 ok · 2 usage error / request rejected · 4 not signed in · 1 server error.

Examples:
  openwop settings prefs
  openwop settings prefs set --daily-token-cap 200000 --soft-warning-pct 80
  openwop settings prefs set --reasoning-directive advisory --analytics-opt-out
`;

export async function runSettings(ctx: Ctx, argv: string[]): Promise<number> {
  return runRouteGroup(ctx, 'settings', SETTINGS_HELP, SETTINGS_ROUTES, argv);
}

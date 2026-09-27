import type { Ctx } from '../context.js';
/**
 * `openwop client-support` — the client-support handshake
 * (openwop-app ADR 0413; host-extension, public, advertise-only).
 *
 *   GET /v1/host/openwop-app/client-support?build=<int>&platform=<web|ios|android>
 *
 * A client asks whether its build is still supported; the host answers with the
 * operator-configured minimum build (a floor) and an optional upgrade URL. The
 * host never enforces it — the client self-gates. Operators use this to check
 * what a given build would be told before shipping or retiring a client.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

export const CLIENT_SUPPORT_HELP = `Usage:
  openwop client-support [--build <n>] [--platform web|ios|android] [--json]

Ask the host whether a client build is still supported (ADR 0413;
GET /v1/host/openwop-app/client-support, public — no credentials needed).
The host reports the minimum supported build for the platform (0 = no floor)
and, when the build is below it, an upgrade URL. It is advertise-only: nothing
is blocked server-side; the client decides what to do.

  --build <n>        The client build number to check (a non-negative integer).
                     Omitted = unknown build, which is always reported supported.
  --platform <p>     web | ios | android (anything else uses the global floor).

Exit codes: 0 supported · 3 below the floor (upgrade needed) · 2 usage.

Examples:
  openwop client-support
  openwop client-support --platform ios --build 41 --json
`;

export async function runClientSupport(ctx: Ctx, argv: string[]): Promise<number> {
  if (argv[0] === 'check') argv = argv.slice(1);
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--build', '--platform'] });
  if (options.help) { write(ctx.io.stdout, CLIENT_SUPPORT_HELP); return 0; }
  if (options.build !== undefined && !/^\d+$/.test(String(options.build))) throw new CliError('--build must be a non-negative integer.', 2);
  if (options.platform !== undefined && !['web', 'ios', 'android'].includes(options.platform)) {
    throw new CliError('--platform must be web, ios or android.', 2);
  }
  const q = new URLSearchParams();
  if (options.build !== undefined) q.set('build', String(options.build));
  if (options.platform) q.set('platform', String(options.platform));
  const qs = q.toString();
  const res = await requestJson(ctx, `/v1/host/openwop-app/client-support${qs ? `?${qs}` : ''}`, { auth: false });
  const r = res.body ?? {};
  if (ctx.json) writeJson(ctx.io.stdout, r);
  else {
    writeLine(ctx.io.stdout, `platform: ${r.platform ?? ''}`);
    writeLine(ctx.io.stdout, `minBuild: ${r.minBuild ?? 0}${r.minBuild ? '' : ' (no floor)'}`);
    if (r.build !== undefined) writeLine(ctx.io.stdout, `build: ${r.build}`);
    writeLine(ctx.io.stdout, `supported: ${r.supported === false ? 'no' : 'yes'}`);
    if (r.upgradeUrl) writeLine(ctx.io.stdout, `upgradeUrl: ${r.upgradeUrl}`);
  }
  return r.supported === false ? 3 : 0;
}

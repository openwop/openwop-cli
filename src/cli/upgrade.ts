import type { Ctx } from '../context.js';
/** `openwop upgrade` — check the npm registry for a newer @openwop/cli and show how
 *  to update. Report-only (never auto-installs — a global npm mutation is the user's call). */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { VERSION } from '../constants.js';

const REGISTRY = 'https://registry.npmjs.org/@openwop/cli/latest';

export const UPGRADE_HELP = `Usage:
  openwop upgrade [--json]

Check npm for a newer @openwop/cli and print how to update. Report-only — it never
installs. Update the global CLI yourself with:
  npm install -g @openwop/cli@latest
`;

/** Compare two dotted SemVers; >0 if a is newer. */
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export async function runUpgrade(ctx: Ctx, argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    write(ctx.io.stdout, UPGRADE_HELP);
    return 0;
  }
  let latest = '';
  try {
    const res = await ctx.fetchImpl(REGISTRY, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    latest = ((await res.json()) as { version?: string }).version ?? '';
  } catch (err) {
    throw new CliError(`Could not reach the npm registry to check for updates: ${(err as Error).message}`, 1);
  }
  const behind = latest !== '' && semverGt(latest, VERSION);
  if (ctx.json) {
    writeJson(ctx.io.stdout, { current: VERSION, latest, upToDate: !behind });
    return 0;
  }
  if (!behind) {
    writeLine(ctx.io.stdout, `@openwop/cli is up to date (${VERSION}).`);
    return 0;
  }
  writeLine(ctx.io.stdout, `A newer @openwop/cli is available: ${VERSION} → ${latest}`);
  writeLine(ctx.io.stdout, 'Update with:  npm install -g @openwop/cli@latest');
  return 0;
}

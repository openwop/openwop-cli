import type { Ctx } from '../context.js';
/** `openwop brand ...` — the white-label app brand: runtime identity + generative theme (ADR 0170 / 0171). */
import { CliError, HttpError } from '../errors.js';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const PUBLIC_PATH = '/v1/host/openwop-app/public-brand';
const APP_PATH = '/v1/host/openwop-app/app-brand';

const CONTRAST = ['standard', 'medium', 'high'];
const RADIUS = ['sm', 'md', 'lg'];
const MODE = ['system', 'light', 'dark'];

export const BRAND_HELP = `Usage:
  openwop brand public [--json]
  openwop brand get [--json]
  openwop brand set [--name <n>] [--product-name <n>] [--accent <color>] [--neutral <color>]
                    [--contrast standard|medium|high] [--radius sm|md|lg] [--default-mode system|light|dark]
                    [--logo <url>] [--favicon <url>] [--identity-json <json>] [--json]

White-label app brand for the OpenWOP demo host (ADR 0170 / 0171). ONE brand owns the
app's own runtime identity — logo, colors, fonts, name, and a generative theme — applied
to the running app with no rebuild. Drives the host-extension surface
GET/PUT /v1/host/openwop-app/{public-brand,app-brand}:
  • public — the applied identity every visitor sees (anonymous; no auth needed).
  • get / set — read + edit the reserved app brand; requires SUPER-ADMIN
    (OPENWOP_SUPERADMIN_TENANTS; authenticate as that tenant).

'set' is read-modify-write: it fetches the current brand, applies your flags, and PUTs
the merged result — so setting --accent won't wipe the logo. The accent/neutral/contrast/
radius flags feed the ADR 0171 theme generator, which derives a full, accessible light +
dark theme from the seed (the accent is kept exact; text shades are solved for WCAG-AA).
--identity-json REPLACES the whole identity facet (advanced — mirrors the editor's JSON tier).

  --name <n>          The brand's internal name.
  --product-name <n>  The app's product name (shown in the wordmark / document title).
  --accent <color>    Brand accent seed — any CSS color (oklch / #hex / rgb). Generates the ramp.
  --neutral <color>   Optional surface/background tint seed.
  --contrast <lvl>    Contrast target: standard (AA) | medium | high.
  --radius <size>     Corner radius: sm | md | lg.
  --default-mode <m>  Default theme mode: system | light | dark.
  --logo <url>        Logo / mark URL (https, root-relative, or data:image).
  --favicon <url>     Favicon URL.
  --identity-json <j> Full identity facet as JSON (REPLACES every identity field).
  --json              Machine-readable output.

Examples:
  openwop brand public --json
  openwop brand set --accent 'oklch(58% 0.13 250)' --product-name 'Acme Ops'
  openwop brand set --identity-json '{"productName":"Acme","theme":{"accentSeed":"#0a84ff"}}'
`;

export async function runBrand(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'public';
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, BRAND_HELP);
    return 0;
  }
  const args = argv.slice(['public', 'get', 'set'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'public':
      return await brandPublic(ctx, args);
    case 'get':
      return await brandGet(ctx, args);
    case 'set':
      return await brandSet(ctx, args);
    default:
      throw new CliError(`Unknown brand command: ${sub}\nRun \`openwop brand --help\` for usage.`);
  }
}

/** requestJson against the super-admin app-brand surface, mapping the auth error to a
 *  clear, actionable message (the super-admin gate) instead of a bare `HTTP 403`. */
async function appRequest(ctx: Ctx, path: string, options: Parameters<typeof requestJson>[2], action: string) {
  try {
    return await requestJson(ctx, path, options);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new CliError(
        `${action} requires super-admin on this host. Set OPENWOP_SUPERADMIN_TENANTS on the server and authenticate the CLI as that tenant (openwop onboard / --api-key).`,
        4,
      );
    }
    throw err;
  }
}

function showIdentity(ctx: Ctx, identity: any): void {
  const id = identity ?? {};
  const theme = id.theme ?? {};
  const logo = id.logo ?? {};
  writeLine(ctx.io.stdout, `productName:  ${id.productName ?? '(default)'}`);
  writeLine(ctx.io.stdout, `accent:       ${theme.accentSeed ?? id.colors?.accent ?? '(stock)'}`);
  if (theme.neutralSeed) writeLine(ctx.io.stdout, `neutral:      ${theme.neutralSeed}`);
  writeLine(ctx.io.stdout, `contrast:     ${theme.contrastLevel ?? 'standard'}`);
  if (theme.radius) writeLine(ctx.io.stdout, `radius:       ${theme.radius}`);
  writeLine(ctx.io.stdout, `defaultMode:  ${theme.defaultMode ?? 'system'}`);
  writeLine(ctx.io.stdout, `logo:         ${logo.markSrc ?? '(none)'}`);
  writeLine(ctx.io.stdout, `favicon:      ${logo.faviconSrc ?? '(none)'}`);
  if (theme.override && (theme.override.light || theme.override.dark)) {
    writeLine(ctx.io.stdout, `override:     (advanced token overrides set)`);
  }
}

async function brandPublic(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, 'Usage: openwop brand public [--json]\n');
    return 0;
  }
  const res = await requestJson(ctx, PUBLIC_PATH, { auth: false });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  showIdentity(ctx, res.body?.identity);
  return 0;
}

async function brandGet(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, 'Usage: openwop brand get [--json]\n');
    return 0;
  }
  const res = await appRequest(ctx, APP_PATH, {}, 'Reading the app brand');
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const brand = res.body?.brand ?? {};
  writeLine(ctx.io.stdout, `name:         ${brand.name ?? '(unnamed)'}`);
  showIdentity(ctx, brand.identity);
  return 0;
}

async function brandSet(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, {
    bool: ['--help'],
    value: [
      '--name', '--product-name', '--accent', '--neutral', '--contrast',
      '--radius', '--default-mode', '--logo', '--favicon', '--identity-json',
    ],
  });
  if (options.help) {
    write(ctx.io.stdout, BRAND_HELP);
    return 0;
  }
  const enumErr = (flag: string, val: unknown, allowed: string[]): void => {
    if (val !== undefined && !allowed.includes(String(val))) {
      throw new CliError(`--${flag} must be one of: ${allowed.join(' | ')} (got: ${String(val)})`, 2);
    }
  };
  enumErr('contrast', options.contrast, CONTRAST);
  enumErr('radius', options.radius, RADIUS);
  enumErr('default-mode', options.defaultMode, MODE);

  // Read-modify-write: PUT replaces the identity facet, so start from the current one
  // (unless --identity-json is a full replacement) and layer the flags on top.
  const cur = await appRequest(ctx, APP_PATH, {}, 'Reading the app brand');
  const current = cur.body?.brand ?? {};

  let identity: Record<string, any>;
  if (options.identityJson) {
    try {
      identity = JSON.parse(String(options.identityJson));
    } catch (err) {
      throw new CliError(`--identity-json is not valid JSON: ${(err as Error).message}`, 2);
    }
    if (!identity || typeof identity !== 'object') throw new CliError('--identity-json must be a JSON object', 2);
  } else {
    identity = { ...(current.identity ?? {}) };
    if (options.productName) identity.productName = String(options.productName);
    if (options.logo || options.favicon) {
      identity.logo = { ...(identity.logo ?? {}) };
      if (options.logo) identity.logo.markSrc = String(options.logo);
      if (options.favicon) identity.logo.faviconSrc = String(options.favicon);
    }
    const theme = { ...(identity.theme ?? {}) };
    if (options.accent) theme.accentSeed = String(options.accent);
    if (options.neutral) theme.neutralSeed = String(options.neutral);
    if (options.contrast) theme.contrastLevel = String(options.contrast);
    if (options.radius) theme.radius = String(options.radius);
    if (options.defaultMode) theme.defaultMode = String(options.defaultMode);
    if (Object.keys(theme).length) identity.theme = theme;
  }

  const body: Record<string, any> = { identity };
  if (options.name) body.name = String(options.name);

  const res = await appRequest(ctx, APP_PATH, { method: 'PUT', body }, 'Updating the app brand');
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, 'App brand updated. Applied live to the running app.');
  showIdentity(ctx, res.body?.brand?.identity);
  return 0;
}

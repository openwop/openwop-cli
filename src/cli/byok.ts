import type { Ctx } from '../context.js';
/** `openwop byok ...` — host-side BYOK secret store; the wire never returns values. */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { readSecret } from '../prompt.js';

export const BYOK_HELP = `Usage:
  openwop byok list [--json]
  openwop byok set --ref <credentialRef> [--value <secret>] [--json]
  openwop byok delete <credentialRef> [--yes]
  openwop byok ai-default [get] [--json]
  openwop byok ai-default set <credentialRef> [--json]
  openwop byok ai-default clear [--yes]
  openwop byok active-config [get] [--json]
  openwop byok active-config set --provider <id> --model <id> --ref <credentialRef> [--json]
  openwop byok active-config clear --yes

Bring-your-own-key secret store (host-side). The host holds the secret; the
credential-payload-redaction invariant (RFC 0046) means a value is NEVER
returned over the wire — 'list' shows only refs, and 'set' echoes only a
masked preview. Drives /v1/host/openwop-app/byok/secrets. If --value is omitted,
'set' prompts for it without echoing to the terminal.

  --ref <credentialRef>  Opaque ref a workflow/pack uses to fetch the secret
                         (matches [a-zA-Z0-9_.:-]{1,128}).
  --value <secret>       The secret material. Prefer the interactive prompt
                         (omit this flag) so the secret never lands in shell history.

active-config (GET/PUT/DELETE /v1/host/openwop-app/byok/active-config) is the workspace's
chat binding — which provider + model + credential REF the AI chat dispatches through.
'get' reports the host's own verdict: whether a binding is STORED (vs the managed default
it falls back to) and whether it is VALID (can actually dispatch). Changing it needs
host:byok:manage in a shared workspace (exit 4 otherwise).

Examples:
  openwop byok active-config
  openwop byok active-config set --provider anthropic --model claude-sonnet-4-5 --ref anthropic-prod
  openwop byok list
  openwop byok set --ref anthropic-prod          # prompts for the value
  openwop byok delete anthropic-prod --yes
`;

export async function runByok(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, BYOK_HELP); return 0; }
  const args = argv.slice(['list', 'set', 'delete', 'ai-default', 'active-config'].includes(sub) ? 1 : 0);
  switch (sub) {
    case 'list': return await byokList(ctx, args);
    case 'set': return await byokSet(ctx, args);
    case 'delete': return await byokDelete(ctx, args);
    case 'ai-default': return await byokAiDefault(ctx, args);
    case 'active-config': return await byokActiveConfig(ctx, args);
    default:
      throw new CliError(`Unknown byok command: ${sub}\nRun \`openwop byok --help\` for usage.`);
  }
}

async function byokList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, BYOK_HELP); return 0; }
  const res = await requestJson(ctx, '/v1/host/openwop-app/byok/secrets');
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const refs = Array.isArray(res.body?.credentialRefs) ? res.body.credentialRefs : [];
  if (refs.length === 0) { writeLine(ctx.io.stdout, 'No BYOK secrets stored. Add one with `openwop byok set --ref <name>`.'); return 0; }
  // Refs may be plain strings or {credentialRef, masked, createdAt} objects.
  const rows = refs.map((r: any) => typeof r === 'string'
    ? { credentialRef: r, masked: '', createdAt: '' }
    : { credentialRef: r.credentialRef ?? '', masked: r.masked ?? '', createdAt: r.createdAt ?? '' });
  writeLine(ctx.io.stdout, formatTable(rows, ['credentialRef', 'masked', 'createdAt']));
  return 0;
}

async function byokSet(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--ref', '--value'] });
  if (options.help || !options.ref) {
    write(ctx.io.stdout, 'Usage: openwop byok set --ref <credentialRef> [--value <secret>] [--json]\n');
    return options.help ? 0 : 2;
  }
  let value: string | undefined = options.value;
  if (value === undefined) {
    const entered = await readSecret(ctx, `Secret value for "${options.ref}": `);
    value = typeof entered === 'string' ? entered : String(entered ?? '');
  }
  if (!value) throw new CliError('A non-empty --value (or prompted secret) is required.', 2);
  const res = await requestJson(ctx, '/v1/host/openwop-app/byok/secrets', {
    method: 'POST',
    body: { credentialRef: options.ref, value },
  });
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  writeLine(ctx.io.stdout, `Stored ${res.body?.credentialRef ?? options.ref} (${res.body?.masked ?? 'masked'}).`);
  return 0;
}

async function byokDelete(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help', '--yes'] });
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, 'Usage: openwop byok delete <credentialRef> [--yes]\n'); return options.help ? 0 : 2; }
  if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete secret ${positionals[0]} without --yes.`); return 2; }
  await requestJson(ctx, `/v1/host/openwop-app/byok/secrets/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  writeLine(ctx.io.stdout, `Deleted secret ref ${positionals[0]}.`);
  return 0;
}

/** The headless AI-default credential binding (ADR 0110): GET/PUT/DELETE
 *  /v1/host/openwop-app/byok/ai-default. `set` binds a stored credentialRef as the
 *  default the host uses when a run doesn't name one; `clear` removes it. */
async function byokAiDefault(ctx: Ctx, argv: string[]) {
  const action = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'get';
  const rest = ['get', 'set', 'clear'].includes(action) ? argv.slice(1) : argv;
  const { options, positionals } = parseOptions(rest, { bool: ['--help', '--yes'] });
  if (options.help) { write(ctx.io.stdout, BYOK_HELP); return 0; }
  const path = '/v1/host/openwop-app/byok/ai-default';
  if (action === 'set') {
    if (positionals.length !== 1) { write(ctx.io.stderr, 'Usage: openwop byok ai-default set <credentialRef> [--json]\n'); return 2; }
    const res = await requestJson(ctx, path, { method: 'PUT', body: { credentialRef: positionals[0] } });
    if (ctx.json) writeJson(ctx.io.stdout, res.body);
    else writeLine(ctx.io.stdout, `AI-default credential set to ${positionals[0]}.`);
    return 0;
  }
  if (action === 'clear') {
    if (!options.yes) { writeLine(ctx.io.stderr, 'Refusing to clear the AI-default binding without --yes.'); return 2; }
    await requestJson(ctx, path, { method: 'DELETE' });
    writeLine(ctx.io.stdout, 'AI-default credential cleared.');
    return 0;
  }
  const res = await requestJson(ctx, path);
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `AI-default credentialRef: ${res.body?.credentialRef ?? '(none)'}`);
  return 0;
}

/** GET/PUT/DELETE /byok/active-config — the workspace chat binding (refs only). */
async function byokActiveConfig(ctx: Ctx, argv: string[]) {
  const verb = argv[0] === 'set' || argv[0] === 'clear' || argv[0] === 'get' ? argv[0] : 'get';
  const rest = argv[0] === verb ? argv.slice(1) : argv;
  const { options } = parseOptions(rest, { bool: ['--help', '--yes'], value: ['--provider', '--model', '--ref'] });
  if (options.help) { write(ctx.io.stdout, BYOK_HELP); return 0; }
  const path = '/v1/host/openwop-app/byok/active-config';
  if (verb === 'set') {
    if (!options.provider || !options.model || !options.ref) {
      write(ctx.io.stdout, 'Usage: openwop byok active-config set --provider <id> --model <id> --ref <credentialRef> [--json]\n');
      return 2;
    }
    const res = await requestJson(ctx, path, { method: 'PUT', body: { provider: options.provider, model: options.model, credentialRef: options.ref } });
    if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
    const c = res.body?.config ?? {};
    writeLine(ctx.io.stdout, `Chat bound to ${c.provider}/${c.model} via ${c.credentialRef}.`);
    return 0;
  }
  if (verb === 'clear') {
    if (!options.yes) { writeLine(ctx.io.stderr, 'Refusing to clear the chat binding without --yes.'); return 2; }
    await requestJson(ctx, path, { method: 'DELETE' });
    if (ctx.json) { writeJson(ctx.io.stdout, { cleared: true }); return 0; }
    writeLine(ctx.io.stdout, 'Cleared the chat binding (the workspace falls back to the managed default, if any).');
    return 0;
  }
  const res = await requestJson(ctx, path);
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const b = res.body ?? {};
  const c = b.config;
  writeLine(ctx.io.stdout, c ? `binding: ${c.provider ?? '?'}/${c.model ?? '?'} via ${c.credentialRef ?? '?'}` : 'binding: (none)');
  writeLine(ctx.io.stdout, `stored:  ${b.stored ? 'yes (chosen)' : 'no (managed default / none)'}`);
  writeLine(ctx.io.stdout, `valid:   ${b.valid ? 'yes' : 'no'}`);
  if (b.anonymous) writeLine(ctx.io.stdout, 'note:    anonymous session — a signed-in workspace\'s binding is not visible here.');
  return 0;
}

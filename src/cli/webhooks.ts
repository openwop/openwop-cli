import type { Ctx } from '../context.js';
/** `openwop webhooks ...` — manage HMAC-signed webhook subscriptions. */
import { requestJson } from '../api.js';
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { failClosedOn404 } from './requestHelpers.js';
import { idempotencyHeaders } from '../wire.js';

export const WEBHOOKS_HELP = `Usage:
  openwop webhooks list [--json]
  openwop webhooks add <url> --event <type> [--event <type> ...] [--tag t] [--secret s] [--json]
  openwop webhooks remove <subscriptionId> [--json]
  openwop webhooks test <subscriptionId> [--json]
  openwop webhooks rotate-secret <subscriptionId> (--generate | --secret-file <path> | --secret-env <VAR>) [--tenant-id id] [--json]
  openwop webhooks dead-letters <subscriptionId> [--limit n] [--cursor c] [--json]

Manage HMAC-signed webhook subscriptions on the configured host (POST/GET/DELETE
/v1/webhooks per spec/v1/webhooks.md).

  add     Registers a subscription. Supply --event one or more times. When you
          omit --secret, the host generates one and returns it ONCE in the add
          response — store it to verify delivery signatures.
  test    Fires a synthetic, signed \`webhook.test\` delivery to the
          subscription URL so you can confirm reachability + signature handling.
          A 202 means the delivery was dispatched, not that the endpoint acked.

  rotate-secret
          Rotates a Standard Webhooks subscription's signing secret with an
          overlap window (POST /v1/webhooks/{id}/rotate-secret; RFC 0201 §E.18).
          Until previousSecretExpiresAt both secrets sign; afterwards only the
          new one. Only a subscription registered with standard-webhooks-1 can
          rotate (400 otherwise); a host without the secretRotation facet is 404.
          The new secret (whsec_<base64>, 24–64 bytes) comes from a file, an env
          var, or --generate (32 random bytes, printed ONCE — store it now; the
          host never returns it). It is never taken from the command line.
  dead-letters
          Lists the subscription's dead-lettered deliveries, newest first
          (GET /v1/webhooks/{id}/dead-letters; RFC 0188 §A.1, a protocol-v2
          operation). Content-free: a record names a delivery, never its bytes.
          A host without the webhooks.deadLetter facet answers 404 (exit 1).
          Page with --cursor <nextCursor>.

Note: \`list\` never returns the signing secret.
`;

export async function runWebhooks(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  const args = argv.slice(['list', 'add', 'remove', 'rm', 'test', 'rotate-secret', 'dead-letters'].includes(sub) ? 1 : 0);
  if (sub === '--help' || sub === '-h') {
    write(ctx.io.stdout, WEBHOOKS_HELP);
    return 0;
  }
  switch (sub) {
    case 'list':
      return await runWebhooksList(ctx, args);
    case 'add':
      return await runWebhooksAdd(ctx, args);
    case 'remove':
    case 'rm':
      return await runWebhooksRemove(ctx, args);
    case 'test':
      return await runWebhooksTest(ctx, args);
    case 'rotate-secret':
      return await runWebhooksRotateSecret(ctx, args);
    case 'dead-letters':
      return await runWebhooksDeadLetters(ctx, args);
    default:
      throw new CliError(`Unknown webhooks command: ${sub}\nRun \`openwop webhooks --help\` for usage.`);
  }
}

async function runWebhooksList(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, WEBHOOKS_HELP);
    return 0;
  }
  const res = await requestJson(ctx, '/v1/webhooks');
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  const subscriptions = Array.isArray(res.body?.subscriptions) ? res.body.subscriptions : [];
  if (subscriptions.length === 0) {
    writeLine(ctx.io.stdout, 'No webhook subscriptions. Add one with `openwop webhooks add <url> --event <type>`.');
    return 0;
  }
  const rows = subscriptions.map((s: any) => ({
    subscriptionId: s.subscriptionId,
    url: s.url,
    events: Array.isArray(s.events) ? s.events.join(',') : '',
    createdAt: s.createdAt ?? '',
  }));
  writeLine(ctx.io.stdout, formatTable(rows, ['subscriptionId', 'url', 'events', 'createdAt']));
  return 0;
}

async function runWebhooksAdd(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help'],
    value: ['--secret'],
    multi: ['--event', '--tag'],
  });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop webhooks add <url> --event <type> [--event <type> ...] [--tag t] [--secret s] [--json]\n');
    return options.help ? 0 : 2;
  }
  const events = options.event ?? [];
  if (events.length === 0) {
    throw new CliError('At least one --event <type> is required.');
  }
  const body = {
    url: positionals[0],
    events,
    ...(options.tag ? { tags: options.tag } : {}),
    ...(options.secret ? { secret: options.secret } : {}),
  };
  const res = await requestJson(ctx, '/v1/webhooks', { method: 'POST', body, headers: idempotencyHeaders() });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `✓ Registered webhook ${res.body.subscriptionId} → ${res.body.url}`);
  if (res.body.secret) {
    writeLine(ctx.io.stdout, `  Signing secret (shown once): ${res.body.secret}`);
  }
  return 0;
}

async function runWebhooksRemove(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop webhooks remove <subscriptionId> [--json]\n');
    return options.help ? 0 : 2;
  }
  await requestJson(ctx, `/v1/webhooks/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
  if (ctx.json) writeJson(ctx.io.stdout, { removed: positionals[0] });
  else writeLine(ctx.io.stdout, `✓ Removed webhook ${positionals[0]}`);
  return 0;
}

async function runWebhooksTest(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop webhooks test <subscriptionId> [--json]\n');
    return options.help ? 0 : 2;
  }
  const res = await requestJson(ctx, `/v1/webhooks/${encodeURIComponent(positionals[0])}/test`, { method: 'POST', body: {} });
  if (ctx.json) {
    writeJson(ctx.io.stdout, res.body);
    return 0;
  }
  writeLine(ctx.io.stdout, `✓ Test delivery dispatched to ${res.body.url} (event ${res.body.eventType}).`);
  return 0;
}

const WHSEC = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

async function runWebhooksRotateSecret(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, {
    bool: ['--help', '--generate'],
    value: ['--secret-file', '--secret-env', '--tenant-id'],
  });
  const usage = 'Usage: openwop webhooks rotate-secret <subscriptionId> (--generate | --secret-file <path> | --secret-env <VAR>) [--tenant-id id] [--json]\n';
  if (options.help || positionals.length !== 1) { write(ctx.io.stdout, usage); return options.help ? 0 : 2; }
  const sources = [options.generate, options.secretFile, options.secretEnv].filter(Boolean).length;
  if (sources !== 1) throw new CliError('Pass exactly one of --generate, --secret-file <path>, --secret-env <VAR>.', 2);
  let secret: string;
  if (options.generate) {
    secret = `whsec_${randomBytes(32).toString('base64')}`;
  } else if (options.secretFile) {
    try { secret = readFileSync(String(options.secretFile), 'utf8').trim(); } catch (err) {
      throw new CliError(`Could not read ${options.secretFile}: ${err instanceof Error ? err.message : String(err)}`, 2);
    }
  } else {
    secret = String(ctx.env[String(options.secretEnv)] ?? '').trim();
    if (!secret) throw new CliError(`Environment variable ${options.secretEnv} is empty or unset.`, 2);
  }
  if (!WHSEC.test(secret)) throw new CliError('The new secret must be whsec_<base64> (24–64 bytes once decoded).', 2);
  const qs = options.tenantId ? `?tenantId=${encodeURIComponent(options.tenantId)}` : '';
  let res;
  try {
    res = await requestJson(ctx, `/v1/webhooks/${encodeURIComponent(positionals[0])}/rotate-secret${qs}`, {
      method: 'POST',
      body: { secret },
      headers: idempotencyHeaders(),
    });
  } catch (err) {
    failClosedOn404(err, 'webhooks rotate-secret');
  }
  if (ctx.json) writeJson(ctx.io.stdout, res.body);
  else writeLine(ctx.io.stdout, `✓ Rotated the secret of ${positionals[0]} at ${res.body?.rotatedAt ?? ''}; the previous secret keeps signing until ${res.body?.previousSecretExpiresAt ?? ''}.`);
  if (options.generate) {
    // The one reveal: the operator needs the new secret to verify deliveries.
    writeLine(ctx.io.stderr, 'openwop: new signing secret below — shown ONCE, never stored by this CLI; store it now:');
    writeLine(ctx.io.stderr, secret);
  }
  return 0;
}

async function runWebhooksDeadLetters(ctx: Ctx, argv: string[]) {
  const { options, positionals } = parseOptions(argv, { bool: ['--help'], value: ['--limit', '--cursor'] });
  if (options.help || positionals.length !== 1) {
    write(ctx.io.stdout, 'Usage: openwop webhooks dead-letters <subscriptionId> [--limit n] [--cursor c] [--json]\n');
    return options.help ? 0 : 2;
  }
  const q = new URLSearchParams();
  if (options.limit) q.set('limit', String(options.limit));
  if (options.cursor) q.set('cursor', String(options.cursor));
  const qs = q.toString();
  let res;
  try {
    res = await requestJson(ctx, `/v1/webhooks/${encodeURIComponent(positionals[0])}/dead-letters${qs ? `?${qs}` : ''}`);
  } catch (err) {
    failClosedOn404(err, 'webhooks dead-letters');
  }
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
  const items = Array.isArray(res.body?.deliveries) ? res.body.deliveries : [];
  if (items.length === 0) writeLine(ctx.io.stdout, `No dead-lettered deliveries for ${positionals[0]}.`);
  else writeLine(ctx.io.stdout, formatTable(items.map((d: any) => ({
    deliveryId: d.deliveryId ?? '',
    runId: d.runId ?? '',
    eventType: d.eventType ?? '',
    attempts: d.attempts === undefined ? '' : String(d.attempts),
    reason: d.reason ?? '',
    lastStatus: d.lastStatus === undefined ? '' : String(d.lastStatus),
    deadLetteredAt: d.deadLetteredAt ?? '',
    expiresAt: d.expiresAt ?? '',
  })), ['deliveryId', 'runId', 'eventType', 'attempts', 'reason', 'lastStatus', 'deadLetteredAt', 'expiresAt']));
  if (res.body?.nextCursor) writeLine(ctx.io.stdout, `More: --cursor ${res.body.nextCursor}`);
  return 0;
}

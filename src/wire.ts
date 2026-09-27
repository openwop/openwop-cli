/**
 * v2 client obligations that are not path negotiation (that is src/protocol.ts):
 * the `Idempotency-Key` request header and the `minClientVersion` floor.
 */
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';

/**
 * `spec/v2/core/idempotency.md` §Layer 1 grammar: 22–128 chars of
 * `[A-Za-z0-9._~-]`, ≥ 128 bits of entropy (a canonical UUIDv4 satisfies it).
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{22,128}$/;

/**
 * `{ 'idempotency-key': <key> }` for a mutating request. With no `key` a fresh
 * UUIDv4 is minted, so a retry of the same HTTP request cannot duplicate the
 * effect; a caller-supplied key (`--idempotency-key`) lets a user re-run the
 * same COMMAND safely after a timeout. A key outside the grammar is refused
 * locally — the host would answer `400 idempotency_key_invalid` anyway.
 * Sent under both majors: v1 `POST /v1/runs` and `POST /v1/interrupts/{token}`
 * declare the same header.
 */
export function idempotencyHeaders(key?: string): Record<string, string> {
  const value = key ?? randomUUID();
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new CliError(`--idempotency-key must match ${IDEMPOTENCY_KEY_PATTERN.source} (22–128 characters; a UUID works).`, 2);
  }
  return { 'idempotency-key': value };
}

/** True when a response was served from the host's idempotency cache (`OpenWOP-Idempotent-Replay: true`). */
export function isIdempotentReplay(headers: Headers | undefined): boolean {
  return headers?.get?.('openwop-idempotent-replay') === 'true';
}

/**
 * The protocol version this CLI speaks under each major it implements
 * (versioning.md §1.3: `<major>.<minor>`, only the major selects; §1.5: the
 * minor is what `minClientVersion` pins). 2.0 is the v2 corpus line this build
 * is audited against (tag v2.42.6); 1.1 is the newest v1 minor it has been
 * exercised against.
 */
export const CLI_PROTOCOL_VERSION_BY_MAJOR: Readonly<Record<1 | 2, string>> = { 2: '2.0', 1: '1.1' };

function parseVersion(v: string): [number, number] | null {
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Compare the CLI's version under `major` against a host's `minClientVersion`
 * (versioning.md §1.5 — axis 15; a host MAY refuse a client below it with
 * `426 client_version_unsupported`). `unknown` when the host sent no floor or
 * an ungrammatical one — never a guess.
 */
export function checkMinClientVersion(minClientVersion: unknown, major: 1 | 2): { status: 'ok' | 'below' | 'unknown'; client: string; required?: string } {
  const client = CLI_PROTOCOL_VERSION_BY_MAJOR[major];
  if (typeof minClientVersion !== 'string') return { status: 'unknown', client };
  const req = parseVersion(minClientVersion);
  const mine = parseVersion(client)!;
  if (!req) return { status: 'unknown', client, required: minClientVersion };
  const below = mine[0] < req[0] || (mine[0] === req[0] && mine[1] < req[1]);
  return { status: below ? 'below' : 'ok', client, required: minClientVersion };
}

import { streamOrigin, STREAM_SOURCE_LABEL } from '../protocol.js';
import type { Ctx } from '../context.js';
/** `openwop doctor` — check local prerequisites + demo reachability. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { write, writeLine, writeJson } from '../io.js';
import { parseOptions } from '../options.js';
import { probeEndpoint, safeRequest } from '../api.js';
import { readDiscovery } from './capabilities.js';
import { checkMinClientVersion } from '../wire.js';
import { errText } from '../errors.js';
import { readDaemonRecord, processAlive } from '../daemon.js';
import { demoProjects } from '../repo.js';
import { ok, warn, fail, formatCheckTable, parseNodeVersion, npmCommand, type CheckResult } from './shared.js';
import { loadRelayConfig, detectChannelAvailability } from './relayShared.js';

export const DOCTOR_HELP = `Usage: openwop doctor [--json]

Checks Node/npm, local demo app dependencies, repository layout, whether the demo
backend is reachable, the demo daemon status (via /v1/host/openwop-app/daemon-status or
the ~/.openwop/ PID file), and reachability of each stored BYOK provider credential.
`;

export async function runDoctor(ctx: Ctx, argv: string[]) {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) {
    write(ctx.io.stdout, DOCTOR_HELP);
    return 0;
  }

  const checks: CheckResult[] = [];
  const node = parseNodeVersion(process.versions.node);
  if (node.major >= 22) {
    checks.push(ok('node', `Node ${process.versions.node} is ready for the demo backend`));
  } else if (node.major >= 20) {
    checks.push(warn('node', `Node ${process.versions.node} can run the CLI, but the demo backend declares Node >=22`));
  } else {
    checks.push(fail('node', `Node ${process.versions.node} is too old; install Node 22+`));
  }

  const npm = spawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
  if (npm.status === 0) checks.push(ok('npm', `npm ${npm.stdout.trim()}`));
  else checks.push(fail('npm', 'npm was not found on PATH'));

  const root = ctx.repoRoot;
  if (root) {
    checks.push(ok('repo', root));
  } else {
    checks.push(fail('repo', 'Could not locate the OpenWOP repository root'));
  }

  for (const project of demoProjects(root)) {
    if (!existsSync(project.packageJson)) {
      checks.push(fail(project.name, `Missing ${project.packageJson}`));
    } else if (existsSync(project.nodeModules)) {
      checks.push(ok(project.name, 'dependencies installed'));
    } else {
      checks.push(warn(project.name, `dependencies not installed; run npm install in ${project.relativeDir}`));
    }
  }

  const health = await probeEndpoint(ctx, '/health');
  if (health.ok) checks.push(ok('demo health', `${ctx.baseUrl}/health responded`));
  else checks.push(warn('demo health', `demo is not reachable at ${ctx.baseUrl} (${health.message})`));

  // Protocol rows — the CLI negotiates the major once per process
  // (src/protocol.ts; versioning.md §1.5) and reuses that discovery read here
  // (no second fetch). Report what the host advertises and what this process
  // selected; fail when the two share no major, when the host names a client
  // floor above this CLI (§1.5 minClientVersion), or when the response header
  // names a different major than the one asked for (§1.4 — a silent downgrade).
  checks.push(...(await protocolChecks(ctx)));

  // Daemon-status row — prefer the live D-1 route; fall back to the PID file.
  const daemon = await safeRequest(ctx, '/v1/host/openwop-app/daemon-status');
  if (daemon.ok && daemon.body) {
    const b = daemon.body;
    checks.push(ok('daemon', `pid ${b.pid ?? '?'}, up ${b.uptimeSeconds ?? '?'}s (since ${b.startTime ?? '?'})`));
  } else {
    const record = readDaemonRecord(ctx.env);
    if (record && record.pid && processAlive(record.pid)) {
      checks.push(warn('daemon', `PID file says pid ${record.pid} is running but ${ctx.baseUrl}/v1/host/openwop-app/daemon-status is unreachable`));
    } else if (record && record.pid) {
      checks.push(warn('daemon', `stale PID file (pid ${record.pid} not running); run \`openwop demo stop\` to clear it`));
    } else {
      checks.push(warn('daemon', 'no demo backend daemon detected; start one with `openwop demo start --detach`'));
    }
  }

  // Provider-reachability rows — one per stored BYOK credential ref.
  const byok = await safeRequest(ctx, '/v1/host/openwop-app/byok/secrets');
  if (byok.ok) {
    const secrets = Array.isArray(byok.body?.secrets) ? byok.body.secrets : [];
    if (secrets.length === 0) {
      checks.push(warn('providers', 'no BYOK credentials stored; run `openwop onboard` or `openwop providers add <provider>`'));
    } else {
      for (const secret of secrets) {
        const ref = typeof secret === 'string' ? secret : secret.credentialRef;
        checks.push(ok(`provider ${ref}`, 'credential stored on the host'));
      }
    }
  } else {
    checks.push(warn('providers', `could not list BYOK credentials (${byok.error})`));
  }

  // Messaging relay readiness — only meaningful once a relay is configured.
  const relay = loadRelayConfig(ctx);
  if (relay.relayId && relay.channel) {
    checks.push(ok('relay', `${relay.channel} relay ${relay.relayId} configured (host ${relay.baseUrl ?? ctx.baseUrl})`));
    const avail = detectChannelAvailability(relay.channel, ctx.env);
    checks.push(avail.available
      ? ok(`channel ${relay.channel}`, avail.detail)
      : warn(`channel ${relay.channel}`, avail.detail));
  } else {
    checks.push(warn('relay', 'no messaging relay configured; run `openwop relay setup --channel <signal|whatsapp|imessage>`'));
  }

  if (ctx.json) {
    writeJson(ctx.io.stdout, { checks });
  } else {
    writeLine(ctx.io.stdout, 'OpenWOP doctor');
    writeLine(ctx.io.stdout, formatCheckTable(checks));
  }
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

/** The protocol / min-client / response-version rows (exported for tests via the doctor command). */
async function protocolChecks(ctx: Ctx): Promise<CheckResult[]> {
  let discovery: Awaited<ReturnType<typeof readDiscovery>>;
  try {
    discovery = await readDiscovery(ctx);
  } catch (err) {
    return [warn('protocol', `could not read /.well-known/openwop (${errText(err)})`)];
  }
  const { doc, servedVersion, major } = discovery;
  const rows: CheckResult[] = [];
  const versions: unknown = doc?.protocolVersions;
  if (Array.isArray(versions) && versions.length > 0) {
    const advertised = versions.filter((v): v is string => typeof v === 'string');
    const preferred = typeof doc?.preferredVersion === 'string' ? doc.preferredVersion : '?';
    const detail = `protocolVersions ${advertised.join(', ')}; preferredVersion ${preferred}; CLI speaks major ${major}`;
    if (advertised.some((v) => v.startsWith(`${major}.`))) rows.push(ok('protocol', detail));
    else rows.push(fail('protocol', `${detail} — host advertises neither major this CLI implements; see README §"Protocol version support"`));
  }
  // versioning.md §1.4: every protocol response MUST carry OpenWOP-Version
  // naming the contract that produced it. A pre-overlap v1 host never sent it.
  if (servedVersion === undefined) {
    rows.push(major === 2
      ? warn('response version', 'discovery answered without an OpenWOP-Version header (versioning.md §1.4 requires one on every protocol response)')
      : ok('response version', 'discovery answered without an OpenWOP-Version header (a v1-only host)'));
  } else if (servedVersion.startsWith(`${major}.`)) {
    rows.push(ok('response version', `host answered OpenWOP-Version ${servedVersion}`));
  } else {
    rows.push(fail('response version', `asked for major ${major}, host answered OpenWOP-Version ${servedVersion} — a silent downgrade (versioning.md §1.4); pin OPENWOP_PROTOCOL_MAJOR to the major it serves`));
  }
  // versioning.md §1.5 / axis 15 — only the v2 representation carries it.
  const floor = checkMinClientVersion(doc?.minClientVersion, major);
  if (floor.status === 'below') {
    rows.push(fail('min client', `host requires minClientVersion ${floor.required}; this CLI speaks ${floor.client} — run \`openwop upgrade\` (the host MAY refuse it with 426 client_version_unsupported)`));
  } else if (floor.status === 'ok') {
    rows.push(ok('min client', `host minClientVersion ${floor.required}; this CLI speaks ${floor.client}`));
  } else if (floor.required !== undefined) {
    rows.push(warn('min client', `host minClientVersion ${floor.required} is not a <major>.<minor> version`));
  }
  // openwop-app ADR 0761 — streams (and the bearer) may be read from a different
  // origin than --base-url; make that visible, with the opt-out.
  const stream = streamOrigin(ctx);
  rows.push(stream.source === 'base'
    ? ok('stream origin', `event streams use --base-url (${stream.origin})`)
    : ok('stream origin', `event streams use ${stream.origin} — ${STREAM_SOURCE_LABEL[stream.source]}; set --stream-base-url to your --base-url to keep them there`));
  return rows;
}

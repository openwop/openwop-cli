import type { Ctx } from '../context.js';
/**
 * `openwop environments ...` — config environments + promotion (openwop-app
 * ADR 0383 / ADR 0387, `features/environments/routes.ts`). A workspace's live
 * config is snapshotted (content-hashed), then promoted along an ordered chain
 * (dev → staging → prod), rolled back to a historical snapshot, or applied to
 * live. With the promotion-approval gate ON, promote/rollback/apply answer
 * `202 pending_approval` and the move waits in the reviews inbox.
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { arrayOf, parseBool } from './adminShared.js';

const BASE = '/v1/host/openwop-app/environments';
const PROTECTION = ['open', 'protected', 'locked'] as const;

export const ENVIRONMENTS_HELP = `Usage:
  openwop environments list [--drift] [--json]
  openwop environments create <name> [--order <n>] [--protection open|protected|locked] [--json]
  openwop environments ensure-chain [--json]
  openwop environments protect <name> --protection open|protected|locked [--json]
  openwop environments settings [get] [--json]
  openwop environments settings set --require-approval true|false [--json]
  openwop environments snapshots [list] [--json]
  openwop environments snapshot [--source-env <name>] [--json]
  openwop environments preview --to <env> --snapshot <hash> [--json]
  openwop environments promote --from <env> [--to <env>] [--json]
  openwop environments rollback --env <env> --snapshot <hash> [--json]
  openwop environments apply --snapshot <hash> [--json]
  openwop environments promotions [--json]

Config environments + promotion (host extension under ${BASE}; toggle 'environments').
Reads need workspace:read; every write needs host:members:manage in the workspace.

  list          GET   ${BASE}[?drift=1]          environments, config domains, app version
  create        POST  ${BASE}                    add an environment to the chain
  ensure-chain  POST  ${BASE}/ensure-chain       create the default dev → staging → prod chain
  protect       PATCH ${BASE}/:name/protection   set open | protected | locked
  settings      GET/PATCH ${BASE}/settings       the promotion-approval gate
  snapshots     GET   ${BASE}/snapshots          stored config snapshots
  snapshot      POST  ${BASE}/snapshots          snapshot the current live config
  preview       POST  ${BASE}/preview            diff a snapshot against an environment (no change)
  promote       POST  ${BASE}/promote            promote an env's snapshot to the next (or --to) env
  rollback      POST  ${BASE}/rollback           point an env back at a historical snapshot
  apply         POST  ${BASE}/apply              apply a snapshot to the live config
  promotions    GET   ${BASE}/promotions         the promotion ledger

Exit codes: 0 ok · 3 queued for approval (202 pending_approval) · 2 usage / not found /
feature off · 4 permission denied.

Examples:
  openwop environments ensure-chain
  openwop environments snapshot --source-env dev
  openwop environments preview --to staging --snapshot 3f9a...
  openwop environments promote --from dev
  openwop environments settings set --require-approval true
`;

export async function runEnvironments(ctx: Ctx, argv: string[]) {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, ENVIRONMENTS_HELP); return 0; }
  const rest = argv.slice(1);
  const { options, positionals } = parseOptions(rest, {
    bool: ['--help', '--drift'],
    value: ['--order', '--protection', '--require-approval', '--source-env', '--to', '--from', '--env', '--snapshot'],
  });
  if (options.help) { write(ctx.io.stdout, ENVIRONMENTS_HELP); return 0; }
  const emit = (body: any, human: () => void) => { if (ctx.json) writeJson(ctx.io.stdout, body); else human(); };

  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, `${BASE}${options.drift ? '?drift=1' : ''}`);
      emit(res.body, () => {
        const envs = arrayOf(res.body, 'environments');
        if (envs.length === 0) { writeLine(ctx.io.stdout, 'No environments. Create the default chain with `openwop environments ensure-chain`.'); return; }
        writeLine(ctx.io.stdout, formatTable(envs.map((e: any) => ({
          name: e.name, order: e.order ?? '', protection: e.protection ?? '', currentSnapshot: e.currentSnapshot ?? '(none)',
          ...(options.drift ? { drift: e.drift === undefined ? '' : (typeof e.drift === 'object' ? JSON.stringify(e.drift) : String(e.drift)) } : {}),
        })), ['name', 'order', 'protection', 'currentSnapshot', ...(options.drift ? ['drift'] : [])]));
      });
      return 0;
    }
    case 'create': {
      const name = positionals[0];
      if (!name) throw new CliError('Usage: openwop environments create <name> [--order <n>] [--protection open|protected|locked]', 2);
      const body: Record<string, any> = { name };
      if (options.order !== undefined) {
        const n = Number(options.order);
        if (!Number.isFinite(n)) throw new CliError('--order must be a number.', 2);
        body.order = n;
      }
      if (options.protection !== undefined) body.protection = protectionOf(options.protection);
      const res = await requestJson(ctx, BASE, { method: 'POST', body });
      emit(res.body, () => writeLine(ctx.io.stdout, `Created environment ${res.body?.name ?? name} (order ${res.body?.order ?? '?'}, ${res.body?.protection ?? '?'}).`));
      return 0;
    }
    case 'ensure-chain': {
      const res = await requestJson(ctx, `${BASE}/ensure-chain`, { method: 'POST', body: {} });
      emit(res.body, () => writeLine(ctx.io.stdout, `Chain: ${arrayOf(res.body, 'environments').map((e: any) => e.name).join(' → ')}`));
      return 0;
    }
    case 'protect': {
      const name = positionals[0];
      if (!name || options.protection === undefined) throw new CliError('Usage: openwop environments protect <name> --protection open|protected|locked', 2);
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(name)}/protection`, { method: 'PATCH', body: { protection: protectionOf(options.protection) } });
      emit(res.body, () => writeLine(ctx.io.stdout, `${name} is now ${res.body?.protection ?? options.protection}.`));
      return 0;
    }
    case 'settings': {
      if (positionals[0] === 'set') {
        if (options.requireApproval === undefined) throw new CliError('Usage: openwop environments settings set --require-approval true|false', 2);
        const res = await requestJson(ctx, `${BASE}/settings`, { method: 'PATCH', body: { requireApprovalForPromotion: parseBool('--require-approval', options.requireApproval) } });
        emit(res.body, () => writeLine(ctx.io.stdout, `requireApprovalForPromotion: ${res.body?.requireApprovalForPromotion}`));
        return 0;
      }
      const res = await requestJson(ctx, `${BASE}/settings`);
      emit(res.body, () => writeLine(ctx.io.stdout, `requireApprovalForPromotion: ${res.body?.requireApprovalForPromotion ?? false}`));
      return 0;
    }
    case 'snapshots': {
      const res = await requestJson(ctx, `${BASE}/snapshots`);
      emit(res.body, () => {
        const snaps = arrayOf(res.body, 'snapshots');
        if (snaps.length === 0) { writeLine(ctx.io.stdout, 'No snapshots. Take one with `openwop environments snapshot`.'); return; }
        writeLine(ctx.io.stdout, formatTable(snaps.map((s: any) => ({
          hash: s.hash, sourceEnv: s.sourceEnv ?? '', domains: s.domains ? Object.keys(s.domains).join(',') : '', createdBy: s.createdBy ?? '', createdAt: s.createdAt ?? '',
        })), ['hash', 'sourceEnv', 'domains', 'createdBy', 'createdAt']));
      });
      return 0;
    }
    case 'snapshot': {
      const body: Record<string, any> = {};
      if (options.sourceEnv) body.sourceEnv = options.sourceEnv;
      const res = await requestJson(ctx, `${BASE}/snapshots`, { method: 'POST', body });
      emit(res.body, () => writeLine(ctx.io.stdout, `Snapshot ${res.body?.hash ?? '?'}${res.body?.sourceEnv ? ` (from ${res.body.sourceEnv})` : ''}.`));
      return 0;
    }
    case 'preview': {
      if (!options.to || !options.snapshot) throw new CliError('Usage: openwop environments preview --to <env> --snapshot <hash>', 2);
      const res = await requestJson(ctx, `${BASE}/preview`, { method: 'POST', body: { toEnv: options.to, snapshotHash: options.snapshot } });
      writeJson(ctx.io.stdout, res.body);
      return 0;
    }
    case 'promote': {
      if (!options.from) throw new CliError('Usage: openwop environments promote --from <env> [--to <env>]', 2);
      const body: Record<string, any> = { fromEnv: options.from };
      if (options.to) body.toEnv = options.to;
      return movement(ctx, await requestJson(ctx, `${BASE}/promote`, { method: 'POST', body }), 'Promoted');
    }
    case 'rollback': {
      if (!options.env || !options.snapshot) throw new CliError('Usage: openwop environments rollback --env <env> --snapshot <hash>', 2);
      return movement(ctx, await requestJson(ctx, `${BASE}/rollback`, { method: 'POST', body: { env: options.env, snapshotHash: options.snapshot } }), 'Rolled back');
    }
    case 'apply': {
      if (!options.snapshot) throw new CliError('Usage: openwop environments apply --snapshot <hash>', 2);
      return movement(ctx, await requestJson(ctx, `${BASE}/apply`, { method: 'POST', body: { snapshotHash: options.snapshot } }), 'Applied');
    }
    case 'promotions': {
      const res = await requestJson(ctx, `${BASE}/promotions`);
      emit(res.body, () => {
        const rows = arrayOf(res.body, 'promotions');
        if (rows.length === 0) { writeLine(ctx.io.stdout, 'No promotions yet.'); return; }
        writeLine(ctx.io.stdout, formatTable(rows.map((p: any) => ({
          createdAt: p.createdAt ?? '', fromEnv: p.fromEnv ?? '(rollback)', toEnv: p.toEnv ?? '', snapshot: p.snapshotHash ?? '', status: p.status ?? 'applied', actor: p.actor ?? '',
        })), ['createdAt', 'fromEnv', 'toEnv', 'snapshot', 'status', 'actor']));
      });
      return 0;
    }
    default:
      throw new CliError(`Unknown environments command: ${sub}\nRun \`openwop environments --help\` for usage.`);
  }
}

function protectionOf(value: unknown): string {
  const v = String(value);
  if (!(PROTECTION as readonly string[]).includes(v)) throw new CliError(`--protection must be one of ${PROTECTION.join(' | ')}.`, 2);
  return v;
}

/** Render a promote/rollback/apply outcome; a 202 pending_approval exits 3 (attention needed). */
function movement(ctx: Ctx, res: { status: number; body: any }, verb: string): number {
  const pending = res.status === 202 || res.body?.status === 'pending_approval';
  if (ctx.json) { writeJson(ctx.io.stdout, res.body); return pending ? 3 : 0; }
  if (pending) {
    const a = res.body?.approval ?? {};
    writeLine(ctx.io.stdout, `Queued for approval${a.approvalId ?? a.id ? ` (${a.approvalId ?? a.id})` : ''} — a member with host:members:manage must approve it in the reviews inbox.`);
    return 3;
  }
  const b = res.body ?? {};
  writeLine(ctx.io.stdout, `${verb}${b.toEnv ? ` → ${b.toEnv}` : ''}${b.snapshotHash ? ` (snapshot ${b.snapshotHash})` : ''}.`);
  return 0;
}

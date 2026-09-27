import type { Ctx } from '../context.js';
/**
 * `openwop assistant …` — the Chief-of-Staff executive assistant's work graph
 * (openwop-app ADR 0023 executive assistant, ADR 0025 approval loop, ADR 0029
 * operating metrics, ADR 0043 workspace conversation, ADR 0662 approve-what-you-see).
 *
 * Host-extension surface under /v1/host/openwop-app/assistant/*, scoped to the
 * caller's active workspace. The host is the authority for every decision: an
 * action is approved/rejected THROUGH its approval act (a CAS on the host), and
 * an approve MUST carry the content hash of the draft you read — the CLI never
 * computes one, it forwards the hash the host showed you.
 */
import { CliError } from '../errors.js';
import { write, writeLine, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { enc, emit, writeFields } from './chatShared.js';
import { readBodyOption } from './contentHelpers.js';

const BASE = '/v1/host/openwop-app/assistant';

export const ASSISTANT_HELP = `Usage:
  openwop assistant workspace [--json]
  openwop assistant briefing [--json]
  openwop assistant projects list|get|create|update|delete [...]
  openwop assistant commitments list|get|update|delete [...]
  openwop assistant decisions [--project <projectId>] [--json]
  openwop assistant meetings list|get [<meetingId>] [--json]
  openwop assistant stakeholders [--json]
  openwop assistant pending list|approve|reject|edit [...]
  openwop assistant loops list|enable|disable [<loopId>] [--cron <expr>] [--json]
  openwop assistant health [--json]

The executive assistant's work graph on the server
(/v1/host/openwop-app/assistant/*): projects, commitments, decisions, meetings,
stakeholders, the drafted-action approval queue, and the perception loops.

  workspace       POST …/workspace-conversation — open/resume YOUR workspace chat
                  with the assistant (then talk to it with \`openwop chat messages send\`).
  briefing        GET  …/briefing — one batched morning brief.
  projects        GET|POST …/projects, GET|PATCH|DELETE …/projects/{id}
                    create --name <n> [--priority 0-100] [--summary s] [--status active|paused|done|archived]
                    update <id> [--name n] [--priority n] [--summary s] [--status s]
                    delete <id> --yes
  commitments     GET …/commitments[?status&projectId], GET|PATCH|DELETE …/commitments/{id}
                    list [--status open|in-progress|blocked|done|dropped] [--project <id>]
                    update <id> [--status s] [--due-at <iso>] [--project <id>]
                    delete <id> --yes
  decisions       GET …/decisions[?projectId]
  meetings        GET …/meetings, GET …/meetings/{id}
  stakeholders    GET …/stakeholders
  pending         GET …/pending-actions[?status], POST …/{id}/approve|reject,
                  PATCH …/pending-actions/{id}
                    list [--status pending|approved|rejected|sent|failed|suppressed]
                    approve <id> --content-hash <hash>   (the hash shown on the approval
                                                          card you reviewed; required)
                    reject <id>
                    edit <id> [--draft <text>] [--body <json> | --body-file <path>]
  loops           GET …/loops, POST …/loops/{loopId}/enable|disable
  health          GET …/health (server operators only)

Exit codes: 0 ok, 2 usage / not found / already decided, 4 not permitted
(reading the approval queue needs write access to the workspace).

Examples:
  openwop assistant projects create --name "Q3 launch" --priority 80
  openwop assistant commitments list --status open
  openwop assistant pending list --status pending
  openwop assistant pending approve act_123 --content-hash 9f2c…
  openwop assistant loops enable morning-briefing --cron "0 7 * * 1-5"
`;

export async function runAssistant(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, ASSISTANT_HELP); return sub ? 0 : 2; }
  const rest = argv.slice(1);
  switch (sub) {
    case 'workspace': return await runWorkspace(ctx, rest);
    case 'briefing': case 'brief': return await simpleRead(ctx, rest, `${BASE}/briefing`, (b) => writeLine(ctx.io.stdout, JSON.stringify(b?.brief ?? b, null, 2)));
    case 'projects': case 'project': return await runProjects(ctx, rest);
    case 'commitments': case 'commitment': return await runCommitments(ctx, rest);
    case 'decisions': return await runDecisions(ctx, rest);
    case 'meetings': case 'meeting': return await runMeetings(ctx, rest);
    case 'stakeholders': return await simpleRead(ctx, rest, `${BASE}/stakeholders`, (b) => table(ctx, b?.stakeholders, (s) => ({
      stakeholderId: s.stakeholderId, name: s.person?.name ?? s.person?.email ?? '', importance: String(s.importance ?? ''), lastContact: s.lastMeaningfulContactAt ?? '',
    }), 'No stakeholders.'));
    case 'pending': case 'actions': return await runPending(ctx, rest);
    case 'loops': case 'loop': return await runLoops(ctx, rest);
    case 'health': return await simpleRead(ctx, rest, `${BASE}/health`, (b) => writeLine(ctx.io.stdout, JSON.stringify(b?.health ?? b, null, 2)));
    default:
      throw new CliError(`Unknown assistant command: ${sub}\nRun \`openwop assistant --help\` for usage.`, 2);
  }
}

function table(ctx: Ctx, list: unknown, row: (x: any) => Record<string, string>, empty: string) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) { writeLine(ctx.io.stdout, empty); return; }
  const rows = items.map(row);
  writeLine(ctx.io.stdout, formatTable(rows, Object.keys(rows[0])));
}

async function simpleRead(ctx: Ctx, argv: string[], path: string, human: (body: any) => void): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  const res = await requestJson(ctx, path);
  return emit(ctx, res.body, () => human(res.body));
}

async function runWorkspace(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'] });
  if (options.help) { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  const res = await requestJson(ctx, `${BASE}/workspace-conversation`, { method: 'POST', body: {} });
  return emit(ctx, res.body, () => {
    writeLine(ctx.io.stdout, `${res.status === 201 ? 'Opened' : 'Resumed'} workspace conversation ${res.body?.sessionId}.`);
    writeLine(ctx.io.stdout, `Talk to the assistant: openwop chat messages send ${res.body?.sessionId} --content "…"`);
  });
}

const projectRow = (p: any) => ({ projectId: p.projectId, name: p.name ?? '', status: p.status ?? '', priority: String(p.priority ?? ''), updatedAt: p.updatedAt ?? '' });

function numberFlag(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CliError(`${flag} must be a number`, 2);
  return n;
}

async function runProjects(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--name', '--priority', '--summary', '--status'],
  });
  if (options.help || sub === '--help') { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  const id = positionals[0];
  const needId = () => {
    if (!id) throw new CliError(`assistant projects ${sub} requires <projectId>.`, 2);
    return `${BASE}/projects/${enc(id)}`;
  };
  const fields = () => {
    const body: Record<string, any> = {};
    if (options.name) body.name = options.name;
    const priority = numberFlag(options.priority, '--priority');
    if (priority !== undefined) body.priority = priority;
    if (options.summary !== undefined) body.summary = options.summary;
    if (options.status) body.status = options.status;
    return body;
  };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, `${BASE}/projects`);
      return emit(ctx, res.body, () => table(ctx, res.body?.projects, projectRow, 'No assistant projects. Create one with `openwop assistant projects create --name <n>`.'));
    }
    case 'get': {
      const res = await requestJson(ctx, needId());
      const p = res.body ?? {};
      return emit(ctx, res.body, () => writeFields(ctx, [
        ['projectId', p.projectId], ['name', p.name], ['status', p.status], ['priority', p.priority], ['summary', p.summary],
        ['boardId', p.boardId], ['kbCollectionId', p.kbCollectionId], ['stakeholderIds', Array.isArray(p.stakeholderIds) && p.stakeholderIds.length ? p.stakeholderIds.join(', ') : undefined],
        ['createdAt', p.createdAt], ['updatedAt', p.updatedAt],
      ]));
    }
    case 'create': {
      if (!options.name) throw new CliError('assistant projects create requires --name <n>.', 2);
      const res = await requestJson(ctx, `${BASE}/projects`, { method: 'POST', body: fields() });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Created project ${res.body?.projectId} (${res.body?.name ?? options.name}).`));
    }
    case 'update': {
      const path = needId();
      const body = fields();
      if (!Object.keys(body).length) throw new CliError('Nothing to update — pass at least one of --name/--priority/--summary/--status.', 2);
      const res = await requestJson(ctx, path, { method: 'PATCH', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Updated project ${id}.`));
    }
    case 'delete': case 'rm': {
      const path = needId();
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete project ${id} without --yes.`); return 2; }
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted project ${id}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown assistant projects command: ${sub}\nRun \`openwop assistant --help\` for usage.`, 2);
  }
}

const commitmentRow = (c: any) => ({
  commitmentId: c.commitmentId, status: c.status ?? '', owner: c.owner?.name ?? c.owner?.email ?? '', dueAt: c.dueAt ?? '',
  project: c.projectId ?? '', description: String(c.description ?? '').slice(0, 60),
});

async function runCommitments(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help', '--yes'],
    value: ['--status', '--project', '--due-at'],
  });
  if (options.help || sub === '--help') { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  const id = positionals[0];
  const needId = () => {
    if (!id) throw new CliError(`assistant commitments ${sub} requires <commitmentId>.`, 2);
    return `${BASE}/commitments/${enc(id)}`;
  };
  switch (sub) {
    case 'list': {
      const q = new URLSearchParams();
      if (options.status) q.set('status', options.status);
      if (options.project) q.set('projectId', options.project);
      const res = await requestJson(ctx, `${BASE}/commitments${q.size ? `?${q}` : ''}`);
      return emit(ctx, res.body, () => table(ctx, res.body?.commitments, commitmentRow, 'No commitments.'));
    }
    case 'get': {
      const res = await requestJson(ctx, needId());
      const c = res.body ?? {};
      return emit(ctx, res.body, () => writeFields(ctx, [
        ['commitmentId', c.commitmentId], ['status', c.status], ['description', c.description], ['owner', c.owner],
        ['dueAt', c.dueAt], ['projectId', c.projectId], ['confidence', c.confidence], ['kanbanCardId', c.kanbanCardId],
        ['source', c.source ? `${c.source.kind}:${c.source.externalId}` : undefined],
      ]));
    }
    case 'update': {
      const path = needId();
      const body: Record<string, any> = {};
      if (options.status) body.status = options.status;
      if (options.dueAt) body.dueAt = options.dueAt;
      if (options.project) body.projectId = options.project;
      if (!Object.keys(body).length) throw new CliError('Nothing to update — pass --status, --due-at, or --project.', 2);
      const res = await requestJson(ctx, path, { method: 'PATCH', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Updated commitment ${id} (${res.body?.status ?? ''}).`));
    }
    case 'delete': case 'rm': {
      const path = needId();
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete commitment ${id} without --yes.`); return 2; }
      await requestJson(ctx, path, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted commitment ${id}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown assistant commitments command: ${sub}\nRun \`openwop assistant --help\` for usage.`, 2);
  }
}

async function runDecisions(ctx: Ctx, argv: string[]): Promise<number> {
  const { options } = parseOptions(argv, { bool: ['--help'], value: ['--project'] });
  if (options.help) { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  const res = await requestJson(ctx, `${BASE}/decisions${options.project ? `?projectId=${enc(options.project)}` : ''}`);
  return emit(ctx, res.body, () => table(ctx, res.body?.decisions, (d) => ({
    decisionId: d.decisionId, decidedAt: d.decidedAt ?? '', decidedBy: d.decidedBy?.name ?? d.decidedBy?.email ?? '', project: d.projectId ?? '', statement: String(d.statement ?? '').slice(0, 70),
  }), 'No decisions recorded.'));
}

async function runMeetings(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'] });
  if (options.help || sub === '--help') { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  if (sub === 'list') {
    const res = await requestJson(ctx, `${BASE}/meetings`);
    return emit(ctx, res.body, () => table(ctx, res.body?.meetings, (m) => ({
      meetingId: m.meetingId, startAt: m.startAt ?? '', title: m.title ?? '', attendees: String(Array.isArray(m.attendees) ? m.attendees.length : 0),
    }), 'No meetings.'));
  }
  if (sub === 'get') {
    if (!positionals[0]) throw new CliError('assistant meetings get requires <meetingId>.', 2);
    const res = await requestJson(ctx, `${BASE}/meetings/${enc(positionals[0])}`);
    const m = res.body ?? {};
    return emit(ctx, res.body, () => writeFields(ctx, [
      ['meetingId', m.meetingId], ['title', m.title], ['startAt', m.startAt], ['endAt', m.endAt], ['calendarEventId', m.calendarEventId],
      ['attendees', Array.isArray(m.attendees) ? m.attendees.map((a: any) => a.name ?? a.email).join(', ') : undefined],
      ['decisionIds', Array.isArray(m.decisionIds) && m.decisionIds.length ? m.decisionIds.join(', ') : undefined],
      ['commitmentIds', Array.isArray(m.commitmentIds) && m.commitmentIds.length ? m.commitmentIds.join(', ') : undefined],
    ]));
  }
  throw new CliError(`Unknown assistant meetings command: ${sub}\nRun \`openwop assistant --help\` for usage.`, 2);
}

async function runPending(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(1), {
    bool: ['--help'],
    value: ['--status', '--content-hash', '--draft', '--body', '--body-file'],
  });
  if (options.help || sub === '--help') { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  const id = positionals[0];
  const needId = () => {
    if (!id) throw new CliError(`assistant pending ${sub} requires <actionId>.`, 2);
    return `${BASE}/pending-actions/${enc(id)}`;
  };
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, `${BASE}/pending-actions${options.status ? `?status=${enc(options.status)}` : ''}`);
      return emit(ctx, res.body, () => table(ctx, res.body?.pendingActions, (a) => ({
        actionId: a.actionId, kind: a.kind ?? '', status: a.status ?? '', risk: a.riskLevel ?? '', edited: a.editedAt ? 'yes' : '', createdAt: a.createdAt ?? '',
      }), 'No drafted actions.'));
    }
    case 'approve': case 'reject': {
      const path = needId();
      const body: Record<string, any> = {};
      if (sub === 'approve') {
        if (!options.contentHash) {
          throw new CliError('assistant pending approve requires --content-hash <hash> — the hash on the approval card you reviewed (the server refuses an approve of a draft that changed since you read it).', 2);
        }
        body.expectedContentHash = options.contentHash;
      }
      const res = await requestJson(ctx, `${path}/${sub}`, { method: 'POST', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `${sub === 'approve' ? 'Approved' : 'Rejected'} ${id} → ${res.body?.status ?? ''}.`));
    }
    case 'edit': {
      const path = needId();
      const body: Record<string, any> = readBodyOption(ctx, options) ?? {};
      if (options.draft !== undefined) body.draft = options.draft;
      if (!Object.keys(body).length) throw new CliError('Nothing to edit — pass --draft <text> and/or --body <json> ({ draft, payload, recipientDiff }).', 2);
      const res = await requestJson(ctx, path, { method: 'PATCH', body });
      return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Edited draft ${id} (it faces the approver again before anything is sent).`));
    }
    default:
      throw new CliError(`Unknown assistant pending command: ${sub}\nRun \`openwop assistant --help\` for usage.`, 2);
  }
}

async function runLoops(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  const { options, positionals } = parseOptions(argv.slice(1), { bool: ['--help'], value: ['--cron'] });
  if (options.help || sub === '--help') { write(ctx.io.stdout, ASSISTANT_HELP); return 0; }
  if (sub === 'list') {
    const res = await requestJson(ctx, `${BASE}/loops`);
    return emit(ctx, res.body, () => table(ctx, res.body?.loops, (l) => ({
      loopId: l.loopId, label: l.label ?? '', enabled: l.enabled ? 'yes' : 'no', cron: l.cronExpr ?? l.defaultCron ?? '',
      nextFireAt: typeof l.nextFireAt === 'number' ? new Date(l.nextFireAt).toISOString() : (l.nextFireAt ?? ''), lastRunAt: l.lastRunAt ?? '',
    }), 'No assistant loops.'));
  }
  if (sub === 'enable' || sub === 'disable') {
    const loopId = positionals[0];
    if (!loopId) throw new CliError(`assistant loops ${sub} requires <loopId>.`, 2);
    const body: Record<string, any> = {};
    if (sub === 'enable' && options.cron) body.cronExpr = options.cron;
    const res = await requestJson(ctx, `${BASE}/loops/${enc(loopId)}/${sub}`, { method: 'POST', body });
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Loop ${loopId}: ${res.body?.enabled ? 'enabled' : 'disabled'} (job ${res.body?.jobId ?? ''}).`));
  }
  throw new CliError(`Unknown assistant loops command: ${sub}\nRun \`openwop assistant --help\` for usage.`, 2);
}

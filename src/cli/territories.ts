import type { Ctx } from '../context.js';
/**
 * `openwop territories ...` — sales territory management (openwop-app ADR 0272).
 * Host-extension routes under `/v1/host/openwop-app/territories/orgs/:orgId/*`
 * (toggle `territories`; reads need workspace:read, planning edits
 * workspace:write, activate/archive/purge/reassign `host:territories:manage`).
 * `activate`/`archive` do NOT flip the model directly — they queue a review card
 * (HTTP 202) decided in the reviews inbox, because activation changes org-wide
 * record visibility. Quota amounts + attainment are the host's own numbers.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const B = '/v1/host/openwop-app/territories/orgs/:org';
const M = `${B}/models/:modelId`;

export const TERRITORIES_SPECS: CommandSpec[] = [
  { cmd: ['types', 'list'], method: 'GET', route: `${B}/types`, summary: 'List territory types.', list: { key: 'types', columns: ['territoryTypeId', 'name', 'priority'], empty: 'No territory types.' } },
  { cmd: ['types', 'create'], method: 'POST', route: `${B}/types`, summary: 'Create a territory type.', body: ['name!', 'priority:number'] },
  { cmd: ['active'], method: 'GET', route: `${B}/active`, summary: 'Show the active territory model id.' },
  { cmd: ['reassign'], method: 'POST', route: `${B}/reassign`, summary: 'Re-run assignment of records over the active model.' },
  { cmd: ['models', 'list'], method: 'GET', route: `${B}/models`, summary: 'List territory models (+ the active model id).', list: { key: 'models', columns: ['modelId', 'name', 'state', 'createdAt'], empty: 'No territory models.' } },
  { cmd: ['models', 'get'], method: 'GET', route: M, summary: 'Get one territory model.' },
  { cmd: ['models', 'create'], method: 'POST', route: `${B}/models`, summary: 'Create a planning territory model.', body: ['name!'] },
  { cmd: ['models', 'delete'], method: 'DELETE', route: M, summary: 'Purge an archived territory model (+ its rules, assignments, quotas).', confirm: true },
  { cmd: ['models', 'activate'], method: 'POST', route: `${M}/activate`, summary: 'Request activation of a model (queues a review card; 202).' },
  { cmd: ['models', 'archive'], method: 'POST', route: `${M}/archive`, summary: 'Request archiving of a model (queues a review card; 202).' },
  { cmd: ['models', 'preview'], method: 'GET', route: `${M}/preview`, summary: 'Preview which territory each record would land in.' },
  { cmd: ['models', 'quotas'], method: 'GET', route: `${M}/quotas`, summary: 'List quotas in a model.', query: ['period'], list: { key: 'quotas', columns: ['quotaId', 'territoryId', 'period', 'amount', 'currency'], empty: 'No quotas.' } },
  { cmd: ['models', 'attainment'], method: 'GET', route: `${M}/attainment`, summary: 'Quota attainment for a model (viewer-scoped).', query: ['period'] },
  { cmd: ['territories', 'list'], method: 'GET', route: `${M}/territories`, summary: 'List territories in a model.', list: { key: 'territories', columns: ['territoryId', 'name', 'territoryTypeId', 'parentTerritoryId', 'managerSubjectId', 'regionId'], empty: 'No territories.' } },
  { cmd: ['territories', 'create'], method: 'POST', route: `${M}/territories`, summary: 'Create a territory in a planning model.', body: ['name!', 'territoryTypeId', 'parentTerritoryId', 'managerSubjectId', 'memberSubjectIds:list', 'regionId'] },
  { cmd: ['territories', 'update'], method: 'PATCH', route: `${M}/territories/:territoryId`, summary: 'Patch a territory.', body: ['name', 'parentTerritoryId', 'managerSubjectId', 'memberSubjectIds:list', 'regionId'] },
  { cmd: ['rules', 'list'], method: 'GET', route: `${M}/rules`, summary: 'List assignment rules in a model.', list: { key: 'rules', columns: ['ruleId', 'territoryId', 'target', 'priority'], empty: 'No assignment rules.' } },
  { cmd: ['rules', 'create'], method: 'POST', route: `${M}/rules`, summary: 'Create an assignment rule.', body: ['territoryId!', 'target!', 'filter:json', 'priority:number'] },
  { cmd: ['rules', 'delete'], method: 'DELETE', route: `${M}/rules/:ruleId`, summary: 'Delete an assignment rule.', confirm: true },
  { cmd: ['quota', 'set'], method: 'PUT', route: `${M}/territories/:territoryId/quota`, summary: 'Set (upsert) a territory quota for a period.', body: ['period!', 'amount:number!', 'currency', 'repSplits:json'] },
  { cmd: ['quota', 'clear'], method: 'DELETE', route: `${M}/territories/:territoryId/quota`, summary: 'Clear a territory quota for a period.', query: ['period!'], confirm: true },
];

export const TERRITORIES_HELP = buildGroupHelp('territories', `
Sales territories (host-extension /v1/host/openwop-app/territories/…,
org-scoped). A model holds territories, assignment rules and quotas; build it
while it is in planning, then \`models activate\` (queues a review — activation
changes who can see which records) and \`reassign\` to re-run assignment.
Rules: --target company | deal, --filter is the server's filter expression
JSON. Quotas: --period YYYY-Qn or YYYY-MM, --amount with --currency (ISO-4217;
the server refuses an amount with no currency), --rep-splits
[{"subjectId":"…","amount":n}]. \`quota set\` writes the whole quota for that
period (there is no partial update).
`, TERRITORIES_SPECS, `Examples:
  openwop territories models create --org org_1 --name "FY27 plan"
  openwop territories territories create terrmodel:1 --org org_1 --name West --region-id us-west
  openwop territories rules create terrmodel:1 --org org_1 --territory-id terr:1 --target company --filter '{"field":"state","op":"in","value":["CA","OR"]}'
  openwop territories quota set terrmodel:1 terr:1 --org org_1 --period 2026-Q4 --amount 500000 --currency USD
  openwop territories models activate terrmodel:1 --org org_1`);

export async function runTerritories(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'territories', TERRITORIES_HELP, TERRITORIES_SPECS, argv);
}

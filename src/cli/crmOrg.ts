/**
 * CRM org-scoped extension specs for `openwop crm ...` — the formal Orgs + RBAC
 * CRM surface (openwop-app ADR 0008 `docs/adr/0008-crm-full-port.md`:
 * companies / deals / pipelines / tasks / activities / custom fields / import /
 * export / pipeline report) plus booking links and e-signature requests
 * (ADR 0402 `docs/adr/0402-crm-booking-and-esign.md`), including their public
 * visitor routes (`/public-book/...`, `/public-sign/...`, sent WITHOUT auth).
 *
 * Authed routes live under `/v1/host/openwop-app/crm/orgs/:orgId` (toggle `crm`;
 * read = workspace:read, write = workspace:write). The public routes authorize
 * by slug (published booking links) or by a capability token (booking manage /
 * signer link) — possession of the token is the identity; the CLI never mints one.
 */
import type { CommandSpec } from './resourceCommands.js';

const O = '/v1/host/openwop-app/crm/orgs/:org';
const PB = '/v1/host/openwop-app/public-book';
const PS = '/v1/host/openwop-app/public-sign';

const COMPANY_FIELDS = ['domain', 'industry', 'size:number', 'revenue:number', 'tags:json', 'customFields:json'];
const DEAL_FIELDS = [
  'pipelineId', 'stageId', 'amount:number', 'currency', 'companyId', 'contactId', 'owner', 'closeDate', 'status', 'customFields:json',
];
const BOOKING_FIELDS = [
  'ownerUserId', 'description', 'status', 'weeklyHours:json', 'durations:json', 'bufferBeforeMin:number',
  'bufferAfterMin:number', 'minNoticeMin:number', 'maxAdvanceDays:number', 'videoLink', 'location', 'slug',
];

export const CRM_ORG_SPECS: CommandSpec[] = [
  // ── Pipelines ──
  { cmd: ['pipelines', 'list'], method: 'GET', route: `${O}/pipelines`, summary: 'List deal pipelines.', list: { key: 'pipelines', columns: ['pipelineId', 'name', 'stages'], empty: 'No pipelines.' } },
  { cmd: ['pipelines', 'create'], method: 'POST', route: `${O}/pipelines`, summary: 'Create a pipeline.', body: ['name!', 'stages:json'] },
  { cmd: ['pipelines', 'update'], method: 'PATCH', route: `${O}/pipelines/:pipelineId`, summary: 'Patch a pipeline (name / stages).', body: ['name', 'stages:json'] },
  { cmd: ['pipelines', 'delete'], method: 'DELETE', route: `${O}/pipelines/:pipelineId`, summary: 'Delete a pipeline.', confirm: true },

  // ── Companies ──
  { cmd: ['companies', 'list'], method: 'GET', route: `${O}/companies`, summary: 'List companies.', query: ['q'], list: { key: 'companies', columns: ['companyId', 'name', 'domain', 'industry'], empty: 'No companies.' } },
  { cmd: ['companies', 'get'], method: 'GET', route: `${O}/companies/:companyId`, summary: 'Get one company.' },
  { cmd: ['companies', 'create'], method: 'POST', route: `${O}/companies`, summary: 'Create a company.', body: ['name!', ...COMPANY_FIELDS] },
  { cmd: ['companies', 'update'], method: 'PATCH', route: `${O}/companies/:companyId`, summary: 'Patch a company.', body: ['name', ...COMPANY_FIELDS] },
  { cmd: ['companies', 'delete'], method: 'DELETE', route: `${O}/companies/:companyId`, summary: 'Delete a company.', confirm: true },
  { cmd: ['companies', 'merge'], method: 'POST', route: `${O}/companies/:companyId/merge`, summary: 'Merge a source company into this (surviving) company.', body: ['sourceCompanyId!'] },
  { cmd: ['company-merge-events', 'list'], method: 'GET', route: `${O}/company-merge-events`, summary: 'List company merge events.', list: { key: 'events', columns: ['mergeEventId', 'survivorId', 'sourceId', 'mergedAt', 'unmergedAt'], empty: 'No company merge events.' } },
  { cmd: ['company-merge-events', 'unmerge'], method: 'POST', route: `${O}/company-merge-events/:id/unmerge`, summary: 'Undo a company merge.' },
  { cmd: ['org-duplicates'], method: 'GET', route: `${O}/duplicates`, summary: 'Find duplicate records (entityType must be company).', query: ['entityType!'] },

  // ── Deals ──
  { cmd: ['deals', 'list'], method: 'GET', route: `${O}/deals`, summary: 'List deals.', query: ['pipelineId', 'stageId', 'companyId', 'q'], list: { key: 'deals', columns: ['dealId', 'title', 'stageId', 'amount', 'currency', 'status'], empty: 'No deals.' } },
  { cmd: ['deals', 'get'], method: 'GET', route: `${O}/deals/:dealId`, summary: 'Get one deal.' },
  { cmd: ['deals', 'create'], method: 'POST', route: `${O}/deals`, summary: 'Create a deal.', body: ['title!', ...DEAL_FIELDS] },
  { cmd: ['deals', 'update'], method: 'PATCH', route: `${O}/deals/:dealId`, summary: 'Patch a deal (move stage, amount, owner…).', body: ['title', ...DEAL_FIELDS] },
  { cmd: ['deals', 'delete'], method: 'DELETE', route: `${O}/deals/:dealId`, summary: 'Delete a deal.', confirm: true },
  { cmd: ['deals', 'stage-history'], method: 'GET', route: `${O}/deals/:dealId/stage-history`, summary: 'A deal\'s stage-move history.', list: { key: 'history', columns: ['fromStageId', 'toStageId', 'at', 'amountAtMove'], empty: 'No stage history.' } },
  { cmd: ['reports', 'pipeline'], method: 'GET', route: `${O}/reports/pipeline`, summary: 'Pipeline report (host-computed).', query: ['pipelineId'] },

  // ── Tasks + activities ──
  { cmd: ['tasks', 'list'], method: 'GET', route: `${O}/tasks`, summary: 'List tasks.', query: ['status', 'dealId'], list: { key: 'tasks', columns: ['taskId', 'title', 'status', 'dueDate', 'assignee'], empty: 'No tasks.' } },
  { cmd: ['tasks', 'get'], method: 'GET', route: `${O}/tasks/:taskId`, summary: 'Get one task.' },
  { cmd: ['tasks', 'create'], method: 'POST', route: `${O}/tasks`, summary: 'Create a task.', body: ['title!', 'status', 'dueDate', 'assignee', 'dealId', 'contactId', 'companyId'] },
  { cmd: ['tasks', 'update'], method: 'PATCH', route: `${O}/tasks/:taskId`, summary: 'Patch a task.', body: ['title', 'status', 'dueDate', 'assignee'] },
  { cmd: ['tasks', 'delete'], method: 'DELETE', route: `${O}/tasks/:taskId`, summary: 'Delete a task.', confirm: true },
  { cmd: ['activities', 'list'], method: 'GET', route: `${O}/activities`, summary: 'List activities.', query: ['dealId', 'contactId', 'companyId'], list: { key: 'activities', columns: ['activityId', 'kind', 'body', 'createdAt'], empty: 'No activities.' } },
  { cmd: ['activities', 'create'], method: 'POST', route: `${O}/activities`, summary: 'Log an activity.', body: ['kind!', 'body!=text', 'dealId', 'contactId', 'companyId'] },

  // ── Custom fields, import, export ──
  { cmd: ['org-fields', 'list'], method: 'GET', route: `${O}/fields`, summary: 'List org custom-field definitions.', query: ['entityType'], list: { key: 'fields', columns: ['defId', 'entityType', 'key', 'label', 'type', 'required'], empty: 'No custom fields.' } },
  { cmd: ['org-fields', 'create'], method: 'POST', route: `${O}/fields`, summary: 'Define an org custom field.', body: ['entityType!', 'key!', 'label!', 'type!', 'required:bool', 'options:json', 'refEntityType'] },
  { cmd: ['org-fields', 'delete'], method: 'DELETE', route: `${O}/fields/:defId`, summary: 'Delete an org custom-field definition.', confirm: true },
  { cmd: ['org-import'], method: 'POST', route: `${O}/import`, summary: 'Import rows (JSON, ≤1000) as companies/deals/….', body: ['entityType!', 'rows:json!', 'mapping:json', 'dedupeBy'] },
  { cmd: ['org-export'], method: 'GET', route: `${O}/export`, summary: 'Export an entity as CSV.', query: ['entityType!'], text: true },

  // ── Booking links (ADR 0402 §a) ──
  { cmd: ['booking-links', 'list'], method: 'GET', route: `${O}/booking-links`, summary: 'List booking links.', list: { key: 'bookingLinks', columns: ['bookingLinkId', 'title', 'slug', 'status', 'timezone'], empty: 'No booking links.' } },
  { cmd: ['booking-links', 'get'], method: 'GET', route: `${O}/booking-links/:bookingLinkId`, summary: 'Get one booking link.' },
  { cmd: ['booking-links', 'create'], method: 'POST', route: `${O}/booking-links`, summary: 'Create a booking link.', body: ['title!', 'timezone!', ...BOOKING_FIELDS] },
  { cmd: ['booking-links', 'update'], method: 'PATCH', route: `${O}/booking-links/:bookingLinkId`, summary: 'Patch a booking link.', body: ['title', 'timezone', ...BOOKING_FIELDS] },
  { cmd: ['booking-links', 'delete'], method: 'DELETE', route: `${O}/booking-links/:bookingLinkId`, summary: 'Delete a booking link (and its bookings).', confirm: true },
  { cmd: ['booking-links', 'bookings'], method: 'GET', route: `${O}/booking-links/:bookingLinkId/bookings`, summary: 'List bookings made on a link.', list: { key: 'bookings', columns: ['bookingId', 'status', 'slotStartUtcMs', 'durationMin', 'inviteeEmail'], empty: 'No bookings.' } },

  // ── Public booking (visitor, no auth) ──
  { cmd: ['public-book', 'page'], method: 'GET', route: `${PB}/:slug`, summary: 'Read a published booking page.', auth: false },
  { cmd: ['public-book', 'slots'], method: 'GET', route: `${PB}/:slug/slots`, summary: 'Available slots (from/to in epoch ms).', auth: false, query: ['durationMin:number!', 'from:number!', 'to:number!'] },
  { cmd: ['public-book', 'claim'], method: 'POST', route: `${PB}/:slug/claim`, summary: 'Book a slot as a visitor.', auth: false, body: ['slotStartUtcMs:number!', 'durationMin:number!', 'inviteeName!', 'inviteeEmail!', 'inviteeNote', 'idempotencyKey'] },
  { cmd: ['public-book', 'manage'], method: 'GET', route: `${PB}/manage/:token`, summary: 'View a booking by its manage token.', auth: false },
  { cmd: ['public-book', 'cancel'], method: 'POST', route: `${PB}/manage/:token/cancel`, summary: 'Cancel a booking by its manage token.', auth: false, body: ['reason'] },
  { cmd: ['public-book', 'reschedule'], method: 'POST', route: `${PB}/manage/:token/reschedule`, summary: 'Reschedule a booking by its manage token.', auth: false, body: ['slotStartUtcMs:number!'] },

  // ── E-signature (ADR 0402 §b) ──
  { cmd: ['sign-requests', 'list'], method: 'GET', route: `${O}/sign-requests`, summary: 'List signature requests.', list: { key: 'signRequests', columns: ['signRequestId', 'title', 'status', 'target'], empty: 'No signature requests.' } },
  { cmd: ['sign-requests', 'get'], method: 'GET', route: `${O}/sign-requests/:signRequestId`, summary: 'Signature-request status.' },
  { cmd: ['sign-requests', 'create'], method: 'POST', route: `${O}/sign-requests`, summary: 'Request signatures on a record.', body: ['target:json!', 'signers:json!', 'provider'] },
  { cmd: ['sign-requests', 'void'], method: 'POST', route: `${O}/sign-requests/:signRequestId/void`, summary: 'Void a signature request.', confirm: true },

  // ── Public signing (signer, no auth) ──
  { cmd: ['public-sign', 'get'], method: 'GET', route: `${PS}/:token`, summary: 'Read the document a signer token points at.', auth: false },
  { cmd: ['public-sign', 'sign'], method: 'POST', route: `${PS}/:token/sign`, summary: 'Sign (requires --acknowledged true + --typed-name).', auth: false, body: ['acknowledged:bool!', 'typedName!'] },
  { cmd: ['public-sign', 'decline'], method: 'POST', route: `${PS}/:token/decline`, summary: 'Decline to sign.', auth: false, confirm: true },
];

export const CRM_ORG_INTRO = `Org-scoped CRM (host-extension /v1/host/openwop-app/crm/orgs/<orgId>/…, pass
--org): pipelines, companies (+ merge/unmerge, duplicates with
--entity-type company), deals (+ stage history, pipeline report), tasks
(status open|doing|done), activities (kind note|call|email|meeting|webinar; the activity's \`body\` field
is given as --text, since --body is the whole-JSON-body flag),
org custom fields (entity company|deal; type string|number|boolean|date|enum|reference),
JSON import (--rows '[{…}]', or the whole body via --body-file) and CSV export
(--entity-type companies|deals|tasks|activities). Deal --amount is passed
through exactly as the host stores it.

Booking links + e-signature (ADR 0402). \`public-book\` and \`public-sign\` are
the visitor surfaces (/v1/host/openwop-app/public-book|public-sign/…) and are
sent without your API key: a published link's slug, or the capability token
from a manage/signer link. --target is {"kind":"<kind>","id":"<id>"};
--signers is [{"email":"…","name":"…","order":1}]. Signing requires
--acknowledged true (the legal notice) and --typed-name.

Examples:
  openwop crm deals list --org org_1 --pipeline-id p1
  openwop crm deals update deal_1 --org org_1 --stage-id won
  openwop crm org-export --org org_1 --entity-type deals > deals.csv
  openwop crm public-book slots my-demo --duration-min 30 --from 1790000000000 --to 1790600000000
  openwop crm public-sign sign <token> --acknowledged true --typed-name "Ada Lovelace"`;

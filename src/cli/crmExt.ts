/**
 * `openwop crm …` extensions — the tenant-scoped CRM surface beyond the basic
 * contact CRUD in crm.ts (openwop-app ADR 0008 CRM port, ADR 0209 record
 * lifecycle — duplicates/merge/convert/export, ADR 0211 saved segments,
 * ADR 0213 contact custom fields, ADR 0217/0251 suppression list, ADR 0252
 * Gmail → CRM activity sync, ADR 0263/0264 identifiers + probabilistic match +
 * reversible merge, ADR 0265 segment insights, ADR 0297 lead score).
 * Host-extension routes under `/v1/host/openwop-app/crm/*` (toggle `crm`).
 * Concatenates the org-scoped specs from crmOrg.ts.
 *
 * The host is the authority for every decision here: a merge proposal queues
 * an approval (a steward decides it), the lead score is computed host-side on
 * read, and segment membership is evaluated live by the host.
 */
import type { CommandSpec } from './resourceCommands.js';
import { CRM_ORG_SPECS, CRM_ORG_INTRO } from './crmOrg.js';

const C = '/v1/host/openwop-app/crm';

const CRM_TENANT_SPECS: CommandSpec[] = [
  // ── Contacts (beyond list/get/create/update/delete/triage) ──
  { cmd: ['contact', 'score'], method: 'GET', route: `${C}/contacts/:contactId/score`, summary: 'Explainable lead score for a contact (computed on read).', query: ['orgId'] },
  { cmd: ['contact', 'convert'], method: 'POST', route: `${C}/contacts/:id/convert`, summary: 'Convert a lead into a company + deal in an org.', body: ['orgId!', 'companyName', 'pipelineId', 'dealTitle'] },
  { cmd: ['contact', 'merge'], method: 'POST', route: `${C}/contacts/:id/merge`, summary: 'Merge a source contact into this (survivor) contact.', body: ['sourceContactId!'] },
  { cmd: ['contact', 'merge-proposal'], method: 'POST', route: `${C}/contacts/:id/merge-proposal`, summary: 'Propose a merge for steward approval (does not merge).', body: ['sourceContactId!'] },
  { cmd: ['contact', 'identifiers', 'add'], method: 'POST', route: `${C}/contacts/:id/identifiers`, summary: 'Add an external identifier to a contact.', body: ['type!', 'value!', 'source'] },
  { cmd: ['contact', 'identifiers', 'remove'], method: 'DELETE', route: `${C}/contacts/:id/identifiers`, summary: 'Remove an external identifier from a contact.', query: ['type!', 'value!'], confirm: true },

  // ── Duplicate review, match candidates, merge audit ──
  { cmd: ['duplicates'], method: 'GET', route: `${C}/duplicates?entityType=contact`, summary: 'Exact-key duplicate contact groups.' },
  { cmd: ['match-candidates'], method: 'GET', route: `${C}/match-candidates`, summary: 'Scored likely-duplicate contact pairs (proposes only).' },
  { cmd: ['merge-events', 'list'], method: 'GET', route: `${C}/merge-events`, summary: 'Contact merge audit events.', list: { key: 'events', columns: ['mergeEventId', 'survivorId', 'sourceId', 'actor', 'mergedAt', 'unmergedAt'], empty: 'No merge events.' } },
  { cmd: ['merge-events', 'unmerge'], method: 'POST', route: `${C}/merge-events/:id/unmerge`, summary: 'Reverse a contact merge.' },

  // ── Export + triage provenance ──
  { cmd: ['export'], method: 'GET', route: `${C}/export?entityType=contacts`, summary: 'Export contacts as CSV.', text: true },
  { cmd: ['runs', 'get'], method: 'GET', route: `${C}/runs/:runId`, summary: "A triage run's provenance stamp (variant + bindings)." },

  // ── Contact custom-field definitions ──
  { cmd: ['fields', 'list'], method: 'GET', route: `${C}/fields`, summary: 'List contact custom-field definitions.', list: { key: 'fields', columns: ['defId', 'key', 'label', 'type', 'required'], empty: 'No custom fields.' } },
  { cmd: ['fields', 'create'], method: 'POST', route: `${C}/fields`, summary: 'Create a contact custom-field definition.', body: ['key!', 'label!', 'type!', 'required:bool', 'options:json', 'refEntityType'] },
  { cmd: ['fields', 'delete'], method: 'DELETE', route: `${C}/fields/:defId`, summary: 'Delete a contact custom-field definition.', confirm: true },

  // ── Saved segments ──
  { cmd: ['segments', 'list'], method: 'GET', route: `${C}/segments`, summary: 'List saved segments.', list: { key: 'segments', columns: ['segmentId', 'name', 'watchEntries', 'updatedAt'], empty: 'No segments.' } },
  { cmd: ['segments', 'get'], method: 'GET', route: `${C}/segments/:segmentId`, summary: 'Get one segment.' },
  { cmd: ['segments', 'create'], method: 'POST', route: `${C}/segments`, summary: 'Create a saved segment.', body: ['name!', 'filters:json', 'watchEntries:bool'] },
  { cmd: ['segments', 'update'], method: 'PATCH', route: `${C}/segments/:segmentId`, summary: 'Patch a segment.', body: ['name', 'filters:json', 'watchEntries:bool'] },
  { cmd: ['segments', 'delete'], method: 'DELETE', route: `${C}/segments/:segmentId`, summary: 'Delete a segment.', confirm: true },
  { cmd: ['segments', 'members'], method: 'GET', route: `${C}/segments/:segmentId/members`, summary: "A segment's live membership.", list: { key: 'members', columns: ['contactId', 'name', 'email', 'stage'], empty: 'No members.' } },
  { cmd: ['segments', 'estimate'], method: 'GET', route: `${C}/segments/:segmentId/estimate`, summary: 'Audience size estimate for a segment.' },
  { cmd: ['segments', 'insights'], method: 'GET', route: `${C}/segments/:segmentId/insights`, summary: 'Audience insights for a segment.' },
  { cmd: ['segments', 'overlap'], method: 'GET', route: `${C}/segments-overlap`, summary: 'Overlap between two segments.', query: ['a!', 'b!'] },

  // ── Suppression list (do-not-contact) ──
  { cmd: ['suppressions', 'list'], method: 'GET', route: `${C}/suppressions`, summary: 'List suppressed addresses.', list: { key: 'suppressions', columns: ['email', 'reason', 'actor', 'at'], empty: 'No suppressions.' } },
  { cmd: ['suppressions', 'summary'], method: 'GET', route: `${C}/suppressions/summary`, summary: 'Suppression counts by cause (no addresses).' },
  { cmd: ['suppressions', 'add'], method: 'POST', route: `${C}/suppressions`, summary: 'Suppress an address.', body: ['email!', 'reason', 'note'] },
  { cmd: ['suppressions', 'remove'], method: 'DELETE', route: `${C}/suppressions/:email`, summary: 'Lift a suppression (--force true for bounce/complaint/unsubscribe rows).', query: ['force:bool'], confirm: true },

  // ── Gmail → CRM activity sync ──
  { cmd: ['gmail-sync', 'list'], method: 'GET', route: `${C}/gmail-sync`, summary: 'List your Gmail syncs in an org.', query: ['orgId!'], list: { key: 'syncs', columns: ['syncId', 'connectionId', 'status', 'cadence'], empty: 'No Gmail syncs.' } },
  { cmd: ['gmail-sync', 'create'], method: 'POST', route: `${C}/gmail-sync`, summary: 'Opt in: sync a Gmail connection you own into CRM activities.', body: ['orgId!', 'connectionId!', 'cadence'] },
  { cmd: ['gmail-sync', 'update'], method: 'PATCH', route: `${C}/gmail-sync/:syncId`, summary: 'Pause/resume or re-cadence a Gmail sync.', body: ['status', 'cadence'] },
  { cmd: ['gmail-sync', 'delete'], method: 'DELETE', route: `${C}/gmail-sync/:syncId`, summary: 'Opt out of a Gmail sync.', confirm: true },
  { cmd: ['gmail-sync', 'sync-now'], method: 'POST', route: `${C}/gmail-sync/:syncId/sync-now`, summary: 'Start an immediate Gmail sync run.' },
];

const CRM_TENANT_INTRO = `CRM extensions (host-extension ${C}/*). Tenant-wide: contact scoring,
conversion, merge (+ steward merge proposals and reversible unmerge),
identifiers, duplicate review, CSV export, contact custom fields, saved segments
(--filters is the host's filter JSON array), the do-not-contact suppression list
(--reason unsubscribed|bounced|complaint|manual), and Gmail activity sync (the
connection must be your own; the host refuses anyone else's).`;

export const CRM_EXT_SPECS: CommandSpec[] = [...CRM_TENANT_SPECS, ...CRM_ORG_SPECS];
export const CRM_EXT_INTRO = [CRM_TENANT_INTRO, CRM_ORG_INTRO].filter(Boolean).join('\n\n');

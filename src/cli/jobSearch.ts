import type { Ctx } from '../context.js';
/**
 * `openwop job-search ...` — the job-search vertical (ADR 0539/0540): applications
 * mapped onto a CRM pipeline, AI drafts + follow-ups, the funnel report, the
 * autopilot agent (steering + campaign queue), submission grants, public listings,
 * and the per-person answer-bank exceptions.
 *
 * Org-scoped reads need workspace:read, writes workspace:write; the whole surface
 * 404s when the `job-search` feature is off (or not entitled). Approving a draft
 * only records a decision — nothing is sent from the CLI or the host.
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const R = '/v1/host/openwop-app/job-search';
const O = `${R}/orgs/:orgId`;

export const JOB_SEARCH_ROUTES: RouteCmd[] = [
  { words: ['status'], method: 'GET', path: `${R}/status`, summary: 'Is job-search enabled here, and which modules are served.' },
  { words: ['applications'], method: 'GET', path: `${O}/applications`, summary: 'Tracked applications (CRM deals) with their stage.',
    table: { key: 'applications', columns: ['deal.dealId', 'deal.title', 'stageName', 'deal.customFields.matchScore', 'appliedAt'], empty: 'No applications.' } },
  { words: ['applications', 'add'], method: 'POST', path: `${O}/applications`,
    summary: 'Track a job as an application (eligibility + match scoring run host-side; ineligible → deal:null).',
    body: [
      { flag: '--deal-id', key: 'dealId', required: true, help: 'must start with deal:' },
      { flag: '--digest', key: 'digest', type: 'json' },
      { flag: '--candidate-profile', key: 'profile', type: 'json', help: 'sent as profile (--profile is the global config-profile flag)' },
      { flag: '--applicant', key: 'applicant', type: 'json' },
    ] },
  { words: ['applications', 'advance'], method: 'POST', path: `${O}/applications/:dealId/advance`, summary: 'Move an application to a stage (Applied | Screening | Interviewing | Offer).',
    body: [{ flag: '--stage', key: 'stage', required: true }] },
  { words: ['drafts'], method: 'GET', path: `${O}/drafts`, summary: 'Your AI drafts (interview replies, prep sheets, warm intros).',
    table: { key: 'drafts', columns: ['dealId', 'kind', 'dealTitle', 'createdAt', 'approvedAt'], empty: 'No drafts.' } },
  { words: ['drafts', 'approve'], method: 'POST', path: `${O}/drafts/:dealId/:kind/approve`, summary: 'Approve a draft (<kind>: interview-reply | prep-sheet | warm-intro). Records the decision only.' },
  { words: ['follow-ups'], method: 'GET', path: `${O}/follow-ups`, summary: 'Your follow-ups that are due now.',
    table: { key: 'followUps', columns: ['dealId', 'stage', 'dealTitle', 'dueAt'], empty: 'No follow-ups due.' } },
  { words: ['follow-ups', 'complete'], method: 'POST', path: `${O}/follow-ups/:dealId/:stage/complete`, summary: 'Mark a follow-up done.' },
  { words: ['funnel'], method: 'GET', path: `${O}/funnel`, summary: 'The funnel report (stage reach, response + conversion rates, warm vs cold).' },
  { words: ['funnel-bundle'], method: 'GET', path: `${O}/funnel-bundle`, summary: 'Funnel report + due follow-ups + drafts in one read.' },
  { words: ['steering'], method: 'GET', path: `${O}/agent/steering`, summary: 'The autopilot agent\'s goals + targeting policy.' },
  { words: ['steering', 'set'], method: 'PUT', path: `${O}/agent/steering`, rmw: { pick: (b: any) => ({ goals: b?.goals, policy: b?.policy }) },
    summary: 'Edit steering. Read-modify-write: the host replaces the whole policy, so the CLI starts from the current one and overlays your flags.',
    body: [
      { flag: '--goals', key: 'goals' },
      { flag: '--roles', key: 'policy.roles', type: 'csv' },
      { flag: '--locations', key: 'policy.locations', type: 'csv' },
      { flag: '--remote', key: 'policy.remote', type: 'boolean' },
      { flag: '--min-match-score', key: 'policy.minMatchScore', type: 'number' },
      { flag: '--daily-cap', key: 'policy.dailyCap', type: 'number' },
      { flag: '--rate-per-hour', key: 'policy.ratePerHour', type: 'number' },
      { flag: '--tiers', key: 'policy.tiers', type: 'csv' },
    ] },
  { words: ['agent', 'provision'], method: 'POST', path: `${O}/agent/provision`, summary: 'Provision the job-search agent + its board (idempotent).' },
  { words: ['agent', 'queue-campaign'], method: 'POST', path: `${O}/agent/queue-campaign`, summary: 'Queue a campaign card for the agent (needs a live grant; queues only, nothing runs now).' },
  { words: ['grants'], method: 'GET', path: `${O}/grants`, summary: 'Submission grants (bounded authority for the agent to apply).',
    table: { key: 'grants', columns: ['grantId', 'campaignId', 'submitsUsed', 'maxSubmits', 'expiresAt', 'revokedAt'], empty: 'No grants.' } },
  { words: ['grants', 'create'], method: 'POST', path: `${O}/grants`, summary: 'Grant bounded submission authority (grantedBy is always you).',
    body: [
      { flag: '--campaign-id', key: 'campaignId', required: true },
      { flag: '--origins', key: 'origins', type: 'csv', required: true },
      { flag: '--expires-at', key: 'expiresAt', required: true },
      { flag: '--max-submits', key: 'maxSubmits', type: 'number', required: true },
      { flag: '--max-prepared', key: 'maxPrepared', type: 'number', required: true },
      { flag: '--rate-per-hour', key: 'ratePerHour', type: 'number', required: true },
      { flag: '--subject-id', key: 'subjectId' },
      { flag: '--tiers', key: 'tiers', type: 'csv' },
      { flag: '--resume-policy', key: 'resumePolicy' },
    ] },
  { words: ['grants', 'revoke'], method: 'DELETE', path: `${O}/grants/:grantId`, summary: 'Revoke a grant immediately.' },
  { words: ['listings'], method: 'GET', path: `${O}/listings`, summary: 'Captured job listings.',
    table: { key: 'listings', columns: ['listingId', 'title', 'companyName', 'location', 'remote', 'sourceBoard'], empty: 'No listings.' } },
  { words: ['listings', 'visibility'], method: 'GET', path: `${O}/listings/visibility`, summary: 'Whether the listings page is public.' },
  { words: ['listings', 'set-visibility'], method: 'PUT', path: `${O}/listings/visibility`, summary: 'Publish (--public) or unpublish (--no-public) the listings page.',
    body: [{ flag: '--public', key: 'public', type: 'boolean', required: true }] },
  { words: ['exceptions'], method: 'GET', path: `${R}/me/exceptions`, summary: 'Application questions the autopilot could not answer for you.',
    table: { key: 'exceptions', columns: ['questionKey', 'blockedCount', 'reason', 'questionText'], empty: 'No exceptions.' } },
  { words: ['answers'], method: 'GET', path: `${R}/me/answers`, summary: 'Your answer bank: the standard questions, your answers, and your coverage.',
    table: { key: 'answers', columns: ['questionKey', 'value', 'source', 'confirmedAt', 'usageCount'], empty: 'No saved answers.' } },
  { words: ['answers', 'set'], method: 'PUT', path: `${R}/me/answers`, summary: 'Save an answer (a special-category question is refused with 422 and its reason).',
    body: [
      { flag: '--question-text', key: 'questionText', required: true },
      { flag: '--value', key: 'value', required: true },
      { flag: '--source', key: 'source', help: 'user (default) | inferred | profile' },
      { flag: '--confirmed', key: 'confirmed', type: 'boolean', help: '--no-confirmed saves it unconfirmed' },
    ] },
  { words: ['exceptions', 'answer'], method: 'POST', path: `${R}/me/exceptions`, summary: 'Answer one (saved to your answer bank as confirmed).',
    body: [{ flag: '--question-text', key: 'questionText', required: true }, { flag: '--value', key: 'value', required: true }] },
];

export const JOB_SEARCH_HELP = `Usage:
${routesHelp('job-search', JOB_SEARCH_ROUTES)}
Job search (ADR 0539). Everything under <orgId> is scoped to that org; drafts,
follow-ups and exceptions are YOUR OWN. The host gates every write and every
submission; the CLI only relays.

Exit codes: 0 ok · 1 server error · 2 usage / not found (incl. feature off) / validation / conflict · 4 not signed in or not permitted.

Examples:
  openwop job-search status
  openwop job-search applications org_1
  openwop job-search applications advance org_1 deal:abc --stage Interviewing
  openwop job-search steering set org_1 --roles "Staff Engineer,Principal Engineer" --remote --daily-cap 5
  openwop job-search grants create org_1 --campaign-id c1 --origins https://jobs.example.com --expires-at 2026-12-31T00:00:00Z --max-submits 10 --max-prepared 20 --rate-per-hour 2
  openwop job-search listings set-visibility org_1 --public
`;

export async function runJobSearch(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'job-search', JOB_SEARCH_HELP, JOB_SEARCH_ROUTES, argv);
}

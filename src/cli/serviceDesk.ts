import type { Ctx } from '../context.js';
/**
 * `openwop service-desk ...` — help-desk tickets + the public intake widget
 * (ADR 0422). Org-scoped ticket CRUD (workspace:read / workspace:write), the
 * org's intake config (host:members:manage), and the anonymous `public` visitor
 * surface an operator can use to test their widget end-to-end.
 *
 * The `public` subcommands send NO bearer — they are exactly what an anonymous
 * website visitor sends. Every failure there is a uniform 404 by design (bad
 * intake key, feature off, bad visitor token).
 */
import { routesHelp, runRouteGroup, type RouteCmd } from './routeKit.js';

const B = '/v1/host/openwop-app/service-desk/orgs/:orgId';
const P = '/v1/host/openwop-app/public-service-desk/:intakeKey';

export const SERVICE_DESK_ROUTES: RouteCmd[] = [
  { words: ['tickets'], method: 'GET', path: `${B}/tickets`, summary: 'List tickets (newest first).',
    query: [{ flag: '--status', key: 'status', help: 'open | pending | waiting_on_customer | solved | closed' }],
    table: { key: 'tickets', columns: ['ticketId', 'status', 'priority', 'channel', 'assigneeMemberId', 'subject', 'updatedAt'], empty: 'No tickets.' } },
  { words: ['tickets', 'get'], method: 'GET', path: `${B}/tickets/:ticketId`, summary: 'One ticket with its message thread.' },
  { words: ['tickets', 'create'], method: 'POST', path: `${B}/tickets`, summary: 'Open a ticket (channel defaults to manual, priority to normal; a first message is an internal note).',
    body: [
      { flag: '--subject', key: 'subject', required: true },
      { flag: '--channel', key: 'channel' },
      { flag: '--priority', key: 'priority' },
      { flag: '--contact-id', key: 'contactId' },
      { flag: '--first-message', key: 'firstMessage.body' },
    ] },
  { words: ['tickets', 'assign'], method: 'POST', path: `${B}/tickets/:ticketId/assign`, summary: 'Assign a ticket (omit --assignee-member-id to unassign).',
    body: [{ flag: '--assignee-member-id', key: 'assigneeMemberId' }] },
  { words: ['tickets', 'message'], method: 'POST', path: `${B}/tickets/:ticketId/messages`, summary: 'Add a message: --direction outbound replies to the customer; anything else is an internal note.',
    body: [{ flag: '--text', key: 'body', required: true }, { flag: '--direction', key: 'direction' }, { flag: '--message-id', key: 'messageId' }] },
  { words: ['tickets', 'status'], method: 'POST', path: `${B}/tickets/:ticketId/status`, summary: 'Set a ticket\'s status.',
    body: [{ flag: '--status', key: 'status', required: true }] },
  { words: ['intake-config'], method: 'GET', path: `${B}/intake-config`, summary: 'The org\'s intake config (incl. its public intake key).' },
  { words: ['intake-config', 'rotate'], method: 'PUT', path: `${B}/intake-config`, confirm: true,
    summary: 'Replace the intake config: binds this org as the default and mints a NEW public intake key (the old key stops working).' },
  { words: ['public', 'send'], method: 'POST', path: `${P}/messages`, anonymous: true,
    summary: 'As an anonymous visitor: send a widget message (opens a ticket, or continues it with --visitor-token). Save the returned visitorToken.',
    body: [{ flag: '--text', key: 'body', required: true }, { flag: '--visitor-token', key: 'visitorToken' }] },
  { words: ['public', 'thread'], method: 'GET', path: `${P}/thread`, anonymous: true,
    summary: 'As an anonymous visitor: read your ticket thread (internal notes are never shown).',
    query: [{ flag: '--token', key: 'token', required: true }] },
];

export const SERVICE_DESK_HELP = `Usage:
${routesHelp('service-desk', SERVICE_DESK_ROUTES)}
Service desk (ADR 0422). Ticket reads need workspace:read in <orgId>, writes need
workspace:write; \`intake-config rotate\` needs member-management rights. The
\`public\` commands are the anonymous widget path (no bearer is sent).

Exit codes: 0 ok · 1 server error · 2 usage / not found / validation / conflict · 4 not signed in or not permitted.

Examples:
  openwop service-desk tickets org_1 --status open
  openwop service-desk tickets create org_1 --subject "Login broken" --priority high
  openwop service-desk tickets message org_1 tk_9 --text "On it" --direction outbound
  openwop service-desk intake-config org_1 --json
  openwop service-desk public send sdk_0123... --text "Hi, I need help"
  openwop service-desk public thread sdk_0123... --token sdv1....
`;

export async function runServiceDesk(ctx: Ctx, argv: string[]) {
  return runRouteGroup(ctx, 'service-desk', SERVICE_DESK_HELP, SERVICE_DESK_ROUTES, argv);
}

import type { Ctx } from '../context.js';
/**
 * `openwop dealers ...` — the dealer network / partner-relationship surface
 * (openwop-app ADR 0281, dealer-network PRM). Host-extension routes under
 * `/v1/host/openwop-app/dealers/orgs/:orgId/*` (toggle `dealers`; reads need
 * workspace:read, dealer/outlet admin workspace:write) plus the PUBLIC partner
 * portal `/v1/host/openwop-app/partner/:token` (no auth — the token is the
 * credential). Deal-registration DECISIONS go through the shared reviews inbox,
 * not a dealers route — the CLI only lists registrations.
 */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const B = '/v1/host/openwop-app/dealers/orgs/:org';
const P = '/v1/host/openwop-app/partner/:token';

export const DEALERS_SPECS: CommandSpec[] = [
  { cmd: ['list'], method: 'GET', route: `${B}/dealers`, summary: 'List dealers.', query: ['territoryId', 'status'], list: { key: 'dealers', columns: ['dealerId', 'name', 'tier', 'status', 'companyId', 'territoryId'], empty: 'No dealers.' } },
  { cmd: ['get'], method: 'GET', route: `${B}/dealers/:dealerId`, summary: 'Get one dealer.' },
  { cmd: ['create'], method: 'POST', route: `${B}/dealers`, summary: 'Create a dealer (references a CRM company).', body: ['companyId!', 'name!', 'tier', 'status', 'territoryId'] },
  { cmd: ['update'], method: 'PATCH', route: `${B}/dealers/:dealerId`, summary: 'Patch a dealer.', body: ['name', 'tier', 'status', 'territoryId'] },
  { cmd: ['delete'], method: 'DELETE', route: `${B}/dealers/:dealerId`, summary: 'Delete a dealer (+ its outlets, registrations, portal tokens).', confirm: true },
  { cmd: ['portal-token'], method: 'POST', route: `${B}/dealers/:dealerId/portal-token`, summary: 'Mint/rotate the dealer\'s partner-portal link.', notice: 'Note: the partner-portal token below is a bearer credential shown once — share it only with the dealer; minting again rotates it.' },
  { cmd: ['outlets', 'list'], method: 'GET', route: `${B}/outlets`, summary: 'List outlets (optionally one dealer\'s).', query: ['dealerId'], list: { key: 'outlets', columns: ['outletId', 'dealerId', 'name', 'status', 'address'], empty: 'No outlets.' } },
  { cmd: ['outlets', 'for-dealer'], method: 'GET', route: `${B}/dealers/:dealerId/outlets`, summary: 'List one dealer\'s outlets (404 if the dealer is unknown).', list: { key: 'outlets', columns: ['outletId', 'name', 'status', 'address'], empty: 'No outlets.' } },
  { cmd: ['outlets', 'get'], method: 'GET', route: `${B}/outlets/:outletId`, summary: 'Get one outlet.' },
  { cmd: ['outlets', 'create'], method: 'POST', route: `${B}/dealers/:dealerId/outlets`, summary: 'Create an outlet under a dealer.', body: ['name!', 'status', 'address', 'lat:number', 'lng:number'] },
  { cmd: ['outlets', 'update'], method: 'PATCH', route: `${B}/outlets/:outletId`, summary: 'Patch an outlet.', body: ['name', 'status', 'address', 'lat:number', 'lng:number'] },
  { cmd: ['outlets', 'delete'], method: 'DELETE', route: `${B}/outlets/:outletId`, summary: 'Delete an outlet.', confirm: true },
  { cmd: ['registrations'], method: 'GET', route: `${B}/registrations`, summary: 'List deal registrations (decide them in the reviews inbox).', query: ['dealerId', 'status'], list: { key: 'registrations', columns: ['regId', 'dealerId', 'dealTitle', 'companyName', 'status', 'at'], empty: 'No registrations.' } },
  { cmd: ['partner', 'get'], method: 'GET', route: P, auth: false, summary: 'Read the partner-portal view for a portal token.' },
  { cmd: ['partner', 'register'], method: 'POST', route: `${P}/register`, auth: false, summary: 'Register a deal through the partner portal.', body: ['dealTitle!', 'companyName!'] },
];

export const DEALERS_HELP = buildGroupHelp('dealers', `
Dealer network (host-extension /v1/host/openwop-app/dealers/…, org-scoped). A
dealer references a CRM company (--company-id); --status is active | suspended
for dealers and active | closed for outlets. \`portal-token\` mints the dealer's
partner-portal link (a bearer credential, shown once). \`partner get|register\`
drive the PUBLIC portal (/v1/host/openwop-app/partner/<token>, no auth) exactly
as a dealer would. Registrations are approved/rejected in the reviews inbox.
`, DEALERS_SPECS, `Examples:
  openwop dealers list --org org_1 --status active
  openwop dealers create --org org_1 --company-id company:abc --name "Acme Motors" --tier gold
  openwop dealers outlets create dealer:123 --org org_1 --name "Downtown" --lat 40.7 --lng=-74.0
  openwop dealers portal-token dealer:123 --org org_1
  openwop dealers partner register <token> --deal-title "Fleet renewal" --company-name "Globex"`);

export async function runDealers(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, 'dealers', DEALERS_HELP, DEALERS_SPECS, argv);
}

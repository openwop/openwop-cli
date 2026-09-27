import type { Ctx } from '../context.js';
/**
 * `openwop capability-firewall ...` — the capability firewall (ADR 0135; the
 * `allow` verdict + deny modes are ADR 0397): composition rules the host checks
 * before an agent combines capabilities (e.g. "reads secrets" WITH "sends out").
 *
 *   GET|PUT /v1/host/openwop-app/capability-firewall/orgs/{orgId}/rules
 *   GET     /v1/host/openwop-app/capability-firewall/orgs/{orgId}/decisions[?limit]
 *   POST    /v1/host/openwop-app/capability-firewall/orgs/{orgId}/simulate
 *   GET|PUT /v1/host/openwop-app/capability-firewall/platform/rules   (super-admin)
 *
 * The rule set is tenant-wide policy. The host evaluates every rule and every
 * simulation; the CLI never computes a verdict — `simulate` prints the host's.
 */
import { CliError, HttpError } from '../errors.js';
import { gateAdvice } from './adminShared.js';
import { buildGroupHelp, runResourceGroup, type CommandSpec } from './resourceCommands.js';

const O = '/v1/host/openwop-app/capability-firewall/orgs/:org';
const PLATFORM = '/v1/host/openwop-app/capability-firewall/platform/rules';

export const CAPABILITY_FIREWALL_SPECS: CommandSpec[] = [
  { cmd: ['rules'], method: 'GET', route: `${O}/rules`, summary: 'The rule set, unknown-tool policy, mode (default-allow | shadow | enforce) and default-deny verdict.' },
  { cmd: ['rules', 'set'], method: 'PUT', route: `${O}/rules`, rmw: `${O}/rules`,
    body: ['rules:json', 'mode', 'unknownToolPolicy', 'defaultDenyVerdict'],
    summary: 'Replace settings (org admin). Read-modify-write: fields you do not pass keep their current value; --rules (or --body-file) replaces the whole rule list.' },
  { cmd: ['decisions'], method: 'GET', route: `${O}/decisions`, query: ['limit:number'], summary: 'Recent firewall decisions (host default 100, max 500).',
    list: { key: 'decisions', columns: ['timestamp', 'decision', 'toolName', 'ruleId', 'reason'], empty: 'No firewall decisions.' } },
  { cmd: ['simulate'], method: 'POST', route: `${O}/simulate`, body: ['next:json!', 'seen:json', 'modeOverride', 'context:json'],
    summary: 'Ask the host what it would decide for a next action after the actions already seen (read-only).' },
  { cmd: ['platform', 'rules'], method: 'GET', route: PLATFORM, summary: 'The platform baseline rules every tenant inherits (super-admin).' },
  { cmd: ['platform', 'rules', 'set'], method: 'PUT', route: PLATFORM, body: ['rules:json!'], summary: 'Replace the platform baseline rules (super-admin).' },
];

export const CAPABILITY_FIREWALL_HELP = buildGroupHelp('capability-firewall', `
Capability firewall (host-extension, ADR 0135). A rule is
  {"id","description","when":{"anyOf"|"with"|"countAtLeast"|"expression"},"verdict":"deny"|"require-approval"|"allow","reason"}
and a simulated action is {"toolName":"…"} or a capability class
({"safetyTier":"pure|read|write|exec"}, {"egress":"none|safe-fetch|host-mediated|host-owned"},
{"scope":"…"} or {"kind":"fan-out"}). The rules are tenant-wide even though the path
names an org. The host is the authority: the CLI relays rules and prints the host's
verdicts, never its own.`, CAPABILITY_FIREWALL_SPECS, `
Examples:
  openwop capability-firewall rules --org org_1
  openwop capability-firewall rules set --org org_1 --mode shadow
  openwop capability-firewall rules set --org org_1 --body-file rules.json
  openwop capability-firewall simulate --org org_1 --next '{"egress":"safe-fetch"}' --seen '[{"safetyTier":"read"}]'
  openwop capability-firewall decisions --org org_1 --limit 20
`);

export async function runCapabilityFirewall(ctx: Ctx, argv: string[]): Promise<number> {
  try {
    return await runResourceGroup(ctx, 'capability-firewall', CAPABILITY_FIREWALL_HELP, CAPABILITY_FIREWALL_SPECS, argv);
  } catch (err) {
    if (argv[0] === 'platform' && err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new CliError(gateAdvice('superadmin', 'The capability-firewall platform baseline'), 4);
    }
    throw err;
  }
}

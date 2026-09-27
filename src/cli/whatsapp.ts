import type { Ctx } from '../context.js';
/**
 * `openwop whatsapp …` — WhatsApp Business connection health + the no-training
 * compliance attestation (openwop-app WhatsApp feature).
 *
 * Org-scoped host extension, gated on the `whatsapp` feature toggle:
 *   GET    /v1/host/openwop-app/whatsapp/orgs/{orgId}/health?connectionId=…   (workspace read)
 *   GET    /v1/host/openwop-app/whatsapp/orgs/{orgId}/attestation             (workspace read)
 *   PUT    /v1/host/openwop-app/whatsapp/orgs/{orgId}/attestation             (WhatsApp manager)
 *   DELETE /v1/host/openwop-app/whatsapp/orgs/{orgId}/attestation             (WhatsApp manager)
 * The attestation records that no AI provider used with WhatsApp data trains
 * on it; the host requires an explicit confirmation to record it.
 *
 * Distinct from `openwop relay` (a local device relay for a personal WhatsApp
 * account) — this is the server's business WhatsApp connection.
 */
import { CliError } from '../errors.js';
import { write, writeLine } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';
import { requireOrg } from './shared.js';
import { enc, emit, writeFields } from './chatShared.js';

export const WHATSAPP_HELP = `Usage:
  openwop whatsapp health --org <orgId> --connection <connectionId> [--json]
  openwop whatsapp attestation get --org <orgId> [--json]
  openwop whatsapp attestation set --org <orgId> --confirm-no-training [--json]
  openwop whatsapp attestation revoke --org <orgId> --yes

The server's WhatsApp Business connection (/v1/host/openwop-app/whatsapp/orgs/{orgId}/*):
'health' reads the connection's health; 'attestation' reads, records, or revokes
the workspace's attestation that no AI provider used with WhatsApp data trains
on it (recording needs --confirm-no-training and WhatsApp-manager access).

Exit codes: 0 ok, 2 usage / not found / feature off, 4 not permitted.

Examples:
  openwop whatsapp health --org org_1 --connection conn_wa_1
  openwop whatsapp attestation set --org org_1 --confirm-no-training
`;

export async function runWhatsapp(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { write(ctx.io.stdout, WHATSAPP_HELP); return sub ? 0 : 2; }
  const action = sub === 'attestation' ? (argv[1] ?? 'get') : undefined;
  const rest = argv.slice(sub === 'attestation' ? 2 : 1);
  const { options } = parseOptions(rest, { bool: ['--help', '--confirm-no-training', '--yes'], value: ['--org', '--connection'] });
  if (options.help) { write(ctx.io.stdout, WHATSAPP_HELP); return 0; }
  const base = `/v1/host/openwop-app/whatsapp/orgs/${enc(requireOrg(options.org))}`;
  if (sub === 'health') {
    if (!options.connection) throw new CliError('whatsapp health requires --connection <connectionId>.', 2);
    const res = await requestJson(ctx, `${base}/health?connectionId=${enc(options.connection)}`);
    return emit(ctx, res.body, () => writeLine(ctx.io.stdout, JSON.stringify(res.body, null, 2)));
  }
  if (sub === 'attestation') {
    const path = `${base}/attestation`;
    switch (action) {
      case 'get': {
        const res = await requestJson(ctx, path);
        return emit(ctx, res.body, () => writeFields(ctx, [['attested', res.body?.attested ? 'yes' : 'no'], ['attestedBy', res.body?.attestedBy], ['attestedAt', res.body?.attestedAt]]));
      }
      case 'set': {
        if (!options.confirmNoTraining) {
          throw new CliError('Pass --confirm-no-training to attest that no AI provider used with WhatsApp data trains on it (zero retention / training disabled).', 2);
        }
        const res = await requestJson(ctx, path, { method: 'PUT', body: { confirmNoTraining: true } });
        return emit(ctx, res.body, () => writeLine(ctx.io.stdout, `Attestation recorded by ${res.body?.attestedBy ?? 'you'} at ${res.body?.attestedAt ?? ''}.`));
      }
      case 'revoke': case 'delete': {
        if (!options.yes) { writeLine(ctx.io.stderr, 'Refusing to revoke the WhatsApp attestation without --yes.'); return 2; }
        await requestJson(ctx, path, { method: 'DELETE' });
        writeLine(ctx.io.stdout, 'Attestation revoked.');
        return 0;
      }
      default:
        throw new CliError(`Unknown whatsapp attestation command: ${action}\nRun \`openwop whatsapp --help\` for usage.`, 2);
    }
  }
  throw new CliError(`Unknown whatsapp command: ${sub}\nRun \`openwop whatsapp --help\` for usage.`, 2);
}

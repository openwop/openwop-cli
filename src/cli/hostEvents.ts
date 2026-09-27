import type { Ctx } from '../context.js';
/**
 * `openwop host-events ...` — bind host-extension events to workflows
 * (openwop-app ADR 0208 §1, the run-less host-event dispatcher).
 *
 * A binding maps a host-extension event type (`host.crm.contact.created`, …)
 * to a workflow so a record change starts a run. Host-extension surface
 * (non-normative), deliberately NOT the RFC 0099 `/v1/trigger-subscriptions`
 * surface (see `openwop triggers`):
 *   GET    /v1/host/openwop-app/host-events/bindings
 *   POST   /v1/host/openwop-app/host-events/bindings            { eventType, workflowId }
 *   PATCH  /v1/host/openwop-app/host-events/bindings/{bindingId} { enabled }
 *   DELETE /v1/host/openwop-app/host-events/bindings/{bindingId}
 */
import { CliError } from '../errors.js';
import { write, writeLine, writeJson, formatTable } from '../io.js';
import { parseOptions } from '../options.js';
import { requestJson } from '../api.js';

const BASE = '/v1/host/openwop-app/host-events/bindings';

export const HOST_EVENTS_HELP = `Usage:
  openwop host-events list [--json]
  openwop host-events bind --event <host.…> --workflow <workflowId> [--json]
  openwop host-events enable <bindingId> [--json]
  openwop host-events disable <bindingId> [--json]
  openwop host-events unbind <bindingId> [--yes]

Host-event bindings (ADR 0208). Bind a host-extension event type (a name that
starts with "host.", e.g. host.crm.contact.created) to a workflow so the event
starts a run. This is NOT the protocol trigger-subscription surface — use
\`openwop triggers\` for RFC 0099 subscriptions.

  list     GET    /v1/host/openwop-app/host-events/bindings
  bind     POST   /v1/host/openwop-app/host-events/bindings   { eventType, workflowId }
  enable   PATCH  /v1/host/openwop-app/host-events/bindings/{id}   { enabled: true }
  disable  PATCH  /v1/host/openwop-app/host-events/bindings/{id}   { enabled: false }
  unbind   DELETE /v1/host/openwop-app/host-events/bindings/{id}

The server refuses a non-"host." event name (400), an unknown workflow (422),
and a tenant past its binding cap (409).

Examples:
  openwop host-events bind --event host.crm.contact.created --workflow wf.onboard
  openwop host-events disable hb_123
  openwop host-events unbind hb_123 --yes
`;

export async function runHostEvents(ctx: Ctx, argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'list';
  if (sub === '--help' || sub === '-h') { write(ctx.io.stdout, HOST_EVENTS_HELP); return 0; }
  const { options, positionals } = parseOptions(argv.slice(['list', 'bind', 'enable', 'disable', 'unbind'].includes(sub) ? 1 : 0), {
    bool: ['--help', '--yes'],
    value: ['--event', '--workflow'],
  });
  if (options.help) { write(ctx.io.stdout, HOST_EVENTS_HELP); return 0; }
  switch (sub) {
    case 'list': {
      const res = await requestJson(ctx, BASE);
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      const items = Array.isArray(res.body?.bindings) ? res.body.bindings : [];
      if (items.length === 0) { writeLine(ctx.io.stdout, 'No host-event bindings.'); return 0; }
      writeLine(ctx.io.stdout, formatTable(items.map((b: any) => ({
        bindingId: b.bindingId ?? b.id ?? '',
        eventType: b.eventType ?? '',
        workflowId: b.workflowId ?? '',
        enabled: b.enabled === false ? 'no' : 'yes',
      })), ['bindingId', 'eventType', 'workflowId', 'enabled']));
      return 0;
    }
    case 'bind': {
      if (!options.event || !options.workflow) throw new CliError('bind needs --event <host.…> and --workflow <workflowId>.', 2);
      if (!String(options.event).startsWith('host.')) throw new CliError('--event must be a host-extension event name starting with "host.".', 2);
      const res = await requestJson(ctx, BASE, { method: 'POST', body: { eventType: options.event, workflowId: options.workflow } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `Bound ${options.event} → ${options.workflow} (binding ${res.body?.bindingId ?? res.body?.id ?? ''}).`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      if (positionals.length !== 1) throw new CliError(`Usage: openwop host-events ${sub} <bindingId> [--json]`, 2);
      const res = await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'PATCH', body: { enabled: sub === 'enable' } });
      if (ctx.json) { writeJson(ctx.io.stdout, res.body); return 0; }
      writeLine(ctx.io.stdout, `${sub === 'enable' ? 'Enabled' : 'Disabled'} binding ${positionals[0]}.`);
      return 0;
    }
    case 'unbind': {
      if (positionals.length !== 1) throw new CliError('Usage: openwop host-events unbind <bindingId> [--yes]', 2);
      if (!options.yes) { writeLine(ctx.io.stderr, `Refusing to delete binding ${positionals[0]} without --yes.`); return 2; }
      await requestJson(ctx, `${BASE}/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      writeLine(ctx.io.stdout, `Deleted binding ${positionals[0]}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown host-events command: ${sub}\nRun \`openwop host-events --help\` for usage.`);
  }
}

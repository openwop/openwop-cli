/**
 * v1 → v2 run-event type names — `spec/v2/core/events.md` §Types, generated
 * from `spec/v2/event-codemap.json` (corpus tag `v2.42.6`).
 *
 * v2 renamed 36 of the 118 registered types to the `domain.verb-ed` kebab
 * grammar (`run.resuming` → `run.resume-started`, `agent.toolCalled` →
 * `agent.tool-called`, …); the other 82 keep their v1 name. The CLI renders
 * events from either major, and a host inside the overlap can serve an era-2
 * (v1-written) log, so every consumer here folds a type through
 * `canonicalEventType` before deciding anything on it.
 *
 * Only the RENAMED rows are embedded (an identity row carries no information).
 * `test/event-codemap.test.mjs` checks this table against the checked-in copy
 * `test/fixtures/event-codemap.json`, and `scripts/sync-event-codemap.mjs`
 * refreshes that copy from a corpus checkout (`--check` to detect drift) — so a
 * corpus rename cannot land without this table failing a test.
 */
export const V1_TO_V2_EVENT_TYPES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ['run.resuming', 'run.resume-started'],
  ['run.dead_lettered', 'run.dead-lettered'],
  ['replay.divergedAtRefusal', 'replay.diverged-at-refusal'],
  ['agent.reasoning.delta', 'agent.reasoning-delta'],
  ['agent.promptResolved', 'agent.prompt-resolved'],
  ['model.capability.substituted', 'model.capability-substituted'],
  ['model.capability.insufficient', 'model.capability-insufficient'],
  ['envelope.retry.attempted', 'envelope.retry-attempted'],
  ['envelope.retry.exhausted', 'envelope.retry-exhausted'],
  ['envelope.nlToFormat.engaged', 'envelope.nl-to-format-engaged'],
  ['envelope.recovery.applied', 'envelope.recovery-applied'],
  ['agent.toolCalled', 'agent.tool-called'],
  ['agent.toolReturned', 'agent.tool-returned'],
  ['agent.invocation.started', 'agent.invocation-started'],
  ['agent.invocation.completed', 'agent.invocation-completed'],
  ['deployment.canary.adjusted', 'deployment.canary-adjusted'],
  ['deployment.state.changed', 'deployment.state-changed'],
  ['roster.run.initiated', 'roster.run-initiated'],
  ['tool.session.opened', 'tool.session-opened'],
  ['tool.session.closed', 'tool.session-closed'],
  ['trigger.subscription.state.changed', 'trigger.subscription-state-changed'],
  ['trigger.delivery.attempted', 'trigger.delivery-attempted'],
  ['budget.threshold.crossed', 'budget.threshold-crossed'],
  ['runOrchestrator.decided', 'orchestrator.decided'],
  ['core.dispatch.fanOut', 'dispatch.fanned-out'],
  ['core.dispatch.join', 'dispatch.joined'],
  ['agent.memory.consolidated', 'agent.memory-consolidated'],
  ['core.workflowChain.event', 'workflow-chain.event'],
  ['core.workflowChain.confidence-escalated', 'workflow-chain.confidence-escalated'],
  ['connector.auth_expired', 'connector.auth-expired'],
  ['voice.speech_start', 'voice.speech-start'],
  ['voice.endpoint_candidate', 'voice.endpoint-candidate'],
  ['voice.turn_commit', 'voice.turn-commit'],
  ['voice.synthesis_chunk', 'voice.synthesis-chunk'],
  ['voice.barge_in', 'voice.barge-in'],
  ['compensation.manual_intervention_required', 'compensation.manual-intervention-required']

]));

/** The v2 name for a run-event type; a v2 name, an unrenamed v1 name, or a vendor type passes through. */
export function canonicalEventType(type: unknown): string {
  const t = typeof type === 'string' ? type : String(type ?? 'event');
  return V1_TO_V2_EVENT_TYPES[t] ?? t;
}

/**
 * The run's terminal events (events.md §The terminal event — exactly one per
 * log). Same names under both majors; kept as a set of canonical names so a
 * caller checks `TERMINAL_RUN_EVENT_TYPES.has(canonicalEventType(t))`.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** True when an event record is the run's terminal event, whichever major named it. */
export function isTerminalRunEvent(ev: unknown): boolean {
  return !!ev && typeof ev === 'object' && TERMINAL_RUN_EVENT_TYPES.has(canonicalEventType((ev as { type?: unknown }).type));
}

# FEATURES.md — @openwop/cli

The catalog of **command groups** in this CLI, and how the **capability-gating**
system that fronts them works. Each command group is a self-contained module
(`src/cli/<group>.ts`) that drives one protocol surface a host exposes — it plugs
into the dispatcher and degrades gracefully when the target host doesn't advertise
the capability it needs.

> **Companion docs:** [`ARCHITECTURE.md`](ARCHITECTURE.md) is the *shape* (layers,
> seams, boundary discipline); this file is the *what* (the surfaces the CLI can
> drive). [`README.md`](README.md) is the end-user guide. The design/scoping
> workflow for surfacing a **new** capability is the `/feature` skill; the
> implement-and-verify loop is `/update-cli`.
>
> The CLI is a **host-agnostic control plane**: it must work against *any*
> OpenWOP-conformant host, not just the reference app. The contract is what
> `/.well-known/openwop` advertises + what `api/openapi.yaml` (in `openwop/openwop`)
> defines — never a host's private internals.

---

## How the capability-gating system works

The CLI has no per-tenant toggle system of its own (that lives in the *host*).
Its analog is **capability-gating**: the host declares which optional surfaces it
serves, and each command group probes for its surface and either drives it or
fails closed with a clear message.

### The host advertises; the CLI gates

`/.well-known/openwop` (read via `openwop capabilities --json`) is the source of
truth for *what a host claims to serve*. A command group that needs an optional
surface should:

- **Probe before it asserts** — use `safeRequest`/`probeEndpoint` (`src/api.ts`),
  not a bare `requestJson` that throws a stack trace when the route 404s.
- **Fail closed, legibly** — when the host doesn't advertise the surface, emit a
  clear `HOST_CAPABILITY_MISSING`-style message ("this host doesn't serve X"),
  never a raw error. Mirror how existing groups handle the missing case.
- **Never pretend** — don't print a fabricated success for a surface the host
  didn't actually honor. Capability honesty is the same rule the host obeys.

### Normative `/v1/*` vs host-extension `/v1/host/sample/*`

Every command targets one of two kinds of route, and **says which in its help text**:

- **Normative `/v1/*`** — protocol-standard surfaces defined in `api/openapi.yaml`
  and backed by an Accepted RFC (e.g. `/v1/runs`, `/v1/agents`). Host-agnostic:
  any conformant host serves these. **Prefer these** when a host serves them.
- **Host-extension `/v1/host/sample/*`** — non-normative surfaces the reference
  app (and lookalike hosts) expose for product features (orgs, kanban, messaging,
  memory, …). Rich and durable, but not part of the wire contract. When a sample
  pattern becomes generally needed, it gets promoted through an RFC and the
  command should switch to the normative path (noting the switch in help + CHANGELOG).

### Auth + base URL are resolved once, from `Ctx`

A command never reads the base URL from the environment or prompts for it inline.
Onboarding (`onboard`/`config`) resolves the host base URL + Bearer key into the
run `Ctx` (`src/context.ts`); every group takes auth and the target host from
`ctx`. Global `--base-url` / `--api-key` overrides are parsed once by
`extractGlobalOptions` (`src/options.ts`) before dispatch.

### Output is dual-surface: human table + `--json`

Every **read** subcommand supports `--json` (machine output via `writeJson`); the
default is a `formatTable` human view (`src/io.ts`). Write/long-running commands
return **meaningful exit codes** so scripts can branch — e.g. `agents run` exits
`0` (completed) / `3` (escalated) / `1` (failed).

### Where it lives (code)

| Concern | Path |
|---|---|
| Entry point (shebang → `runCli`) | `src/openwop.ts` |
| Dispatcher (`switch (command)`, global-option parsing, root help) | `src/cli.ts` → `runCli()` |
| Command groups (the unit of a "feature") | `src/cli/<group>.ts` |
| HTTP to the host | `src/api.ts` (`requestJson`, `safeRequest`, `probeEndpoint`, `parseJsonResponse`) |
| Output | `src/io.ts` (`write`, `writeLine`, `writeJson`, `formatTable`, `prefixChunk`) |
| Arg parsing | `src/options.ts` (`parseOptions`, `extractGlobalOptions`, `splitFlag`, `takeValue`, `toOptionName`) |
| Run context (host, auth, io, config) | `src/context.ts` (`Ctx`) |
| Errors | `src/errors.ts` (`CliError`, `HttpError`, `errText`) |
| Streaming (SSE) | `src/sse.ts` (`submitTurn`, `streamRunEvents`, `consumeSse`, `renderEvent`) |
| Interactive prompts | `src/prompt.ts` (`promptChoice`, `promptText`, `promptYesNo`, `readSecret`) |
| Local config (`~/.openwop/config.json`) | `src/config.ts` |
| Constants (version, default host, provider catalog, host presets) | `src/constants.ts` |
| Daemon/service install (for the `demo` group) | `src/daemon.ts` |
| Relay channel plugins | `src/channels/` (`registry.ts`, `normalize.ts`, `types.ts`) |

---

## Current command groups

Each group is `src/cli/<group>.ts` (exports `<GROUP>_HELP` + `run<Group>(ctx, argv)`)
wired into `src/cli.ts`. "Source" cites the RFC/spec the surface comes from; the
host route is what the subcommands hit.

| Group (aliases) | Source | Host route(s) | Surface / notes |
|---|---|---|---|
| **onboard** | — | (local + provider probes) | Guided first-run wizard: host → provider → model → BYOK key. |
| **doctor** | — | `/health`, `/readiness` | Check local prerequisites + demo reachability. |
| **demo** | — | (local process) | Run/inspect the workflow-engine demo app locally; `install` lays down a LaunchAgent/systemd/Scheduled-Task service (`src/daemon.ts`). |
| **health** | — | `/health`, `/readiness` | Liveness/readiness probe. |
| **capabilities** (`caps`) | — | `/.well-known/openwop` | Read + summarize the host capability advertisement. **This is the gap-discovery entry point.** |
| **catalog** | — | `/v1/host/sample/node-catalog` | List the host node catalog + installed packs. |
| **packs** (`pack`) | C-5 (signed registry) | registry @ `packs.openwop.dev` | Search/info/install (SRI + Ed25519 verify)/publish/yank signed node packs. |
| **workflows** (`workflow`) | — | `/v1/host/sample/workflows` | List/get/register/delete demo workflow definitions. |
| **runs** (`run`) | RFC 0040 (ancestry) | `/v1/runs` (normative) | Create/list/inspect/annotate/debug-bundle; `ancestry` shows the cross-host parent chain. |
| **chat** | — | `/v1/runs` + SSE | Interactive streaming REPL over a workflow (uses `src/sse.ts`). |
| **memory** | — | `/v1/host/sample/memory` | Demo MemoryAdapter list/search/get/delete (tenant-scoped). |
| **media** | `core.openwop.ai` | `/v1/runs` (ai nodes) | generate-image / transcribe / synthesize via the AI pack. |
| **conformance** | — | (in-repo `@openwop/openwop-conformance`) | Run the conformance CLI against a host. |
| **providers** (`provider`) | — | `/v1/host/sample/byok/secrets` | Manage BYOK credential **refs** (never values). |
| **agents** (`agent`) | RFC 0070 | `/v1/agents` + `/v1/host/sample/agents` | Manifest-agent inventory + dispatch; CRUD for user-defined agents. Exit codes `0`/`3`/`1`. |
| **roster** | RFC 0086 | `/v1/host/sample/roster` | Named standing agents + their workflow portfolio. |
| **org-chart** (`orgchart`) | RFC 0087 | `/v1/host/sample/org-chart` | Descriptive department/role/reporting structure. |
| **kanban** (`boards`) | host-extension (composes RFC 0086 triggers) | `/v1/host/sample/kanban` | Agent task boards; `watch` streams card events. |
| **orgs** (`org`) | RFC 0049 | `/v1/host/sample/orgs` | Orgs/teams/groups/roles/members RBAC; `effective` resolves a subject's access. |
| **workspace** | RFC 0059 §C | `/v1/host/sample/workspace` | Per-tenant agent workspace files (list/put/get). |
| **byok** | — | `/v1/host/sample/byok/secrets` | Host-side BYOK secret store; the wire **never returns values**. |
| **config** | — | (local file) | Read/write `~/.openwop/config.json`. |
| **webhooks** (`webhook`) | — | `/v1/host/sample/webhooks` | Manage HMAC-signed webhook subscriptions; `test` fires a signed delivery. |
| **cron** | RFC 0052 | `/v1/host/sample/cron` | Scheduled jobs: list/add/remove/trigger. |
| **messaging** | host-extension | `/v1/host/sample/messaging` | Operate the demo relay-gateway: connectors, sessions, policy, routing, identity, logs. |
| **relay** | host-extension | (local bridge loop) | Local channel relay: register/activate + the inbound→workflow bridge across channel plugins. |
| **notifications** (`notification`) | host-extension | `/v1/host/sample/notifications` | Notification inbox. |
| **interrupts** (`interrupt`) | — | `/v1/host/sample/runs/:id/interrupts` | List a run's open interrupts; resolve one by token. |
| **prompts** (`prompt`) | RFC 0029 | `/v1/host/sample/prompts` | Prompt-library list/get/render. |
| **notify** | — | `/v1/host/sample/notify` | One-off email/SMS dispatch via the demo host. |
| **account** | — | `/v1/host/sample/account` | Tenant self-service hard-delete. |
| **admin** | — | `/v1/host/sample/admin` | Operator maintenance (ephemeral-secret cleanup). |

> **Channel plugins** (used by `relay` + `messaging`): the inbound/outbound
> normalizers for **Signal, iMessage, WhatsApp, and Discord** live in
> `src/channels/` and are re-exported from `cli.ts` so the built bundle is testable.
> A new channel is one entry in the channel registry + a normalizer — it is *not* a
> new command group.

---

## Adding a command group

A new command group is wired by **adding a module + one dispatcher case** — no
rewrite of the dispatcher or other groups (read `src/cli/agents.ts` first; it is
the canonical example). The full contract is the `/feature` skill's evaluation
matrix; the mechanical steps:

1. **Module** — create `src/cli/<group>.ts`:
   - a top-of-file docblock citing the RFC/spec the surface comes from (e.g.
     `/** `openwop <group> ...` — <one-line> (RFC NNNN). */`),
   - `export const <GROUP>_HELP` — a `Usage:` block, a normative-grounded prose
     paragraph (which endpoint + which RFC §), per-flag docs, **meaningful exit
     codes**, and `Examples:`,
   - `export async function run<Group>(ctx: Ctx, argv: string[]): Promise<number>`
     — reads `argv[0]` as the subcommand, dispatches, returns an exit code.
   - Use the shared helpers (`requestJson`/`safeRequest`, `formatTable`, `writeJson`,
     `parseOptions`); **don't hand-roll** HTTP, formatting, or arg parsing. Take
     auth + base URL from `ctx`.
   - **`--json` on every read**; capability-gate gracefully; mirror the host
     route's field names / required-optional / enums **exactly** (the CLI is a
     reference client — a wrong field name teaches implementers wrong).
2. **Dispatcher** — wire it into `src/cli.ts`:
   - add `import { run<Group>, <GROUP>_HELP } from './cli/<group>.js';` by the
     other group imports,
   - add a `case '<group>':` (and any alias, e.g. singular) to `switch (command)`,
   - add the group to the `ROOT_HELP` command index.
3. **Docs** — add the group to the `README.md` command reference.
4. **Tests** — add `test/<group>.test.mjs` (or extend `operator-apis.test.mjs`);
   exercise both the human and `--json` paths. Pure normalizers that the bundle
   needs at test time get re-exported from `cli.ts` (see the `channels/*`
   re-exports).
5. **Verify** — `npm run typecheck` + `npm test` (build is part of `test`) green,
   **and** a live smoke against a running host: `onboard` → `capabilities` →
   `<group> list` → `<group> list --json` → a write path where one exists.
6. **Version + CHANGELOG** — add a `CHANGELOG.md` entry; bump `package.json` if the
   change ships a release (independently versioned at 0.x, NOT pinned to the corpus).

### House rules that bite

- **Option-key gotcha.** `parseOptions` camelCases on hyphens: `--agent-ref` ⇒
  `options.agentRef`, `--no-validate` ⇒ `options.noValidate`. Reading the
  *hyphenated* key (`options['agent-ref']`) silently returns `undefined` — always
  read the camelCase key.
- **Zero runtime deps.** The CLI bundles to a single file (`esbuild
  --packages=external`) and ships **no dependencies** — only `@types/node`,
  `esbuild`, `typescript` are dev deps. Use Node stdlib + the `src/*` helpers; never
  add an npm dependency.
- **No user-facing jargon.** Spell out "server" / "frontend" in help and output;
  BE/FE abbreviations are for code comments only.
- **zsh smoke gotcha.** The dev shell is zsh, which does **not** word-split
  unquoted `$var` — a loop like `for c in "roster list"; do openwop $c; done` passes
  one argv token. Use `${=c}` or call each command explicitly. Unauthenticated live
  requests get a throwaway `anon:<sid>` tenant per invocation, so validate a write by
  asserting its `201`, not a follow-up `list`.

---

## ⚠ Spec changes require an RFC — the CLI is a reference *client*, not a fork of the protocol

If a new surface needs anything on the OpenWOP **wire** — a new run-event field,
capability flag, event type, endpoint contract, auth/scale profile, or a normative
`MUST` — that change belongs in the **`openwop/openwop` RFC process** (`RFCS/`,
from `0000-template.md`) and must reach at least `Accepted` *before/with* a CLI
command that depends on it. Do **not** bake a command against an unsettled wire
contract — surface that as a decision (the `/feature` skill's RFC gate). A command
that rides an **already-Accepted** RFC needs no new RFC (e.g. `agents` implements
RFC 0070). Host-extension surfaces under `/v1/host/sample/*` are non-normative and
never touch the wire, so they never need an RFC.

---

## Future / candidate command groups (placeholder)

Capabilities a host advertises (or reference-app routes) that the CLI does **not**
yet drive land here first, then move up to **Current command groups** once shipped.
Discover them with `openwop capabilities --json` (advertised-but-undriveable) and by
diffing the reference-app route table (`openwop/openwop-app`
`backend/typescript/src/routes/`) against the dispatcher's `case` list. Keep the
group name stable across the move.

<!-- Template row:
| **<group>** (`<alias>`) | RFC NNNN | `/v1/.../...` | <one-line surface>. |
-->

> The `/feature` skill (Mode A) auto-builds this gap inventory and scopes the next
> group; `/update-cli` implements it. Keep this table and the `README.md` command
> reference in lockstep when a group ships.

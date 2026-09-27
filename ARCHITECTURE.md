# @openwop/cli — Architecture

> Companion to [`README.md`](./README.md) (end-user guide) and
> [`FEATURES.md`](./FEATURES.md) (the catalog of command groups). This file
> documents the *shape* of the CLI — what each layer is for, what stays
> host-neutral, and the boundary discipline that keeps the CLI a faithful
> reference **client** instead of drifting into a host-specific fork.

## Architecture contract for new work

`@openwop/cli` is a **host-agnostic control plane** for any OpenWOP-conformant
host. Every command surfaces a protocol capability the host exposes — it is a
*client*, never an engine. New command groups must extend that architecture; they
must not invent a second way to talk to a host, parse args, format output, or
store config.

Use this as the first review checklist for every new command group, subcommand,
flag, channel plugin, or helper:

- **Follow the OpenWOP wire.** Runs, events, interrupts, workflow definitions,
  schedules, agents, BYOK credential refs, host capabilities, replay/fork, and
  provider calls must use the existing OpenWOP protocol shapes and host-extension
  patterns. Mirror the host route's request/response **exactly** — field names,
  required/optional, enum values. The CLI is a reference client; a wrong field
  name teaches implementers wrong.
- **Do not fork the protocol in this CLI.** If a command needs a new run-event
  field, capability flag, endpoint contract, auth profile, error semantic, or a
  normative `MUST`, that belongs in the upstream `openwop/openwop` RFC/spec
  process before or with the CLI work. Don't bake a command against an unsettled
  wire contract. Host-extension surfaces under `/v1/host/openwop-app/*` are
  non-normative and may be driven freely.
- **Use the command-group seam.** A "feature" is a module under `src/cli/<id>.ts`
  exporting `<ID>_HELP` + `run<Id>(ctx, argv)`, wired into the `src/cli.ts`
  dispatcher with a `case`. A group owns its help text, subcommand dispatch, exit
  codes, and tests. Read `src/cli/agents.ts` — it is the canonical shape.
- **Let the host be the authority.** Capability support, RBAC, toggle/variant
  resolution, BYOK secret resolution, and consent decisions are **server-side**.
  The CLI renders the host's resolved view and gates commands on advertised
  capabilities — it is never the source of truth for any of those.
- **Prefer the existing owner for every concept.** HTTP to the host is owned by
  `src/api.ts`; output by `src/io.ts`; arg parsing by `src/options.ts`; the run
  context (host, auth, config) by `src/context.ts`; errors by `src/errors.ts`;
  streaming by `src/sse.ts`; prompts by `src/prompt.ts`; local config by
  `src/config.ts`; channel normalization by `src/channels/`. Compose those owners
  instead of rebuilding them inside a command group.
- **Advertise only honored behavior.** A command that needs an optional surface
  must probe (`safeRequest`/`probeEndpoint`) and **fail closed legibly**
  (`HOST_CAPABILITY_MISSING`-style message) when the host doesn't advertise it —
  never a stack trace, never a fabricated success. Capability honesty is the same
  rule the host obeys.
- **Stay host-agnostic.** Drive commands off what `/.well-known/openwop`
  advertises and what `api/openapi.yaml` defines, not off the reference app's
  internals. Prefer normative `/v1/*` paths when a host serves them; fall back to
  `/v1/host/openwop-app/*` only for demo-only surfaces — and **say which path a command
  hits in its help text**.
- **Stay zero-dependency.** The CLI bundles to a single file with
  `esbuild --packages=external` and ships **no runtime dependencies**. Use Node
  stdlib + the `src/*` helpers. Do not add an npm dependency.
- **Record non-trivial decisions.** New cross-cutting seams, a normative path
  switch, a new channel subsystem, or anything touching the wire is documented
  here (and in `FEATURES.md`); wire changes additionally need an RFC in
  `openwop/openwop`.

The practical rule: a new command should make the existing CLI drive **more of a
host**, not create a smaller second CLI beside it.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│  src/openwop.ts            bin "openwop" — shebang → runCli(argv)    │
├────────────────────────────────────────────────────────────────────┤
│  src/cli.ts → runCli()                                              │
│    ├── extractGlobalOptions   --base-url / --api-key / --json / …    │
│    ├── builds Ctx             host base URL + Bearer auth + io       │
│    ├── switch (command)       routes each group + alias              │
│    └── ROOT_HELP              top-level command index                │
├────────────────────────────────────────────────────────────────────┤
│  src/cli/<group>.ts        one module per command group             │
│    exports <GROUP>_HELP + async run<Group>(ctx, argv): exit code    │
├────────────────────────────────────────────────────────────────────┤
│  Shared foundation (extracted from the former monolith)             │
│    api · io · options · context · errors · sse · prompt · config    │
│    constants · util · daemon · repo · channels/                     │
├────────────────────────────────────────────────────────────────────┤
│              ↓ HTTPS + SSE + Bearer auth (the OpenWOP wire)         │
│                  any OpenWOP-conformant host                        │
└────────────────────────────────────────────────────────────────────┘
                          ↓ build-time only (devDependencies)
                  esbuild (bundle)   ·   typescript (typecheck)
                  — ZERO runtime dependencies in the shipped bundle —
```

**Dependency direction is strict and downward.** A command group imports the
shared foundation; the foundation never imports a command group. The dispatcher
(`src/cli.ts`) is the only module that knows the full set of groups. Nothing
imports the host — the host is reached only over the wire, at runtime, via
`src/api.ts`.

## Existing extension seams

New work should normally enter through one of these seams:

| Need | Existing seam |
|---|---|
| A new protocol surface (a whole `openwop <group> ...`) | New module `src/cli/<group>.ts` + a `case` in `src/cli.ts` |
| A new subcommand / flag on an existing surface | Extend that group's `run<Group>` + `<GROUP>_HELP` |
| HTTP to the host | `src/api.ts` — `requestJson`, `safeRequest`, `probeEndpoint`, `parseJsonResponse` |
| Human + machine output | `src/io.ts` — `formatTable`, `writeJson`, `write`, `writeLine`, `prefixChunk` |
| Arg / flag parsing | `src/options.ts` — `parseOptions`, `extractGlobalOptions`, `splitFlag`, `takeValue`, `toOptionName` |
| Host base URL + auth + io for a command | `src/context.ts` — the `Ctx` object (never read env or prompt for the base URL inside a command) |
| Errors with exit semantics | `src/errors.ts` — `CliError`, `HttpError`, `errText` |
| Streaming run/chat events (SSE) | `src/sse.ts` — `submitTurn`, `streamRunEvents`, `consumeSse`, `renderEvent` |
| Interactive input | `src/prompt.ts` — `promptChoice`, `promptText`, `promptYesNo`, `readSecret` |
| Persisted local settings | `src/config.ts` — `~/.openwop/config.json` (`readConfigSafe`, `saveConfig`, `mergeConfig`, get/set/unset by path) |
| Defaults (host, registry, provider catalog, presets, version) | `src/constants.ts` |
| Local demo lifecycle + managed-service install | `src/daemon.ts` (drives the `demo` group) |
| Repo discovery for in-repo operations | `src/repo.ts` — `findRepoRoot`, `requireRepoRoot`, `demoProjects`, `project` |
| A new messaging/relay channel | A registry entry + normalizer in `src/channels/` — **not** a new command group |

If a proposed command does not fit any seam, treat that as an architectural
decision to document here before implementing — not as permission to add a
parallel path.

## The command-group pattern (the unit of work)

Every command group is a single file `src/cli/<group>.ts` that exports two symbols:

```ts
/** `openwop <group> ...` — <one-line> (RFC NNNN). */
export const <GROUP>_HELP = `Usage:
  openwop <group> <sub> [...]
  ...`;                                                  // printed on --help/-h

export async function run<Group>(ctx: Ctx, argv: string[]): Promise<number> {
  // argv[0] is the subcommand; dispatch, drive the host via src/api.ts,
  // render with formatTable / writeJson, return a meaningful exit code.
}
```

`src/cli/agents.ts` is the **canonical example** — read it before writing a new
group. It demonstrates the house style: a docblock citing the RFC the surface comes
from, a `<GROUP>_HELP` with `Usage:` + a normative-grounded prose paragraph (which
endpoint + which RFC §) + per-flag docs + **meaningful exit codes**
(`0` completed / `3` escalated / `1` failed) + `Examples:`, and a `run<Group>` that
reads `argv[0]`, dispatches, and returns a number.

Conventions that matter:

- **`--json` on every read.** Machine output via `writeJson`; the default is a
  `formatTable` human view.
- **Auth + base URL come from `Ctx`.** Resolved once by onboarding; never read env
  or prompt for the base URL inside a command.
- **Option-key gotcha.** `parseOptions` camelCases on hyphens (`--agent-ref` ⇒
  `options.agentRef`, `--no-validate` ⇒ `options.noValidate`). Reading the
  hyphenated key silently returns `undefined`.
- **Capability-gate gracefully.** Probe and fail closed with a clear message; don't
  N+1 a per-row detail fetch on a shared host (per-IP read budgets are real).

## Protocol vs host-extension boundary

The OpenWOP protocol surface is the contract clients and conformance depend on:
run lifecycle, stream modes, interrupts, replay/fork, capability discovery, auth
profiles, host capabilities, BYOK semantics, pack execution, canonical errors, and
workflow definitions.

- **Normative `/v1/*`** — defined in `openwop/openwop` `api/openapi.yaml` + an
  Accepted RFC. Host-agnostic; **prefer these** when a host serves them.
- **Host-extension `/v1/host/openwop-app/*`** — non-normative surfaces the reference app
  (org `openwop-app`; the pre-2026-06 name `/v1/host/sample/*` now 404s) exposes
  for product features (orgs, kanban, messaging, memory, …). Rich and durable, but
  not the wire. Commands write the `/v1/host/<org>/…` twin; under negotiated major
  2, `src/protocol.ts` sends it to the unversioned `/host/<org>/…` root the host
  advertises in discovery `extensions.*` (`versioning.md` §5), with no
  `OpenWOP-Version` header. When a sample pattern becomes generally needed across
  hosts, it is promoted through an RFC; the command then switches to the normative
  path (noted in help + CHANGELOG).

Capability honesty is mandatory: a command must not advertise/print success for a
surface the host didn't actually serve, must not relax a normative `MUST` or
required field in CLI code, and must fail closed when its capability isn't
advertised.

## Request seams (every call goes through one of these)

A command never builds a URL, picks a protocol path, or attaches the bearer
itself. Four seams own that, so a protocol or host change lands once:

| Seam | File | Owns |
|---|---|---|
| `requestJson` / `safeRequest` / `probeEndpoint` | `src/api.ts` | every JSON request: joins to `--base-url` (keeping a path prefix), bearer, error envelope → `HttpError` |
| `negotiateMajor` + `resolveRequest` | `src/protocol.ts` | ONE discovery read per process (`OpenWOP-Version: 2`; a `406` answer lists what the host serves); under major 2 a manifest `/v1/<op>` → `/<op>` + `OpenWOP-Version: 2.0`, tenant-bound run ids projected (`~2F`), `/v1/host/<org>/…` → the advertised `/host/<org>/…` root. `OPENWOP_PROTOCOL_MAJOR=1\|2` pins it |
| `resolveStreamRequest` | `src/protocol.ts` | every event stream (run events, host streams, `kanban watch`, `present`): the same path negotiation, joined to the **stream origin** — `--stream-base-url` > `OPENWOP_STREAM_BASE_URL` > config `host.streamBaseUrl` > a host-advertised `extensions.*.streamBase` (https-only, no credentials) > `--base-url` — because a front door may buffer streams entirely (openwop-app ADR 0761: 0 bytes in 25 s). The run stream adds `Last-Event-ID` resume and an idle watchdog (`src/sse.ts`) |
| `requestNormativeOrHost` | `src/cli/requestHelpers.ts` | a normative read with a host-extension fallback: on 404/405/501, or on the RFC 0200 §B.1 **no-credential** 401 (`Bearer` challenge without `error=`) when the request carried no credential — never on a refused credential, a bare 401 or a 403. The fallback is announced on stderr |

**Why they are seams and not conventions:** each replaced several hand-rolled
copies that had drifted (four stream call sites, one missing the bearer), and
mocked tests assert whatever literal a command was written with — the 1.0.x line
404'd on 66 host commands after a server rename with the suite green. Verify a
routing change live (`scripts/live-sse-resume.mjs` for streams).

### The command-table engine

Declarative groups run on ONE pipeline, `src/cli/routeKit.ts` (parse → coerce →
read-modify-write → confirm → request → render). A group declares a `RouteCmd[]`
table; `src/cli/resourceCommands.ts` keeps a terser declaration syntax
(`key:type!=flag` field specs) that translates onto the same `RouteCmd` shape,
so both syntaxes share one set of options, one human output, one help/usage
format and one set of error hints and exit codes. Options such as `orgFlag`,
`bodyFlags`, `notice`, `rawText`, `noContent` and `validateFirst` (fail-fast:
validate every input before the `--yes` gate and any read-modify-write GET) are
ordinary features any group may use; there are no adapter-only options.

Every table group — native and spec syntax alike — is pinned by
`test/command-behaviour-snapshot.test.mjs`: `scripts/snapshot-commands.mjs`
discovers the tables from source and records what a generated matrix of
invocations sends and prints. Regenerate the fixture only for an intended
change, and classify the diff mechanically rather than by reading it:
`node scripts/diff-command-snapshot.mjs <old-fixture> --expect <profile>`
(`additive` | `blank-number` | `presentation`) checks every changed invocation
against the profile — e.g. `presentation` proves exit codes, requests, `--json`
stdout and which check refused an invocation are all unchanged.
`marketingShared.dispatchTable` is a
different thing: a dispatcher for hand-written handlers, not a route engine.

## The messaging/relay channel subsystem

`messaging` (host-driven gateway) and `relay` (local bridge loop) compose a small
registry of **channel plugins** under `src/channels/`:

- `registry.ts` — `getChannelPlugin` + per-channel availability probes
  (Signal via `signal-cli` or a daemon URL, iMessage on macOS, WhatsApp, Discord).
- `normalize.ts` — pure inbound/outbound normalizers
  (`parseSignalEnvelope`, `parseImessageRow`, `parseWhatsappMessage`,
  `parseDiscordMessage`, `decodeAttributedBodyHex`).
- `types.ts` — `ChannelPlugin`, `InboundMessage`, `RelayChannel`.

The pure normalizers + the registry are **re-exported from `cli.ts`** so the test
suite (which imports the built `dist/cli.js` bundle) can reach them directly. A new
channel is one registry entry + one normalizer — **not** a new command group.

## Build, test, and release shape

- **Build** — `npm run build`: `esbuild` bundles `src/openwop.ts` + `src/cli.ts`
  to `dist/` (ESM, Node 20 target, `--packages=external`, a `createRequire` banner
  for the few CJS-interop spots). Single file, zero runtime deps.
- **Typecheck** — `npm run typecheck` (`tsc --noEmit`).
- **Test** — `npm test` **builds first**, then `node --test test/*.test.mjs`. The
  tests import the built bundle, which is why pure helpers (channel normalizers,
  the channel registry) are re-exported from `cli.ts`.
- **Live smoke** — a command isn't "done" until it has driven a **running host**
  once: `onboard` → `capabilities` → `<group> list` → `<group> list --json` → a
  write path where one exists. Validate a write by asserting its `201` (an
  unauthenticated live host issues a throwaway `anon:<sid>` tenant per invocation,
  so a follow-up `list` runs under a different tenant).
- **Release** — independently versioned on its own SemVer line (1.x), NOT pinned
  to the protocol corpus version. `package.json` is the only version source
  (`--version` reads it; `test/version.test.mjs` guards it). Changes accumulate
  under `## [Unreleased]`; a release PR bumps the version (`npm version X.Y.Z
  --no-git-tag-version`) and dates the section. **Pushing the `vX.Y.Z` tag
  publishes** (`.github/workflows/publish.yml`, npm trusted publisher with
  provenance). Provision worktrees with `npx -y npm@10.9.8 ci`.

## Boundary discipline

Three rules, restated for CLI scope:

### 1. Zero runtime dependencies

The bundle ships nothing but its own code: `dependencies` is empty;
`@types/node`, `esbuild`, and `typescript` are dev-only. New behavior uses Node
stdlib + the `src/*` helpers. Adding an npm runtime dependency breaks the
single-file, dependency-free install contract.

### 2. Host-agnostic, advertisement-driven

The CLI must work against *any* conformant host. Drive commands off
`/.well-known/openwop` + `api/openapi.yaml`, not the reference app's internals.
Don't hard-code the reference app's host-extension routes as if they were the wire;
probe + capability-gate so a leaner host still works.

### 3. The dispatcher is the only assembly point

`src/cli.ts` is the single module that imports every command group and routes it.
Command groups don't import each other; shared logic moves **down** into the
foundation (`src/*.ts`), never sideways between groups. This keeps the group set a
flat, additive registry — a new feature is one module + one `case`.

### Sandbox gotchas (carry these into any verify loop)

- Run built entries directly — `node dist/openwop.js ...`; wrapped binaries
  (`npx`/`tsc`/`vitest`) can exit `194` in the sandbox.
- The dev shell is **zsh**, which does not word-split unquoted `$var` — use `${=c}`
  in smoke loops or call each command explicitly.

### 4. Parallel build convention (append-at-end)

When several groups are built concurrently on separate branches, the only file they
all touch is the dispatcher (`src/cli.ts`). To keep those branches conflict-free, every
new group **appends** — it never edits another group's lines:

- **Import:** add the new `from './cli/<group>.js'` line **after the last `./cli/*.js`
  import** (~line 81), not interleaved alphabetically.
- **`case`:** add the new `case '<group>':` (and any alias `case`) **immediately before
  `default:`** (~line 222), not grouped with related commands.
- **ROOT_HELP:** add the new command's line at the **end of the `Commands:` list**
  (just before `Examples:`), not in topical order.

Documentation files are union-merged via `.gitattributes` (`CHANGELOG.md`, `FEATURES.md`,
`README.md` → `merge=union`), so each branch just **appends** its CHANGELOG entry,
FEATURES row, and README block — Git unions the additions instead of conflicting. Ordering
can be tidied in a follow-up once all groups have landed.

This convention was proven in practice: the agent-platform sprint delivered **11 new
command groups + a `cron` extension** concurrently across separate worker branches,
merged serially with a single rebase-onto-HEAD per branch, **green at every merge**.
The additive seam (module + one append-at-end `case`) held with zero structural
churn — strong evidence the boundary discipline scales. See [`ROADMAP.md`](./ROADMAP.md)
for the groups still planned (some gated on upstream RFCs).

---

## Why this shape (history)

The CLI began as a single monolith and was split into the shared foundation
(`src/api.ts`, `io.ts`, `options.ts`, `context.ts`, …) + one module per command
group under `src/cli/`. The split is what makes a new feature **additive** (one
module + one dispatcher `case`) and lets the test suite drive pure helpers through
the built bundle. The `/feature` skill scopes the next group against a fixed
evaluation matrix; `/update-cli` implements + verifies it. Keep this file,
`FEATURES.md`, and the `README.md` command reference in lockstep when a group ships.

---
name: feature
description: Drive the openwop-cli capability-surfacing lifecycle — pick the next host capability the CLI doesn't yet drive (or audit a command group you name), gather the host wire contract (/.well-known/openwop + api/openapi.yaml + the reference-app route + the governing RFC), run a boundaries audit against existing groups/helpers, and produce/refine a scoped command-group plan against a fixed evaluation matrix (group shape, dispatcher wiring, wire-contract fidelity, capability-gating, helper reuse, --json + exit codes, auth-from-Ctx, tests, verify gates, zero-dep, version/CHANGELOG). Plans and scopes the group; hands implementation to /update-cli — it does NOT write the command code itself.
argument-hint: "[empty = next capability gap] | <group-name> = author/audit that command group"
---

# Feature Development Mode (openwop-cli)

You are the **capability-surfacing lead** for `@openwop/cli` (this repo). The CLI is a
**host-agnostic control plane** for any OpenWOP-conformant host: every protocol surface a
host advertises (`/.well-known/openwop`) should be reachable from `openwop <group> ...`.
A "feature" here is a **command group** (`src/cli/<group>.ts`) — or a new subcommand/flag
on an existing one — that closes the gap between *what a host now serves* and *what the
CLI can drive*. Your job is to take the **next gap** (or a **named** group) from concept
to an **accepted, fully-scoped plan** — never skipping the architecture questions that
make a command group first-class in this repo.

**You plan and scope the command group. You do NOT implement.** Implementation follows
the per-group workflow in the **`/update-cli`** skill once the plan is accepted; hand
review to **`/code-review`**. (`/update-cli` is the canonical, exhaustive implement+verify
loop for this repo — this skill is its design/scoping front-end for a single capability.)

> **Posture: autonomous.** Run the whole loop end-to-end — select → gather → audit →
> score the matrix → produce the scoped plan — and present the result. **Pause only for a
> genuine decision** (via `AskUserQuestion`): an ambiguous next-gap pick, a real wire
> trade-off (normative `/v1/*` vs sample `/v1/host/sample/*`, or whether to surface a
> command for a contract the spec hasn't settled), or whether to inherit vs correct a host
> quirk. Don't checkpoint for confirmation on mechanical steps.

## Target: $ARGUMENTS

## Scope Rule (read first)

1. **The host wire contract is the source of definition.** A command exists because the
   protocol enables it. Ground every group in, in order of authority: the live
   advertisement (`openwop capabilities --json` ⇒ `/.well-known/openwop`), the normative
   schema (`api/openapi.yaml` in `openwop/openwop`), the reference-app route
   (`openwop/openwop-app` `backend/typescript/src/routes/<domain>.ts`), and the governing
   **RFC**. Cite the RFC the way `src/cli/agents.ts` cites RFC 0070.
2. **Mirror, not guess.** Take the host route's request/response as baseline and match it
   exactly — field names, required/optional, enum values. The CLI is a reference client;
   a wrong field name teaches implementers wrong. Where the reference app carries a wart,
   surface the *normative* shape, not the app's quirk — and name the correction.
3. **Don't cut scope to make it small.** A group isn't "done" at one `list` subcommand —
   its full verb set (read: `list`/`get` with `--json`; write: `create`/`update`/`delete`;
   any streaming/`--watch`; meaningful exit codes; help text + README + tests) is part of
   the definition. Phase the build; never drop the goal. Log every deferral explicitly.
4. **Audit before you assert "new."** Most "we need a new group" — and most accidental
   duplications — collapse once you enumerate the existing `switch (command)` cases,
   command groups, and shared helpers. (`accessControl` owns orgs/teams/roles; `roster`
   vs `agents` is the cautionary near-collision.)

---

## Step 1 — Select the target (two modes)

- **No argument → Mode A (next capability gap).** Build the gap inventory from three
  sources and pick the **first unsurfaced, host-agnostic (prefer normative `/v1/*`)**
  capability:
  1. `npm run build && node dist/openwop.js capabilities --json` — advertised surfaces;
     anything advertised but not driveable from a CLI group is a gap.
  2. Reference-app routes with **no matching CLI group** (clone `openwop-app`, Step 2).
  3. Normative `/v1/*` surfaces in `api/openapi.yaml` (`openwop/openwop`) with no group.
  State which gap you picked, its governing RFC, and why it's the next one.
- **Argument is a group name → Mode B.** If `src/cli/<group>.ts` (and a `case '<group>'`
  in `src/cli.ts`) exists → **audit mode** (score it against the Matrix, produce a
  remediation list). If it's missing → **author/scope mode**.
- Always print: `Mode = A|B`, the capability, its `/v1/...` route + governing RFC, and the
  group path (existing `src/cli/<group>.ts`, or the one to create).

## Step 2 — Gather context (do not skim)

1. **Live advertisement** — `openwop capabilities --json`; the exact optional surfaces the
   target host *claims*. This is the host-agnostic contract — drive off it, not app internals.
2. **Normative schema** — `api/openapi.yaml` + `schemas/` in `openwop/openwop` for any
   `/v1/*` surface: request/response shape, required fields, enums.
3. **Reference-app route (cross-repo).** The ground truth of the reference host's HTTP
   surface for this capability:
   ```bash
   git clone --depth 1 https://github.com/openwop/openwop-app /tmp/owp-app 2>/dev/null || git -C /tmp/owp-app pull -q
   ls /tmp/owp-app/backend/typescript/src/routes/
   grep -rnoE "'/v1(/host/sample)?/[A-Za-z0-9/_:{}.-]+'" /tmp/owp-app/backend/typescript/src/routes/<domain>.ts
   ```
4. **Governing RFC / spec** — grep `RFCS/` + `spec/v1/` in `openwop/openwop` for the
   capability name so the docblock + help can cite it.
5. **Existing CLI surface** — the group file if present (`src/cli/<group>.ts`), its `case`
   in `src/cli.ts`, the README command reference, and the **canonical example
   `src/cli/agents.ts`** (read it before scoping a new group — it sets the house style).

## Step 3 — Boundaries & pre-existing-surface audit (MANDATORY)

Before claiming anything is new, prove it:
- **Dispatcher / alias collision** — `grep -n "case '" src/cli.ts`. Does a `case '<group>'`
  (or an alias, e.g. singular) already route this? Is the surface already a subcommand on
  another group?
- **Concept duplication** — does an existing group already model this entity?
  (`accessControl` → orgs/teams/groups/roles/members; `roster` vs `agents`; `runs` vs
  `chat`.) Name the **single owner**; extend it, don't fork it.
- **Helper reuse** — is there a helper before you hand-roll? `requestJson`/`safeRequest`/
  `probeEndpoint` (`../api.js`), `writeJson`/`formatTable`/`writeLine` (`../io.js`),
  `parseOptions`/`extractGlobalOptions`/`toOptionName` (`../options.js`), `Ctx`
  (`../context.js`), `CliError`/`HttpError`/`errText` (`../errors.js`), SSE helpers
  (`../sse.js`), prompts (`../prompt.js`), repo discovery (`../repo.js`). Reuse over reinvent.
- **Option-key gotcha** — `parseOptions` camelCases on hyphens (`--agent-ref` ⇒
  `options.agentRef`, `--no-validate` ⇒ `options.noValidate`). Reading the hyphenated key
  silently returns `undefined`. Note the camelCase keys the new subcommands will read.

## Step 4 — The Command-Group Evaluation Matrix (answer EVERY row)

| # | Dimension | What to decide / cite |
|---|---|---|
| 1 | **Group shape** | `src/cli/<group>.ts` exports `<GROUP>_HELP` + `async run<Group>(ctx, argv): Promise<number>`; top-of-file docblock cites the RFC; mirrors `agents.ts`. **No edits to core beyond the dispatcher wiring** (Row 2). |
| 2 | **Dispatcher + help/README wiring** | `import { run<Group>, <GROUP>_HELP } from './cli/<group>.js'` + a `case '<group>':` (and any alias) in `src/cli.ts`; entry in the top-level help index; entry in the `README.md` command reference. |
| 3 | **Wire-contract fidelity** | Field names / required-optional / enums match the route + `api/openapi.yaml` exactly. Which `/v1/...` endpoints does each subcommand hit? Cite them + the RFC in `<GROUP>_HELP`. |
| 4 | **Capability-gating** | Probe with `safeRequest`/`probeEndpoint`; on absence fail with a clear `HOST_CAPABILITY_MISSING`-style message, never a stack trace. Prefer normative `/v1/*`; fall back to `/v1/host/sample/*` only for demo-only surfaces — state which path the command hits in help. |
| 5 | **Helper reuse** | Uses the shared helpers (Row in Step 3), not hand-rolled HTTP/format/parse. Auth + base URL come **from `Ctx`** — never read env or prompt for the base URL inside a command. |
| 6 | **Output + exit codes** | `--json` on **every** read subcommand (`writeJson`); `formatTable` human default; **meaningful exit codes** so scripts can branch (e.g. `agents`: `0` completed / `3` escalated / `1` failed). |
| 7 | **Streaming / long-running** | If the surface streams (runs, chat, relay), use the `../sse.js` helpers (`submitTurn`/`streamRunEvents`/`renderEvent`) + a `--watch`/follow mode; otherwise state "none". |
| 8 | **Tests** | `test/<group>.test.mjs` (or extend `operator-apis.test.mjs`); exercise both human + `--json` paths. Pure normalizers re-exported from `cli.ts` so the built bundle is testable (see the `channels/*` re-exports). |
| 9 | **Verify gates** | `npm run typecheck` + `npm test` (build is part of `test`) green, **and** a live smoke against a running host (`onboard` → `capabilities` → `<group> list` → `<group> list --json` → a write path where one exists). |
| 10 | **Zero-dep / house rules** | No new runtime deps (esbuild `--packages=external`, single bundle) — stdlib + the `src/*` helpers only. No user-facing jargon: spell out "server"/"frontend"; BE/FE only in code comments. |
| 11 | **Version + CHANGELOG** | Decide whether `package.json` bumps (independently versioned at 0.x, NOT pinned to the corpus) and add a `CHANGELOG.md` entry; note any normative-supersedes-sample path switch. |

## Step 5 — RFC / wire gate (normative vs host-extension)

- **Host-extension under `/v1/host/sample/*` → no RFC needed.** Non-normative; the default
  for demo-app-only surfaces. State in help that the command targets the sample path.
- **Normative `/v1/*` surface** → it must already be in `api/openapi.yaml` + backed by an
  **Accepted** RFC in `openwop/openwop`. Cite it. If the wire contract for this capability
  is **not yet settled** (no RFC / Proposed / in flux), that is a **genuine decision** —
  surface it to the user via `AskUserQuestion` rather than baking a command against an
  unstable contract.
- **Honesty:** only scope a command for a capability a host actually serves; capability-gate
  gracefully (Matrix Row 4) instead of advertising a surface the host doesn't honor.

## Step 6 — Output

Produce the scoped plan automatically (don't ask first); surface it for review once drafted.

**Mode A / author-mode →** a **scoped command-group plan** containing: the boundaries audit
(Step 3), the Matrix answered row-by-row (Step 4), the RFC/path-gate decision (Step 5), and
a **phased build** — Phase 1 reads (`list`/`get` + `--json`) → Phase 2 writes
(`create`/`update`/`delete`) → Phase 3 streaming/exit-code/help polish → Phase 4
README/help/tests — plus the "mirror, don't guess" wire corrections and any explicit
deferrals. Then **hand implementation to `/update-cli`** (it owns the actual file edits +
dispatcher wiring + verify loop). Offer to save the plan under `docs/` if the user wants a
durable record — do **not** invent an ADR tree this repo doesn't have.

**Mode B / audit →** a **Command Compatibility Report**: the Matrix scored **Pass/Gap** per
row with `file:line`, the single-owner check, missing subcommands/flags vs the route's verb
set (e.g. "ships `list` but no `get`/`create`, no `--json` on `list`, no exit codes"),
missing tests, the prefer-normative-path check, and a **prioritized remediation list** ready
to hand to `/update-cli`.

## Step 7 — Definition of done & handoffs

- **Keep the docs in lockstep (do it, don't just suggest).** The plan must name the exact
  `README.md` command-reference edit and the top-level `--help` index entry the
  implementation will land — the same lockstep as the group file + dispatcher case.
- **Done means** (after `/update-cli` implements): group file follows the `agents.ts` shape
  → wired in `src/cli.ts` (import + `case` + alias) → `README.md` + top-level help updated →
  `test/<group>.test.mjs` added/extended → `npm run typecheck` + `npm test` green → **smoked
  live** against a running host (a `list`/`get` round-trips a `create`/seed) → `CHANGELOG.md`
  entry + any `package.json` version bump.
- **Verify gates** with the sandbox gotchas in mind: run built entries directly
  (`node dist/openwop.js ...`; `npx`/`tsc`/`vitest` exit `194` in this sandbox); the smoke
  shell is **zsh** which does not word-split unquoted `$var` — use `${=c}` or call each
  command explicitly; unauthenticated live requests get a throwaway `anon:<sid>` tenant per
  invocation, so validate a write by asserting its `201`, not a follow-up `list`.
- **Git hygiene:** branch from `origin/main`, stage explicit paths (never `git add -A`),
  land via PR per this repo's flow. Don't strand the shared `main` tree.
- **Compose skills:** `/update-cli` (implement + verify — the primary handoff),
  `/code-review` (pre-merge), `/conformance` or `openwop conformance` for protocol checks,
  and `/architect` for deeper design critique *only if that skill is present in this repo*.

## Workflow commands
| Command | Action |
|---|---|
| `proceed` | Produce the scoped plan for the selected capability, then hand to `/update-cli` |
| `audit` | Force Mode B on the named command group |
| `next` | Re-pick the next unsurfaced capability gap |
| `report` | Emit the Command Compatibility Report only |
| `done` | Finish |

# CLAUDE.md — working in `@openwop/cli`

Guidance for Claude / agents making changes in this repo. Read this first, then
[`ARCHITECTURE.md`](./ARCHITECTURE.md) (the shape) and [`FEATURES.md`](./FEATURES.md)
(the command-group catalog). For what to build next, use
[`ROADMAP.md`](./ROADMAP.md) as the feature roadmap.

## What this project is

`@openwop/cli` is a **host-agnostic control plane** for any OpenWOP-conformant host
— a reference *client*, never an engine. Every command surfaces a protocol
capability the host exposes; the CLI drives the wire and renders the host's
resolved view. It bundles to a single file with **zero runtime dependencies** and
ships independently of the `openwop/openwop` spec corpus.

## The five golden rules (do not break these)

1. **Host-agnostic, advertisement-driven.** Drive commands off
   `/.well-known/openwop` + `api/openapi.yaml`, not the reference app's internals.
   Prefer normative `/v1/*`; fall back to `/v1/host/sample/*` only for demo
   surfaces — and **say which path a command hits** in its help text.
2. **Capability-honest, fail closed.** Probe with `safeRequest`/`probeEndpoint`;
   when a host doesn't advertise a surface, fail closed with a legible
   `HOST_CAPABILITY_MISSING`-style message and a non-zero exit — never a stack
   trace, never a fabricated success. **The host is the authority** for policy,
   RBAC, toggle/variant resolution, consent, and approvals — render its decision,
   never compute or assert one locally.
3. **Secrets are refs, never values.** BYOK keys, OAuth client secrets, SAML
   certs, SCIM tokens are host-side. The CLI handles refs/status only; run
   responses through a redactor before output; never print/log/persist a secret.
4. **Zero runtime dependencies.** Node stdlib + the `src/*` helpers only. Adding
   an npm `dependencies` entry breaks the single-file install contract.
5. **Don't fork the protocol here.** A new run-event field, capability flag,
   endpoint contract, or normative `MUST` belongs in the `openwop/openwop` RFC
   process (≥ Accepted) before/with the CLI work. Host-extension surfaces under
   `/v1/host/sample/*` are non-normative and may be driven freely.

## The unit of work: a command group

A "feature" is one module `src/cli/<group>.ts` exporting `<GROUP>_HELP` +
`async run<Group>(ctx, argv)`, wired into the `src/cli.ts` dispatcher with a
`case` (plus any alias). Read `src/cli/agents.ts` — it is the canonical example.
Compose the shared foundation; don't hand-roll:

| Concern | Owner |
|---|---|
| HTTP to the host | `src/api.ts` (`requestJson`, `safeRequest`, `probeEndpoint`) |
| Output (human + `--json`) | `src/io.ts` (`formatTable`, `writeJson`, `write`) |
| Arg parsing | `src/options.ts` (`parseOptions`, …) |
| Host + auth + io | `src/context.ts` (the `Ctx` object) |
| Errors + exit codes | `src/errors.ts` (`CliError`, `HttpError`) |
| Streaming (SSE) | `src/sse.ts` |
| Local config | `src/config.ts` (`~/.openwop/config.json`) |
| Channels | `src/channels/` (a new channel is a registry entry + normalizer, **not** a group) |

House conventions: `--json` on every read; `formatTable` human default; meaningful
exit codes (e.g. `0` ok / `3` escalated|pending / `1` failed); docblock cites the
RFC/source; help text has `Usage:` + prose + flags + exit codes + `Examples:`; no
user-facing jargon (spell out "server"/"frontend").

## Gotchas that bite

- **Option-key camelCasing.** `parseOptions` camelCases on hyphens: `--agent-ref`
  ⇒ `options.agentRef`, `--no-validate` ⇒ `options.noValidate`. Reading the
  hyphenated key returns `undefined`.
- **Append-at-end in `src/cli.ts`** (parallel-build convention, ARCHITECTURE §4):
  new import after the last `./cli/*.js` import; new `case` immediately before
  `default:`; new `ROOT_HELP` line at the end of the Commands list. Never edit
  another group's lines. `CHANGELOG.md`/`FEATURES.md`/`README.md` are
  `merge=union` (`.gitattributes`) — just append.
- **One `case` per token.** A second `case` for the same token is dead code
  (the first wins). Smoke: `grep -c "case '<token>'" src/cli.ts` must be `1`.
- **No N+1 on a shared host.** Per-row detail fetches trip per-IP read budgets.

## Build · test · verify

```bash
npm run typecheck          # tsc --noEmit
npm test                   # builds the bundle, then `node --test test/*.test.mjs`
node dist/openwop.js ...   # run the built entry directly (npx/tsc can exit 194 in-sandbox)
```

- Tests import the **built bundle** (`dist/`), so pure helpers a test needs
  (channel normalizers, the registry) are **re-exported from `cli.ts`**.
- A new group needs `test/<group>.test.mjs` covering the human **and** `--json`
  paths + empty/error cases.
- **Definition of done includes a live smoke** against a running host:
  `onboard → capabilities → <group> list --json → a write path` (assert the
  `201` on writes — an unauthenticated live host issues a throwaway `anon:<sid>`
  tenant per invocation). See `ROADMAP.md` "live-host verification."
- Dev shell is **zsh** (no unquoted `$var` word-splitting — use `${=c}`).

## Adding a group — checklist

1. Module `src/cli/<group>.ts` (`<GROUP>_HELP` + `run<Group>`), docblock cites the
   source; mirror the host route's field names / required-optional / enums exactly.
2. Wire into `src/cli.ts` (append-at-end): import + `case` (+ alias) + `ROOT_HELP`.
3. Docs: `README.md` command reference + `FEATURES.md` row + `CHANGELOG.md` entry.
4. `test/<group>.test.mjs` (human + `--json`).
5. Verify: `typecheck` + `test` green, one-`case`-per-token, live smoke.
6. Version + CHANGELOG if it ships a release (independently versioned at 0.x;
   bump `package.json` **and** `VERSION` in `src/constants.ts` in lockstep).

## Roadmap & process

- **`ROADMAP.md` is the feature roadmap** — consult it for what's left to build,
  what's RFC-gated, and the sequencing. Keep it current when surfaces ship.
- Spec/wire changes go through `openwop/openwop` RFCs. Several CLI groups are
  pending RFCs (`proposals` → RFC 0096, `goals` → RFC 0097, `import`/`export` →
  RFC 0098) and **must not be built until those reach Accepted** with host routes.
- Companion design skills live in `.claude/skills/` (`architect`, `feature`,
  `update-cli`): `architect` reviews changes against this contract; `feature`
  scopes the next group; `update-cli` implements + verifies it.

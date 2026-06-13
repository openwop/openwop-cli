# ROADMAP — `@openwop/cli`

The feature roadmap for the CLI: what shipped, what's queued, and what's **gated on
upstream `openwop/openwop` RFCs** before it can be built. The CLI is a host-agnostic
reference *client* — a surface lands here only once the host route it drives is real
(normative `/v1/*` behind an Accepted RFC, or a `/v1/host/sample/*` host extension).

> Companion docs: [`FEATURES.md`](./FEATURES.md) (catalog of shipped groups) ·
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) (shape) · [`CHANGELOG.md`](./CHANGELOG.md)
> (per-release detail). New work is scoped by the `/feature` skill and implemented by
> `/update-cli`.

## Legend

- ✅ **Shipped** — on `main`, in `FEATURES.md`.
- 🔜 **Near-term** — buildable now (host route exists); no upstream blocker.
- ⏳ **RFC-gated** — needs an `openwop/openwop` RFC at `Accepted` **and** a host route
  before the CLI group can be built. Do **not** bake a command against an unsettled wire.
- 💤 **Deferred / optional** — real host surface, lower priority.

---

## ✅ Shipped — agent-platform sprint (`[Unreleased]`, slated for `0.3.0`)

11 new command groups + a `cron` extension, all capability-gated and host-authoritative:

| Group | Surface |
|---|---|
| `approvals` | Human-in-the-loop approval inbox (agents propose, humans dispose) |
| `governance` (`policy`) | Tenant policy + audit-log read |
| `consent` | Tenant-scoped, region-aware consent / GDPR erasure |
| `toggles` | Host-resolved feature-toggle/variant assignments (render-only) |
| `users` | Identity directory + account lifecycle |
| `profiles` | Self-service persona / skills / portfolio |
| `auth` (`sso`) | Enterprise SSO / SAML / SCIM config (refs only) |
| `mcp` | JSON-RPC MCP client for the host mount (RFC 0020) |
| `connections` (`conn`) | Third-party connection + OAuth-client inspection (refs only) |
| `workforces` (`fleet`) | Durable multi-agent orchestration / governance posture |
| `analytics` (`usage`) | Org-scoped usage/cost/observability |
| `cron` *(extended)* | `enable`/`disable` (PATCH) + `--roster` filter (RFC 0052) |

## 🔜 Near-term — no RFC blocker

1. **Live-host verification gate.** Run the full smoke (`onboard → capabilities →
   <group> list --json → a write path`) for the 11 new groups against a running host
   (`app.openwop.dev` or local), asserting capability-gating + fail-closed behavior
   and `201` on writes. This is the `ARCHITECTURE.md` "definition of done" the sprint
   has not yet formally closed. **Highest priority.**
2. **Release `0.3.0`.** Consolidate `CHANGELOG [Unreleased]`, bump `package.json` +
   `VERSION` in `src/constants.ts` (lockstep), tag `v0.3.0` (OIDC trusted-publisher
   pipeline publishes on tag).
3. **`kb` group** 💤 — host knowledge-base surface (`/v1/host/sample/kb`). Real but
   reads more as a reference-app product feature than a control-plane primitive; ship
   behind a capability probe.
4. **`crm` group** 💤 — host contact/triage surface (`/v1/host/sample/crm`). Same
   posture as `kb`.

## ⏳ RFC-gated — build once the RFC is Accepted *and* the host route exists

These three were the competitive differentiators surfaced during the sprint and
architect-gated as *needs-RFC* (no host route today). RFCs are filed and **merged as
`Draft`** in `openwop/openwop`; each must reach `Accepted` with a reference-host route
before the CLI group is built.

| Planned group | Drives | RFC | Status |
|---|---|---|---|
| `proposals` | Reviewable-learning proposal lifecycle (inert drafts → RFC 0051-gated activation) | **RFC 0096** | Draft |
| `goals` | Standing goals — judge-based (RFC 0090) completion + bounded continuation | **RFC 0097** | Draft |
| `import` / `export` | Agent-platform portability — export bundle + tenant import (refs-only, dry-run, idempotent) | **RFC 0098** | Draft |

Expected shapes (subject to the RFCs' final wire):

- **`proposals`** — `list` / `get` / `revise` / `apply` / `reject` / `archive`;
  `--json` on reads; exit codes `0` applied / `3` pending-review / `1` rejected|error.
  `apply` routes through the host's approval gate; never activates locally.
- **`goals`** — `list` / `get` / `create` / `pause` / `resume` / `abandon`; `--json`
  on reads; exit codes `0` satisfied / `3` escalated / `1` bound-exceeded|error.
  Completion is the host judge's verdict; the CLI never sets `satisfied`.
- **`import` / `export`** — `export --kinds`, `import <bundle> --dry-run` (renders the
  plan), `import <bundle>` (applies); `--json` on reads; exit codes `0` applied /
  `2` plan-has-conflicts / `1` error. **Never accepts or prints secret values** —
  refs only; reports `secretsToRebind`.

Gate to lift the ⏳: RFC `Accepted` + the host advertises the surface in
`/.well-known/openwop` (or serves the `/v1/host/sample/*` route).

## 💤 Deferred / out of scope

- **Sibling surfaces, not CLI groups:** web/desktop/mobile apps, PWA + web push,
  voice capture, companion device nodes. The CLI is one surface among these, reached
  over the wire — it does not host them.
- **`migrate-tenant` as a standalone group** — the existing host route is an SPA-only
  anon→user bootstrap (cookie-coupled, near-always a no-op from a CLI). The
  CLI-appropriate generalization is `import`/`export` (RFC 0098), which subsumes it.

## Sequencing

```
live-host verify (1) ──▶ release 0.3.0 (2) ──▶ kb / crm (optional)
RFC 0096/0097/0098 reach Accepted + host routes ──▶ proposals / goals / import-export
```

Keep this file current: when a 🔜 ships, move it to ✅ and add the `FEATURES.md` row;
when an ⏳ RFC reaches `Accepted`, drop the gate note and schedule the group.

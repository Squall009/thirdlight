# M2 evidence — packet 19: delivery, protocol, export and dependency contract integration

Date 2026-09-18 (UTC) · runId `tl19-2026-09-18-a` · packet 19 of M2
(`docs/planning/m2-packets.md` §19). Gate E. All artifacts are sanitized: no
credentials, no owner content, no project data, no `contentId` values.

**Status: PROPOSED deliverables only.** Packet 19 is a contract-drafting packet.
Nothing here is accepted; no accepted contract (`docs/contracts/`), package,
tool, lockfile or deployment changed, no dependency was installed, no git commit
was made, and Gate E/the promotion step/packet 20 were **not** started. Gate E
records accept/reject per row of
[`contract-diffs.md`](../../../planning/m2-contracts/contract-diffs.md), and a
separate docs-only promotion step applies the accepted rows before packet 20.

Owner pre-approval recorded in the drafts and diffs: **owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending** — a
pre-approval, **not** an independent review and not an owner approval. The
packet-19 owner-decision spot (the U-4 disposition of the two M1 requests +
Gate C CF-2/CF-3) is recorded as **ACCEPT as proposed, fail-closed** in
`delivery.md` §13, `diffs/sessions.md` S19-10 and `diffs/export.md` E19-7; if the
owner rejects it at Gate E, both implementations stay fail-closed and nothing
else depends on them.

## Environment (actual)

Same container host as packets 14–18 (Proxmox LXC): Node v22.22.1 · repo-pinned
TypeScript 5.9.3, esbuild 0.28.2, three 0.186.0, vitest 5.0.1. No browser, GPU or
gamepad was needed or used. No new dependency, no network access, no lockfile
change. HEAD `5b746eebc8be22feb921909dc3f5b849c2560ccb`; the working tree carries
the uncommitted M2 planning docs and packet-15/16/17/18 outputs, which this
packet preserved.

## Deliverables

| Claim | Artifact |
|---|---|
| One coherent M2 public boundary: manifest, asset-byte reads, locator, v2 bridge, input relay, format-aware validation, export closure, bounds, negative matrix, U-4 | `docs/planning/m2-contracts/delivery.md` (PROPOSED — pending Gate E) |
| Consolidated proposal ⇒ destination inventory + conflict resolutions + promotion order | `docs/planning/m2-contracts/contract-diffs.md` |
| Session/gesture diff (snapping, locator, bridge v2, relay, `engineRoot`) | `docs/planning/m2-contracts/diffs/sessions.md` (S19-1–S19-14) |
| Export diff additions (closure, manifest layout, format-aware scan, fetches, `meta.json`, reference-entry clause) | `docs/planning/m2-contracts/diffs/export.md` §"Packet 19 additions" (E19-1–E19-10) |
| Dependency diff additions (units, exports, edges, probes, pins incl. the Rapier pin and naming resolution) | `docs/planning/m2-contracts/diffs/dependencies.md` §"Packet 19 additions" (D19-1–D19-10, D19-A) |
| Decision-0002 draft §§2–6 + updated §-status table (nothing approved) | `docs/decisions/0002-m2-content-and-behavior.md` |
| Acceptance-plan refinements (Gate-E-fixed constants, evidence names, no weakening) | `docs/planning/m2-acceptance.md` §§1/5 |
| Delivery/protocol fixtures + six new checker groups | `fixtures/m2/contracts/delivery/**`, `expected.json`, `tools/check-fixtures.mjs` (`p19-*`), `verification.md` §6 header, `README.md` |
| Inventory-consistency check | `inventory-check.mjs` (this directory), `06-inventory-consistency.txt` |

## Claims → artifacts

| # | Claim | Artifact | Status |
|---|---|---|---|
| 1 | Every fixture parses strictly/canonically, is indexed, and every code it uses is declared | `01-fixture-check.json`, `02-fixture-check-run.txt` — 33/33 check groups, 0 problems, exit 0 | **verified** |
| 2 | Every route/message is exact: identifier-only paths, token/origin requirements per surface, capability-only preview routes, registry-checked codes, §11.2 status mapping (`unauthorized` → 401 exception) | `p19-protocol` — 14 routes, 8 bridge messages, 51 error mappings re-derived | **verified (fixture level)** |
| 3 | Locator expiry/grace/authorization is arithmetic, not prose | `p19-locator` — 14 cases re-derived from TTL/grace/path kind; cache lifetime ≤ remaining TTL | **verified (fixture level)** |
| 4 | Upload/stage bounds and malformed frames are exact | `p19-upload` — 7 cases with the five-check precedence and exact `limit` reason | **verified (fixture level)** |
| 5 | Binary containers are never judged by the old text scan | `p19-scans` — 13 cases; GLB/WASM/closure cases must have `textScanApplied: false`; fault→code table is the checker's own | **verified (fixture level)** |
| 6 | The manifest is digest-bound and its closure is consistent | `p19-manifest` — `buildId`/`buildOptionsDigest`/scene/content digests recomputed; asset/behavior digests re-hashed from committed preimages/containers; fetch count `1 + declared artifacts` | **verified (fixture level)** |
| 7 | The relay is bounded, exclusive and reported by step range | `p19-relay` — 10 cases re-deriving the step range, clearing, limits, timeout and no-browser `session_unavailable` | **verified (fixture level)** |
| 8 | Every proposal and diff has an exact destination and the conflicting drafts are resolved | `contract-diffs.md`; `06-inventory-consistency.txt` — 16 proposal/diff files listed, 24 referenced file tokens resolve, decision §§2–6 present, 22 packet refs resolve, exit 0 | **verified (docs level)** |
| 8b | The packet-15–18 diff files render as intended (fence-delimiter repair only; no normative line changed) | `contract-diffs.md` §3 (c2) — 1 fence in `diffs/export.md`, 8 in `diffs/project-model.md`, the S19-8 outer fence in `diffs/sessions.md` | **repaired (formatting-only)** |
| 9 | The new checks are not vacuous | `05-negative-control.txt` — seven corrupted values (one per p19 group + the registry) fail `code-registry` and the six `p19-*` groups; exit 1 | **verified** |
| 10 | Accepted contracts/decisions/packages/tools/lockfile are untouched; no install, no commit | `04-proposal-check.txt` — empty `git status`/`git diff` for `docs/contracts packages tools package.json package-lock.json`; decision 0002 sha256 `c7ecffe6…`; lockfile `a71f4c0b…` | **verified** |
| 11 | The repository toolchain stays green | `03-toolchain.txt` — checker exit 0 (33/33), `npm test` 841/841 (66 files) exit 0, `typecheck` exit 0, `check-deps` exit 0, `check-boundaries` OK (10 packages / 150 files / 514 specifiers), `build` exit 0 (4 built, 0 skipped) | **verified** |

## Acceptance criteria (`m2-packets.md` §19)

| Criterion | Status |
|---|---|
| Exact routes/messages/error mappings; numeric bounds/timeouts | **specified** (`delivery.md` §§5–8/11/15; `diffs/sessions.md` §11.3/§11.5; fixtures + `p19-protocol`/`p19-upload`/`p19-locator`) |
| Per-package exports/edges/pins and a negative-test matrix | **specified** (`diffs/dependencies.md` D19-1…D19-10; `delivery.md` §10; `p19-*` groups) |
| New runtime fetch policy plus format-aware scans | **specified** (`delivery.md` §4.3/§4.4; `diffs/export.md` E19-6; `p19-scans`) |
| U-4 accept/reject recorded | **recorded: ACCEPT both, fail-closed** (`delivery.md` §13; S19-10; E19-7; decision 0002 §6.8) |
| Snapping increments, coordinate space, scale limits, rounding/cancel in the gesture diff; local-preview only, no persistent setting | **specified** (`diffs/sessions.md` S19-4) |
| No authoring credentials in preview (bounded read-only capability only) | **specified** (`delivery.md` §6; S19-2/S19-8) |
| No service dependency in export | **specified** (`delivery.md` §9; E19-1/E19-6) |
| No binary content in WS state | **specified** (`delivery.md` §7; S19-9; `p19-protocol` `forbiddenBinaryCarriers`) |
| Exact destination contract sections for every proposal; conflicting drafts resolved | **specified** (`contract-diffs.md` §2/§3) |
| Immutable runtime-content manifest; derived build digest distinct from `project@revision`; build failure preserves the previous output | **specified** (`delivery.md` §§2/3; `p19-manifest`) |
| Authoring asset-byte reads authenticated/project-scoped/immutable-version; renderer receives no token | **specified** (`delivery.md` §5) |
| Preview delivery only completed immutable artifacts; unguessable bearer locator (expiry/auth/CSP/referrer/cache/cleanup/redaction/exclusion); reload never newer bytes | **specified** (`delivery.md` §6; S19-12) |
| Export = same pipeline + complete reachable closure, relative-only, no credentials/CDN/Node/backend; allowlisted relative artifact reads replacing M1's one-fetch only by contract diff | **specified** (`delivery.md` §9; E19-2/E19-5/E19-6) |
| Bounded input relay (semantic actions, finite steps, applied range + snapshot/build, exclusive mode, no-browser structured unavailable) | **specified** (`delivery.md` §8; S19-13) |

## Limitations / unverified

- No implementation exists: no content byte route, locator, build, manifest,
  relay or scan runs. All fixture checks are shape/arithmetic re-derivations.
- The `buildId`/`buildOptionsDigest` recomputation is verified for the one
  fixture manifest only; no real bundle was built.
- No browser, network capture, CSP, gamepad or secure-context evidence — those
  belong to packets 25/30/35/36/37 (A11/A18/A21/A22).
- The Rapier pin stays **PROVISIONAL** (packet-14 desktop evidence + Gate E
  approval open); it enters the lockfile only at packet 31.
- The two packet-19 diffs append to packet-15/16/17/18 diff files (not new
  files); `contract-diffs.md` is the single inventory future packets must read.
- The fence-delimiter repair in `diffs/{export,project-model,sessions}.md` is
  formatting-only: the normative lines of packets 15–18 are unchanged.

## Next step

**Gate E review (not started).** The reviewer records accept/reject per row of
`docs/planning/m2-contracts/contract-diffs.md` (plus the U-4 disposition and the
owner pin/trust decisions), then a separate docs-only promotion step applies the
accepted diffs into `docs/contracts/` and records the decisions in
`decisions/0002-m2-content-and-behavior.md` **before packet 20**. No packet is
started automatically.

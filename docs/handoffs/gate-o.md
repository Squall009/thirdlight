# Gate O — packets 56–60 review (in-session)

**Verdict: ACCEPTED** (with the disclosed limitations and the single open CC
recorded below).

Reviewed in-session (no sub-session available — host constraint).

## Scope

Packets 56–60 since Gate N (ACCEPTED, packet 55):

- **56** — gameplay + camera authoring controls (B02/B03/B17).
- **57** — media, lighting, animation authoring controls (B11/B12/B14/B17).
- **58** — project-model manifest v2 core + the exporter M3 standalone export
  (B16/B19/B21).
- **59** — isolated M3 Play, control/observation integration (B19/B20 + the
  integrated B04–B16 Node halves).
- **60** — standalone M3 export + production parity; the 58/60 §5.4.1 + §17.5
  re-measurement (B19/B21/B22/B23).

## A. Toolchain re-run (fresh, 2026-09-21 — /tmp/gate-o-toolchain.txt)

- `npm test`: **177 files / 2230 tests passed**, exit 0.
- `typecheck`: 17 packages OK. `check-deps`: all exact versions.
  `check-boundaries`: 17 packages / **335 files / 1319 specifiers, 0
  violations**. `build`: **5 built, 0 skipped**.
- Checkers (all green): M2 contracts **34/34**; M3 delivery **16/153**, media
  **14/119** + control, gameplay **23/127**, contracts **39**, storage **9/10**.
- Frozen fixture bytes: untouched by 56–60 (all digest-pinned checkers re-run
  green above; the M2 binding `bundle-scan.test.ts` re-passes unchanged).

## B. Reviewer-side verification pass (independent re-derivation)

**B1. §5.4.1 re-measurement (60) — the deviation trigger did NOT fire.**
Independently re-built (a) the reference full-core three bundle (pinned
`three@0.186.0`, the §5.3 pinned esbuild option set) and (b) the REAL M3 export
bundle (the production `buildM3Bundle` over the shared `buildContentClosureM3`
closure, two declared assets) and re-scanned the a–j patterns:

- reference three: **d=3, f=3, h=26, j=3; a/b/c/e/g/i=0** — matches the
  recorded-exception table exactly (measured 1,777,856 bytes; the table's
  1,777,857 differs by a 1-byte newline separator in the entry — the per-needle
  counts, which are the binding part, are exact).
- M3 export bundle: **a/b/c/e/g/i=0; d=8 = 3 (three core) + 1 (Rapier) + 1
  (`./manifest.json`) + 1 (`./scene.json`) + 2 (one per unique declared asset
  path); f=3, h=26, j=3** — i.e. **exactly** the recorded baseline + the
  applicable exception rows + the counted engine call sites, with **0
  contributed by `game-host`** to d/f/h/j and a/b/c/e/g/i. No GLTFLoader
  subpath in the M3 graph; no trust notice in the M3 page; no absolute/remote
  `fetch`.

Verdict: the packet-42 M3 addition holds **exactly** as recorded. **No bounded
re-review is required and no exception is widened** (the contract's deviation
trigger did not fire). The §17.5 runtime fetch list is exactly
`./manifest.json` + `./scene.json` + one per unique declared asset path (all
relative).

**B2. M2 byte-stability.** The binding M2 §5.4.1 `bundle-scan.test.ts` re-passes
unchanged (the M2 preview bundle is byte-stable). `preview-bootstrap.ts` (the M2
entry) has **zero** references to `preview-m3`/`game-host`/`startM3Preview`
(re-grepped: 0) — the M3 preview wrapper is a **separate entry**, never inlined
into the M2 bundle.

**B3. Boundary invariants.** `check-boundaries` = 0 violations. The ONLY editor
file importing `@thirdlight/game-host` is `packages/editor/src/preview/
preview-m3.ts` (the approved preview-wrapper seam, delivery.md §4.3). The
`platformer-game → runtime` edge is **types-only** (both imports are
`import type { … } from '@thirdlight/runtime'`; no value import). No new cross-
package internal imports, no hidden global services, no duplicate scene
mutation paths.

**B4. The §5 relay/observation surface (59, PR-2).** The typed observation relay
+ SDK tools are realized over the **accepted** HTTP + MCP surface, NOT new bridge
wire types: the backend exposes `POST …/play/:playSessionId/control` + `/observe`
+ `/input` + `/screenshot` (backend.ts §20 relays; `play.test.ts` exercises
`/screenshot`), and the MCP adapter exposes `tl_game_control` +
`tl_game_observe` (mcp-adapter `tools.ts`). The v3 preview entry uses the
**accepted** bridge surface (handshake/snapshot/ready/stop). **No protocol
refinement was made** — the accepted packet-48 bridge schema (which has no
game-control/observe wire types) is unchanged.

**B5. B22 preview/export parity (60, Node half).** The M3 **EXPORT** manifest and
the v3 **PLAY** manifest for the same captured state are the **SAME build** —
identical `buildId`/`sceneDigest`/`contentDigest`/`settingsDigest` — both derived
by the SAME shared `buildContentClosureM3` from the SAME single captured read and
both wrapping the SAME single `createGameHost` (the resolved six-key `settings`
reach both hosts, C35-5). Re-derived independently (`determinism.test.ts`).

**B6. B23 two-tree reproducibility (60).** Two exports of the same captured
state (a fixed wall clock) into two DIFFERENT output trees are **byte-identical**
file-for-file (the accepted timestamps are the only time-dependent bytes; the
`buildId` re-derives from the manifest content). A failed re-export leaves the
prior tree byte-untouched (`export_snapshot_mismatch`, m3-builds). No new
authoring value is introduced. Re-derived independently.

**B7. B21 export closure (58/60).** The export is a complete relative
declared==emitted closure: `index.html` is a **static loader** (loads
`./js/main.js` as a module + the HUD `div`s — **no alternate sample logic**);
`manifest.json`/`scene.json`/`meta.json` + the `content/sha256/<digest>` assets
are all relative and digest-addressed; the §5.4 forbidden-pattern (a/b/c/e/g/i=0)
+ relative-closure + GLB/WAV container scans run over every emitted file;
missing/corrupt media and a rejected hostile source (CC-55-3 fail-closed)
preserve the previous output.

## C. Adjudicated items / findings

- **F1 — project-model manifest v2 (58, reopened §44 row):** bounded re-review
  — the v2 surface is **purely additive** (new `manifest-v2.ts` + new exports);
  the v1 capture path is unchanged; the v2 core is unit-tested (23) and the
  derived manifest is **byte-identical** to the committed
  `manifest-v2-example.json` (16 integration). **ACCEPT** (additive only, v1
  unchanged, fixture-verified).
- **F2 — workspace captured-view seam `readCapturedV3` (58):** a purely
  **additive** read seam — the workspace owns the single acknowledged envelope
  read and exposes the v3 `scene`+`content` halves to the closure builder; the
  **derivation is NOT duplicated** (the closure builder owns it); the v1 view is
  unchanged. This satisfies the may-edit's "named at K" clause (the workspace
  owns the single acknowledged read + the `captureContentView` public edge).
  **ACCEPT** (additive, no derivation duplicated).
- **F3 — PR-2 (59): the scene rides the `tl.snapshot` bridge.** The accepted
  §17.2.1 locator route set has **no** scene route; the v3 snapshot (scene)
  arrives only through the nonce-verified `tl.snapshot` bridge, with the
  manifest v2 `sceneDigest` as the identity the preview verifies against. This
  **matches the accepted M2 content/snapshot split** (sessions.md §13.2/§17.6) —
  a bounded interpretation, **no schema change**. **ACCEPT.**
- **F4 — PR-2 (59): the §5 relay routes through the accepted HTTP + MCP
  surface.** See B4. The accepted packet-48 bridge schema is unchanged; adding
  `tl_game_control`/`tl_game_observe` as bridge wire types would have reopened
  the protocol section — instead they are realized over the accepted
  `POST …/play/:id/control|observe` + the MCP tools. **ACCEPT** (no schema
  change).
- **F5 — GLB model rendering gap (58, carried):** the shared three-adapter
  `createSceneAdapter` realizes boxes/lights/surfaces/camera only — model
  entities become empty Groups (no attach surface). A visible packet-61 player
  must therefore use a **box** (the `demo-0003` sample is box-based, 0 media
  assets). A three-adapter model-attach surface is a **follow-up, out of the
  58/61 may-edit**. **ACCEPT as a disclosed limitation.**
- **CC-55-3 (open, carried from Gate N):** the §3.1 config has no
  behavior-linking channel; the composition rejects source-bearing behavior
  scenes **fail-closed** (`export_build_unavailable`/`behaviors_unsupported` for
  export, `host_config_invalid`/`behaviors` for the host). The packet-61 sample
  uses **built-in modules only** (no behavior records), so the open channel is
  not required for M3 acceptance. **ACCEPT as open** — a concrete diff is filed
  by the first packet that ships a behavior-carrying delivered game.
- **F6 — settings-values query gap (56):** no accepted query returns settings
  **values** (only `settingsKeys` counts); the editor panel degrades safely and
  documents it (seeded from the registry defaults + applied `setSettings`
  changes). Not a CC — the accepted contract is binding. **ACCEPT as disclosed.**

## D. Verdict

**ACCEPTED.** All 56–60 acceptance rows that are Node-verifiable PASS (B02/B03/
B11/B12/B14/B17 authoring planning/gesture/projection halves; B16 settings trace;
B19/B20 pin; B21 export closure; B22 preview/export parity Node half; B23
two-tree reproducibility; the §5.4.1 + §17.5 re-measurement with no deviation
trigger). The browser/visual/audible/physical-keyboard-gamepad halves remain
**UNVERIFIED in-container** (no browser/GPU/audio device — packet-38 baseline
§1); their owner-run procedures are the shipped READMEs (Z1–Z11, A1–A9, P1–P10,
X1–X7). No contract was silently changed; the two PR-2 items are bounded
interpretations over the accepted schema (no refinement made); the single open
CC (CC-55-3) is accepted as open; F1–F6 are disclosed. **Applied CCs: none new
(CC-55-3 remains open).** Next: **packet 61** (Author Beacon Reach through
supported workflows — box player).

**Signature:** reviewed in-session (no sub-session available — host constraint),
2026-09-21.
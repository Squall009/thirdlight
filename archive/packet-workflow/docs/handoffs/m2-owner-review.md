# Thirdlight M2 — owner review brief

2026-09-19. **State: M2 packets 14–37 executed; Gates E–J recorded; packet 37 +
Gate J complete.** Owner pre-approval for this autonomous build:
"owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending". No git commits were made — the whole M2 delta is uncommitted in
the working tree, alongside the untouched M1 planning artifacts. M3 is **not**
started and no post-37 work exists.

Authoritative acceptance record: [`../acceptance/m2-report.md`](../acceptance/m2-report.md)
(A01–A24 matrix, §4 U-1…U-5, §8 owner actions). Gate records:
[`gate-e.md`](gate-e.md), [`gate-f.md`](gate-f.md), [`gate-g.md`](gate-g.md),
[`gate-h.md`](gate-h.md), [`gate-i.md`](gate-i.md) + [`gate-i-rereview.md`](gate-i-rereview.md),
[`gate-j.md`](gate-j.md), and the repair handoffs `m2-promotion.md`,
`gate-{f,g,h,i,j}-repair.md`.

## 1. Packets (one line each)

| # | Packet | Handoff | One line |
|---|---|---|---|
| 14 | Browser baseline / bounded physics selection | [14.md](14.md) | Rapier 2D proposed (`@dimforge/rapier2d-compat@0.20.0`); container evidence complete; desktop/browser/gamepad UNVERIFIED |
| 15 | Content storage, asset identities, migration | [15.md](15.md) | Storage v2 envelope + immutable `sources/sha256` blobs, staging (BR-4), operator migration-copy; 42 fixtures |
| 16 | Typed edits, prefab and property contracts | [16.md](16.md) | Materialized copy-on-instantiation prefabs, declared properties, typed M2 command set |
| 17 | Stateful runtime, input, 2.5D physics | [17.md](17.md) | Fixed-step phase order, fail-stop, `ActionFrame`, XY-only physics, tolerances from packet-14 |
| 18 | Trusted behavior execution/compilation | [18.md](18.md) | Trusted main-thread scripts; **no sandbox, no hard timeout**; digest-bound prepare→publish |
| 19 | Delivery/protocol/export/dependency pack | [19.md](19.md) | One consolidated boundary pack, contract-diffs inventory, U-4 dispositions |
| 20 | Model v2 and pure migration | [20.md](20.md) | Strict v2 validators/normalization/`serializeCanonical`, pure M1→M2 conversion; M1 API preserved |
| 21 | Pure content and property commands | [21.md](21.md) | Non-prefab M2 ops on the existing history engine, inverses, no-change, stale-before-validation |
| 22 | Pure prefab capture and instantiation | [22.md](22.md) | Capture/instantiate with exact recorded ID remapping, one-undo subtree removal |
| 23 | Workspace content publication/migration-copy | [23.md](23.md) | Real FS v2 envelopes, blob publication, staging, integrity/quota, migration-copy; real SIGKILL tests |
| 24 | Bounded GLB inspection / import proposals | [24.md](24.md) | New pure `asset-pipeline`; 17 self-generated GLBs + adversarial limits; deterministic recipe digests |
| 25 | Content HTTP services, projection, MCP parity | [25.md](25.md) | Real backend+FS+stdio-MCP flows, immutable-version byte reads, bounded jobs; browser UNVERIFIED |
| 26 | Shared GLB rendering and asset previews | [26.md](26.md) | One resource-owner path, cancellation/stale-drop, ownership counters, real GLTFLoader; pixels UNVERIFIED |
| 27 | Content browser, placement/reimport, snapping | [27.md](27.md) | Asset authoring + contract-exact snapping; gesture discipline (0/1/0 commands) |
| 28 | Prefab and declared-property authoring UI | [28.md](28.md) | Prefab copies + schema-driven typed inspector; copies not linked; no script evaluation |
| 29 | Runtime scheduling and module lifecycle | [29.md](29.md) | Phase guards, transform ownership, fail-stop lifecycle; M1 demo frozen |
| 30 | Keyboard and gamepad actions | [30.md](30.md) | New `input` package: exact frames, dead zone, focus/blur/disconnect, clean detach; hardware UNVERIFIED |
| 31 | Rapier 2D adapter | [31.md](31.md) | Approved pin installed (integrity re-verified); parentless kinematic capsule; real-library course tests |
| 32 | 2.5D controller + diagnostic course | [32.md](32.md) | Real-adapter course vs tolerances, Z locked, catch-up/stall, directional CPU numbers |
| 33 | Immutable behavior builds | [33.md](33.md) | New `behavior-build`: static validation + pinned esbuild, **source never executed**; cold builds 6/6 |
| 34 | Behavior execution + publication UI | [34.md](34.md) | Behavior host executes compiled artifact; measured property→behavior; trust warning explicit |
| 35 | Play delivery + bounded MCP input | [35.md](35.md) | Immutable pins/locator, versioned bridge, real MCP input relay; live browser UNVERIFIED |
| 36 | Standalone M2 export | [36.md](36.md) | Double export byte-identical except timestamp; play/export trace max\|Δ\|=0; backend-independent |
| 37 | Integrated acceptance + deployment docs | [37.md](37.md) | 18/18 integrated journey checks, clean `/tmp` `npm ci`; report + deployment §8–§10 |

## 2. Open-items checklist

**A. Owner desktop walkthrough (the only gate to closing acceptance).** 16 rows
carry an UNVERIFIED browser/hardware half: **A02, A03, A04, A05, A07, A08, A11,
A12, A13, A15, A16, A17, A18, A19, A20, A21**. Run `m2-report.md` §8 items 1–8
on a desktop (WebGL 2, real keyboard + physical gamepad, recorded secure context
per BR-3; localhost/TLS topology if plain-HTTP LAN blocks `getGamepads`) and file
the evidence under `docs/acceptance/evidence-m2/37/`. Required artifacts include
real screenshots (a real rendered PNG for A19), browser console/network captures,
gamepad identity/mapping, and the standalone-export walkthrough with the backend
stopped. No PNG exists today; nothing was fabricated.

**B. Other unverified / stated limitations.** Physics selection PROVISIONAL with
container/directional CPU numbers (BR-2) — a desktop re-measurement closes it.
Trusted-main-thread scripts have no hard timeout and no hostile-code sandbox
(decision 0002 §5, pre-approved). Power-loss durability beyond `fsync` ordering is
unproven. The M2 glTF extension allowlist is frozen empty (no browser to test the
pinned loader). `content.settings` does not yet reach Play (bounded deferral with
a diff). `clone(true)` shares skeletons (no M2 fixture has skins). M1 gizmo drag
semantics changed in packet 27 and need the walkthrough re-check (GG-9).

**C. Pre-approval-tagged decisions.** Decision
[`0002`](../decisions/0002-m2-content-and-behavior.md) §§1–6 are approved only
under the pre-approval tag: physics engine/distribution/pin; content storage and
migration; prefabs/typed properties; stateful runtime/input/2.5D physics; trusted
behavior execution boundary; delivery/export/dependency pack. U-4 (`engineRoot`,
§5.4.1 reference entry) accepted fail-closed and CLOSED. U-1 partially resolved
(owner browser checklist), U-2 not reproduced (16 cold builds), U-3 documented,
U-5 moot unless you adopt browser automation.

**D. Gate follow-ups — all applied; residual items are bounded and recorded.**
E: GE-1…GE-4 applied + docs-only promotion. F: GF-1…GF-6 (incl. a real ordering
fix: blob published only after successful inspection). G: GG-1/GG-2 closed two
milestone-blocking command gaps (place a model entity; author collider/controller)
plus GG-3…GG-8. H: R1–R7 (P1 fail-stop leak, gamepad takeover phantom press,
fixture O7, input/slide promotions). I: R-I-1 (SHA-256 padding) + R-I-2 (§14.5
effective input) + 29 accepted docs diffs, then re-review **ACCEPT**. J: close-out
applied (consistent UNVERIFIED list, non-vacuous A22 tree diff, A20 stop assertion).
Residual bounded items: C21-5 property-helper location (single implementation,
documented), `content.settings` deferral, `capturedAt` capture-second-dependent
reproducibility, extension allowlist empty.

**E. Known scope gaps (deliberate, per charter §3).** No GC, no dynamic bodies,
one kinematic character, GLB-only, copy-only prefabs, no material/shader graph,
no baked lighting/probes, no terrain, no cinematic tools, no LOD, no multiplayer;
M3/M4 items (camera follow, hazards/respawn, HUD, audio, animation selection,
material presets, lights/shadows, templates, reference-device budgets) remain
unbuilt.

## 3. Evidence map (acceptance row → artifacts)

Row-level detail and reasoning: `m2-report.md` §2. Primary artifact locations:

| Rows | Artifacts |
|---|---|
| A01, A09, A10 | `evidence-m2/37/journey/{01-migration,02-m1-v1,07-crash-takeover,08-durability}.json`; `evidence-m2/23/**` (real SIGKILL/fault) |
| A02–A04 | `evidence-m2/37/journey/03-import-reimport.json`; `evidence-m2/24/**`; `fixtures/m2/assets/**` |
| A05–A08 | `evidence-m2/37/journey/04-prefabs-properties.json`; `evidence-m2/22/**`, `evidence-m2/27/**`, `evidence-m2/28/**` |
| A11–A14 | `evidence-m2/30/**`, `evidence-m2/31/**`, `evidence-m2/32/**`, `evidence-m2/29/**` |
| A15, A16 | `evidence-m2/37/journey/{05-behavior,06-play}.json`; `evidence-m2/33/**`, `evidence-m2/34/**` |
| A17–A20 | `evidence-m2/37/journey/06-play.json`; `evidence-m2/35/**`; `evidence-m2/26/raw/ownership-counters.txt` |
| A21–A23 | `evidence-m2/37/journey/09-export.json`; `evidence-m2/36/**` |
| A24 | `evidence-m2/37/{clean-install,journey/10-pins}.json`; `../acceptance/deployment.md` §8–§10 |
| Contracts/decisions | `evidence-m2/promotion/**`; `docs/decisions/0002-m2-content-and-behavior.md` |
| Browser procedures | `tests/browser/{m2-assets,m2-prefabs,m2-input,m2-controller,m2-behaviors,m2-play}/` |

## 4. Exact next step after owner sign-off

1. Execute the §2-A walkthrough and file the evidence; then the M2 acceptance
   record can be closed (m2-report §8). The residual §2-D bounded items are
   already recorded and are not blocking.
2. Only on an explicit owner request: start the **M3 planning prompt**
   (`docs/planning/implementation-prompts.md`, "M3: one complete short
   platformer") as a planning-only task. Do not start M3 implementation, M4, or
   any new packet from this brief.

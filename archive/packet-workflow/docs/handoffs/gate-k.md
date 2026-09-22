# Gate K — M3 contract pack review (packets 38–43)

**2026-09-19. Review record only. Verdict: ACCEPT WITH BOUNDED FOLLOW-UPS.**
This is not owner or independent-human approval and promotes nothing. Nothing
outside this file was written.

## Scope, method, reviewer limits

Fresh single read-only session, same harness; no owner/human participation.
Reviewed the 9 pack documents, 7 diff files, 6 handoffs and the plan/packets/
acceptance/sample; re-ran every checker and the toolchain; independently
re-derived the claims. No handoff summary was treated as proof. Pre-packet-38
content equality was not verifiable (no baseline hash); integrity rests on mtime
+ invariant `git diff`. `npm run build` rewrote generated `dist/**` only.

## Re-run results

| Command | Exit + headline |
|---|---|
| packet-39 checker | 0 — 37 groups |
| packet-40 checker | 0 — 23 groups/124 checks |
| packet-41 checker / `generate --check` | 0 / 0 — 13 groups/85 checks; 40 files reproduce |
| packet-42 checker | 0 — 16 groups/153 checks |
| packet-43 `check-audit.mjs` | 0 — 8 groups |
| 39/40/41 corruption copies | 1/1/1 — digest+`v3-valid`; semantic; digest+semantic |
| 42 / 43 `--corrupt-control` | 0 ctl — both / 3 corruptions exit 1, expected check |
| `npm test` | 0 — 135 files/1701 tests |
| `npm run typecheck` / `check-deps` | 0 / 0 — green; all pins exact |
| `npm run check-boundaries` | 0 — 15 pkgs/283 files/1068 specifiers |
| `npm run build` | 0 — 4 built, 0 skipped |

## Untouched tree

`git diff --stat` is identical before/after: **91 files, 16020 insertions(+),
1489 deletions(−)** (the pre-existing M2 diff). Newest mtimes — `docs/contracts`
10:52, `packages/**` 10:42, `tools/**` 10:19, `package.json` 09-18 19:47,
`package-lock.json` 08:41 — all **before** packet-38 start (~13:45). Files newer
than 13:45 are only packet-38–43 outputs (fixtures/m3 138, tests/evaluations 16,
docs/planning 16, docs/acceptance 13, handoffs 6, decision 0003, STATUS.md).
`packages/platformer-game`/`game-host` are absent; decision 0003 is PROPOSED;
STATUS K is `pending`. **Unverified:** pre-38 byte baseline.

## Independent re-derivations (python3, not the Node checkers)

1. **buildId** = `sha256(JSON.stringify(manifest−buildId,null,2)+"\n")` =
   `c25ba8f8…c654`; the committed `manifest-v2-preimage.json` bytes hash to the
   same value.
2. **Block digests** scene `01f5d5…`, content `e6c929…`, settings `1e0330…`, game
   `5ad520…`, media `a6e27a…` all reproduced. Canonical bytes: content 1909,
   manifest 4685 (example incl. buildId; preimage 4604).
3. **WAV**: `cue-max.wav` dataBytes 192000, blockAlign 2, byteRate 96000, frames
   96000, `durationMs=floor(96000/48)=2000`, `sourceBytes=192044`,
   `riffSize=36+192000=192036`; stage-1 bound 196608.
4. **Camera**: `halfH=12·tan22.5°=4.970562748477141`; 16:9
   `halfW=h·(1280/720)=8.836555997292695`, Cx∈[8.836…,39.163…],
   Cy∈[0.9705…,3.0294…]; 4:3 `h·(1024/768)=6.6274169979695206`; smoothing
   `8(1−0.75¹⁰)=7.549491882324219`; cap `min(39.75,4)=4`.
5. **Sweep**: `dy=0.06`, `dx_max=√(0.09−0.0036)=0.29393876913398137`, threshold
   `10.206061230866018`; d_out `0.3059411708155678`, d_in `0.2961418578992161`.
6. **Packet-39 fixture**: `sha256(envelope/valid/demo-0003-fresh-v3.json)=
   63fc527c…` matches `index.json` (bytes 1753); 28 model error codes.
7. **Inventory**: exactly **109** §2 rows (PM19, W9, C14, CMD41-3, PM41-7,
   R40-16, R41-4, R42-4, S42-12, E42-9, D42-7, PM43-3, NC-2); 109 unique, 109
   `open`.
8. **Version tables**: `|1|3|3| valid` identical in model §23.2, storage §S2 and
   W3, which alone moves `≥3→≥4`; respawn `131`; events `80`, dropped `48`;
   shadow `26≤64`, degraded `102>64`.

## Open-question adjudications

- **R40-16 (K-1)** — summary-only, no body. **Reject:** drop, or packet 40
  resupplies §11 and it is re-reviewed.
- **C41-1 `GameView.playerMotion` (K-2)** — consumed by `presentation.md`
  §41.3.6 but absent from `gameplay.md` §6. **Resolution: add**
  `playerMotion {speed, grounded}` to `GameView`; the adapter cannot call the
  runtime-private `lastMotionSegment`. Repair `gameplay.md` §6, the `game-view`
  fixture, `presentation.md` §41.3.7 and `diffs/runtime.md` R41-1 wording.
- **`platformer-game` export name (K-3)** — **genuine open owner decision
  (packets 40/42)**, not a rename: `gameplay.md` §11 exports `sessionSpec`,
  `cameraSpec`, `GAME_MODULE_IDS` and three pure-math functions, while
  `delivery.md` §3.4 / D42-2 export `platformerGameSpec`,
  `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`,
  `CAMERA_CONSTANTS`, `RUN_LIMITS`, and the packet-42 fixture adds a third
  (`platformerGameSessionSpec`). Consequence: `dependencies.md` §3 (D42-2) and
  `gameplay.md` §11 (NC-1) must not both be promoted; one surface must be chosen
  before packets 49/55/58 create the unit, correcting the other documents +
  fixture.
- **`game_config_invalid` (K-4)** — adopt `path` **+ `reason`** (the reason
  distinguishes `field_missing`/`field_unexpected`/`field_type`/`field_value`);
  repair C9 and extend the packet-39 `game-*` invalid fixtures to assert it.
- **Manifest example versions (K-5)** — confirm the `modules`/`enginePins`
  identities are **illustrative**; packet 58 derives real values from the
  lockfile pin table. The fixture's `buildId` is self-consistent and is
  re-derived then.
- **Six vs seven (K-13)** — correct to **six** in `model.md` §23.3, PM5 and
  `STATUS.md` row 39.

## 109-row verdicts

Grouped; every row is covered. Not accepted rows are named individually.

| Destination / group | Rows | Verdict | Reason |
|---|---|---|---|
| project-model §3/§6/§8/§10/§12/§13/§17/§18.2/§18.3/§19.2/§20 | PM1–4, 6–8, 10–12, 14–18 | accepted | Additive v3 data/version/reference/change rows; M1/M2 unchanged |
| project-model §10/§12.6/§23 | PM5, PM9, PM19 | accepted-with-diff | K-13 count; unregistered `spawn_transform_unsupported` |
| project-model §18.1 rule 3 | PM13 | **rejected** | No body; superseded by PM41-1 |
| workspace §3/§4.2/§4.5/§11/§13.9/§14/§15/§16 | W1–W9 | accepted | One new passable row; scoped `≥3→≥4`; non-destructive refusal |
| commands §2/§3.1/§3.1.9–11/§4/§5.3/§5.6/§8.1/§8.13–14/§9.1/§12 | C1–8, 10, 12–14 | accepted | New ops/args/inverses; closed `createEntity` union |
| commands §5.4 / §8.10 | C9, C11 | accepted-with-diff | K-4 `reason`; spawn code |
| commands + project-model media | CMD41-1…3, PM41-1…7 | accepted | `kind`/`animation`, atomic reimport, rule-3 exception, recipe/metrics unions |
| runtime §1–§6/§8/§12.1–12.3/§12.6/§13/§14/§15 | R40-1…15 | accepted | Additive schedule/reset/view/camera; M2 prefixes intact |
| runtime §11 | R40-16 | **rejected** | K-1 empty row |
| runtime §9/§12.3/§13/§2 | R41-2, R41-3, R41-4 | accepted | Host-owned resources |
| runtime §9 | R41-1 | accepted-with-diff | K-2 wording |
| runtime §3.1/§12.5/§15 | R42-1…4 | accepted | C35-5 closure; menu channel |
| sessions §7/§10.5/§11.5/§13/§15/§17.4/§17.5/§17.6/§20 | S42-1…6, 8–12 | accepted | Relay, CSP token (38 evidence), readiness |
| sessions §17.1.1 | S42-7 | accepted-with-diff | K-5 illustrative identity |
| export §2/§3/§5/§7 | E42-1…6, 8, 9 | accepted | Own CSP, non-root closure, two-tree rule |
| export §6 | E42-7 | accepted-with-diff | K-5 |
| dependencies §2/§4.1–4.3/§5/§9 | D42-1, 3, 4, 5, 6, 7 | accepted | Two units, edges, editor-UI prohibition, check 12 |
| dependencies §3 | D42-2 | **deferred** | K-3 conflicting public surface |
| project-model §1/§14, export §8 | PM43-1…3 | accepted | Scopes obsolete M1/M2 non-goals; weakens nothing |
| new `gameplay.md` | NC-1 | **deferred** | K-3 §11 (+ K-2); rest promotable after FU-4 |
| new `presentation.md` | NC-2 | accepted-with-diff | K-2 selector input |

Counts: **accepted 96, accepted-with-diff 9, rejected 2, deferred 2.**

## Mandatory properties

- **No production implementation against unaccepted contracts**: contract and
  package mtimes pre-date 38; new units absent; no promotion. **Verified.**
- **Creation paths**: `authoring.md` §A8 has 21/21 Create ops; spot-checked rows
  2 (`setGameConfig.instructions`), 9 (`setComponent(gameZone,{role:"checkpoint",
  safeSpawnId})`), 11 (`activation` in the same command), 6/8
  (`createEntity.components`/`setComponent` add) and 18 (`publishAsset` create)
  against A8 + traceability §1–§2. **Verified.**
- **PR-1 owned**: instructions (39 §23.4), `safeSpawnId` (39 §23.3.1),
  activation (41 §41.5 + `GameView.checkpointActive`). **Verified.**
- **No second mutable document / no silent upgrade**: `content.game` is an
  envelope key (PM1/PM11/PM14); v1/v2 unchanged, one new combination,
  single-error refusal, chained copy migration; audit version-table check passed.
  **Verified.**
- **One owner per item**: audit group passed; M2 phase prefixes intact; **one
  exception** — unregistered `spawn_transform_unsupported` (B3).
- **Trusted-code boundary unchanged**: no row edits `behaviorTrust`, the §14
  boundary or the trusted-main-thread limit; sample uses built-in modules.
- **Container limits honest**: software WebGL only, no physical gamepad/audio/
  display/GPU; **no browser/hardware row claimed PASS** (B13/B15/B22 UNVERIFIED);
  38's `engine.json` FAIL is a reported contract defect, not a pass.

## Blocking findings

B1 K-3 incompatible `platformer-game` surfaces (blocks D42-2/NC-1). B2 R40-16
empty (K-1). B3 `spawn_transform_unsupported` referenced in `model.md`
§23.3.2/§23.8 and C11 but defined nowhere. B4 K-2 `playerMotion` consumed but
undefined. No finding changes accepted M1/M2 behaviour, weakens a guarantee, or
adds a dependency/pin (`check-deps` green; §7 pins untouched; D42-* add units,
not third-party deps).

## Bounded follow-ups

FU-1 K-13 "seven"→"six" (39/43). FU-2 K-4 add `reason` to
`game_config_invalid` + fixtures (39/43). FU-3 resolve `spawn_transform_unsupported`
to `zone_transform_unsupported` or register it (39/43). FU-4 K-2 add
`playerMotion` to `GameView` + fixture + R41-1/NC-2 (40/41/43). FU-5 K-5 mark
manifest identity illustrative; 58 derives real pins (42/58). FU-6 K-1 drop or
resupply R40-16 (40). FU-7 K-3 one `platformer-game` surface (40/42) — **owner
decision required** before D42-2/NC-1 promote.

## Promotion precondition

Promote **docs-only** the 96 accepted rows now, after applying FU-1…FU-6 to the
9 accepted-with-diff rows; **drop** PM13 and R40-16; **hold** D42-2 and NC-1 §11
(FU-7). Promote `gameplay.md`/`presentation.md` only after FU-4, and do not
promote runtime §15 before its `gameplay.md` target is promoted. No production
code, install, commit or owner approval is part of promotion.

**Final verdict: ACCEPT WITH BOUNDED FOLLOW-UPS.** Review record only — not
owner or independent-human approval; promotes nothing.

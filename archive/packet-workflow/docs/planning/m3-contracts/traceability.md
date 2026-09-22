# M3 traceability matrix — feature → command → UI/MCP → runtime → export → acceptance

**PROPOSED · packet 43 · not accepted.** Inputs: packet-39 authorability table
(`authoring.md` §A8), packet-40 run/view/camera contract (`gameplay.md`),
packet-41 presentation contract (`presentation.md`), packet-42 delivery contract
(`delivery.md` §3–§6), [`m3-sample.md`](../m3-sample.md) and
[`m3-acceptance.md`](../m3-acceptance.md) B01–B24. This file changes no contract
and approves nothing; each row's contract rows are listed in
[`contract-diffs.md`](contract-diffs.md). **Creation, not only editability, is the
acceptance bar** (`m3-packets.md` §43): every row below names the op that
*creates* the value.

Machine-checked by `fixtures/m3/audit/tools/check-audit.mjs`: the A8 row numbers
must be exactly 1–21, every B01–B24 row must exist here with the same owning
packets as `m3-acceptance.md`, and the three PR-1 rows must name a creation op.

---

## 1. Sample value → creation path → runtime/export → acceptance

`A8 row` is the row number in `authoring.md` §A8. `Create` is the **creation**
op (an edit/remove op is not sufficient). `Runtime` is what consumes the value
during a run; `Export` is what carries it into the standalone tree. Acceptance
ids are the B rows this value is evidence for.

| A8 row | Sample value | Create (command) | Edit / remove | Query | UI (56/57) | MCP (48) | Runtime | Export | Acceptance |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Game config block (title, objective) | `setGameConfig` (complete, when `game === null`) | `setGameConfig` partial, `null` to remove | `queryGameConfig`, `queryProject.game` | 56 title panel | `set_game_config` | HUD title/objective text nodes (55) | `manifest.game` embedded (58) | B02, B04 |
| 2 | **Instructions string (PR-1)** | `setGameConfig.instructions` | `setGameConfig` | `queryGameConfig` | 56 title-panel text field | `set_game_config` | `GameContent.game.instructions` → HUD text node (55) | `manifest.game` embedded (58) | B02, B04, B15 |
| 3 | Player / camera / start-spawn references | `setGameConfig` (create) | `setGameConfig` | `queryGameConfig` | 56 reference pickers | `set_game_config` | reset destination + camera owner (49/50) | `manifest.game` embedded (58) | B02, B07 |
| 4 | Level bounds / `killY` | `setGameConfig` | `setGameConfig` | `queryGameConfig` | 56 bounds fields | `set_game_config` | fall threshold, camera clamp (49/51) | `manifest.game` embedded (58) | B02, B06, B10 |
| 5 | Cue assignment (start/jump/checkpoint/death/goal) | `setGameConfig.cues` | `setGameConfig` | `queryGameConfig`, `queryAssets` | 57 cue pickers | `set_game_config` | cue events → audio owner (54) | `manifest.media.cues` + declared WAV (58) | B02, B12 |
| 6 | Hazard zone | `createEntity({kind:"group", components:{gameZone:{role:"hazard",size}}})` **or** `setComponent(e,"gameZone",…)` add | `setComponent` edit/remove | `queryEntities{component:"gameZone"}`, `queryEntity` | 56 zone tool | `set_component` | swept predicate (49) | `scene.json` (58) | B02, B06 |
| 7 | Goal zone | same, `role:"goal"` | `setComponent` | `queryEntities{component:"gameZone"}` | 56 zone tool | `set_component` | goal decision (49) | `scene.json` (58) | B02, B08 |
| 8 | Checkpoint zone | same, `role:"checkpoint"` + required `safeSpawnId`/`activation` | `setComponent` | `queryEntities{component:"gameZone"}` | 56 zone tool | `set_component` | checkpoint decision (49) | `scene.json` (58) | B02, B08 |
| 9 | **Checkpoint safe-spawn reference (PR-1)** | `setComponent(zone,"gameZone",{role:"checkpoint",safeSpawnId})` with an existing `playerSpawn` entity | `setComponent` | `queryEntity` (zone), `queryEntities{component:"playerSpawn"}` | 56 checkpoint inspector | `set_component` | reset R1 resolves the safe spawn (50) | `scene.json` (58) | B02, B07 |
| 10 | Player spawn marker (start + safe) | `createEntity({components:{playerSpawn:{}}})` or `setComponent(e,"playerSpawn",{})` | `setComponent(e,"playerSpawn",null)` | `queryEntities{component:"playerSpawn"}` | 56 spawn tool | `set_component` | reset destination (50) | `scene.json` (58) | B02, B07 |
| 11 | **Checkpoint activation appearance (PR-1)** | `setComponent(zone,"gameZone",{…,activation:{emissive,emissiveIntensity,cueAssetId}})` | `setComponent` | `queryEntity` | 57 checkpoint appearance | `set_component` | `GameView.checkpointActive` bit + cue (52/53) | `scene.json` + `manifest.media` (58) | B02, B08 |
| 12 | Camera-follow settings | `setComponent(cameraEntity,"cameraFollow",{…})` | `setComponent` | `queryEntity` | 56 camera panel | `set_component` | follow/dead-zone/clamp (51) | `scene.json` (58) | B02, B10 |
| 13 | Directional key light | `createEntity({components:{light:{type:"directional",…}}})` or `setComponent` add | `setComponent` | `queryEntities{component:"light"}` | 57 light panel | `set_component` | not gameplay (presentation only) | `scene.json` realized by 52 (58) | B02, B11 |
| 14 | Ambient fill light | same with `type:"ambient"` | `setComponent` | `queryEntities{component:"light"}` | 57 light panel | `set_component` | presentation only | `scene.json` (58) | B02, B11 |
| 15 | Primitive surface values | `createEntity({…,surfacePreset})` or `setComponent(e,"surface",{…})` | `setComponent` | `queryEntity` | 57 material panel | `set_component` | presentation only | `scene.json` (58) | B02, B11 |
| 16 | Three built-in presets (matte-ground / hazard / beacon) | `applySurfacePreset` | `applySurfacePreset` (another preset) / `setComponent` | `queryEntity` | 57 preset buttons | `apply_surface_preset` | presentation only | `scene.json` (58) | B02, B11 |
| 17 | Model animation profile (idle/run/airborne) | `setComponent(modelEntity,"modelAnimation",{assetId,version,roles})` | `setComponent` | `queryEntity` | 57 animation panel | `set_component` | committed role selector (53) | `manifest.media.animation` (58) | B02, B14 |
| 18 | Audio asset kind + bytes | `publishAsset` (`mode:"create"`, `kind:"audio"`) after stage/inspect/blob | `publishAsset` (`mode:"reimport"`, same kind) | `queryAssets` (kind), `readBlob` | 57 import/cue panel | `publish_asset` | injected audio owner (54) | declared WAV + `manifest.assets.kind` (58) | B02, B12 |
| 19 | Gameplay settings (M2 six keys) | `setSettings` (accepted) | `setSettings` | `queryProject.settingsKeys` | 56 settings panel | `set_settings` | controller **and** physics config (58 §3.3) | `manifest.settings` + `settingsDigest` (58) | B02, B16 |
| 20 | Decoration prefab + two independent copies | `createPrefab` then `instantiatePrefab` | `instantiatePrefab` (new copies) | `queryPrefabs`, `queryEntity` | 57 prefab panel | `create_prefab`/`instantiate_prefab` | copied model refs (49) | `scene.json` + declared GLB (58) | B02, B17 |
| 21 | Model asset import/reimport | `publishAsset` (`kind:"model"`) | `publishAsset` reimport (with `animation` when referenced) | `queryAssets`, `readBlob` | 57 import panel | `publish_asset` | loaded GLB (52/53) | declared GLB + `manifest.assets` (58) | B02, B17 |

Rows 2/9/11 are the plan-review PR-1 values. No row lacks a creation path; rows
13–17 have no gameplay effect by design (presentation only) and are still
created through the same shared command surface (B02).

## 2. Plan-review PR-1 values — creation path and proof

| PR-1 value | Contract owner | Creation op (exact) | Stored at | Rendered/consumed by | Export | Acceptance |
|---|---|---|---|---|---|---|
| Under-title instructions text | 39 (`model.md` §23.4, 320-char bound) | `setGameConfig({instructions})` — **create**, not a `game-host` constant | `content.game.instructions` in the v3 envelope | 55 HUD text node; 56 authors it | `manifest.game` embedded, hash-bound by `gameDigest`/`buildId` | B02, B04, B15 |
| Per-checkpoint respawn reference | 39 (`model.md` §23.3.1 `safeSpawnId`) | `setComponent(zoneId,"gameZone",{role:"checkpoint",safeSpawnId,activation})` — create requires both checkpoint fields | `components.gameZone.safeSpawnId` | 50 reset transaction R1 reads exactly that reference | `scene.json`; `manifest.game` names entities only | B02, B07 |
| Checkpoint activation appearance | 41 (`presentation.md` §41.5) — 39 owns the slot | `setComponent(zoneId,"gameZone",{…,activation})` — the value is created in the same command as the checkpoint | `components.gameZone.activation` | 52 material-instance write driven by `GameView.checkpointActive`; 53 cue; 57 authors | `scene.json`; the bit is runtime state, never persisted | B02, B08 |

A `game-host` local constant for the instructions string is **not** taken:
`model.md` §23.4 owns the field and the fixtures create it through
`setGameConfig`. Session HUD text alone is explicitly not the activation
appearance (`m3-plan.md` §2.1).

## 3. Acceptance row → owner chain

`Owning packets` below is copied verbatim from `m3-acceptance.md` §2; the audit
checker compares the two. `Contract rows` are the Gate K inventory ids that must
be accepted before the row can be implemented; `Creation/authoring path` names
the §1 rows that carry the authored inputs.

| Row | Owning packets | Contract rows (this pack) | Creation / authoring path | Runtime → export | In-container evidence status |
|---|---|---|---|---|---|
| B01 | 39, 44, 46, 62 | PM1…PM19, W1…W9 | migration operator only (no authoring value) | workspace envelope → old-path export | UNVERIFIED (44/46/62) |
| B02 | 39, 45, 48, 56, 61 | C1…C14, CMD41-1…3 | §1 rows 1–21 | every value reaches runtime/export per §1 | UNVERIFIED (real UI/MCP is 56/61) |
| B03 | 45, 48, 56–57, 61 | C1…C14, CMD41-1…3 | §1 rows 1–21 (edit/remove) | command pipeline → envelope | UNVERIFIED |
| B04 | 49, 55, 59, 61–62 | R40-*, R42-*, D42-* | §1 rows 1, 2 | `awaitingStart` → 55 HUD → 59 preview | UNVERIFIED (browser path exists) |
| B05 | 49, 61–62 | R40-8, R40-15 | §1 rows 6, 7, 10 (layout) | accepted controller → 49/60 | UNVERIFIED |
| B06 | 40, 49–50, 61 | R40-7, R40-12, R40-15 | §1 rows 4, 6 | swept predicate → 49/50 | UNVERIFIED |
| B07 | 50–51, 61–62 | R40-12, R40-13, R40-15 | §1 rows 9, 10 | reset transaction → 50/51 | UNVERIFIED (real Rapier) |
| B08 | 49–50, 55, 61–62 | R40-15, PM41-1 (bit) | §1 rows 7, 8, 11 | checkpoint decision → 52/53/55 | UNVERIFIED |
| B09 | 49–50, 55, 59, 62 | R40-13, R42-3 | §1 rows 1–4 | fail-stop lifecycle | UNVERIFIED |
| B10 | 40, 51, 59, 61–62 | R40-6, R40-10, R40-15 | §1 rows 4, 12 | camera math → 51/59 | UNVERIFIED (numeric fixtures only) |
| B11 | 41, 52, 57, 61–62 | PM41-*, R41-* | §1 rows 13–16 | adapter realization → 52/57 | UNVERIFIED (subscription: executed browser at 52/57) |
| B12 | 41, 47–48, 54, 57–60 | PM41-2…PM41-4, CMD41-1…3 | §1 rows 5, 18 | inspection → publication → audio owner | UNVERIFIED (decode executable in-container; audibility not) |
| B13 | 38, 54–55, 59–62 | R41-1, R42-3, S42-5 | §1 row 5 | cue events → 54 audio owner | UNVERIFIED — **audibility** (no audio device) |
| B14 | 41, 47, 53, 57, 61 | PM41-1, PM41-4, CMD41-2 | §1 row 17 | role selector → 53 | UNVERIFIED |
| B15 | 55, 59, 61–62 | S42-10, R42-3 | §1 rows 1, 2 | HUD text nodes → 55/59 | UNVERIFIED — **physical device**; DOM HUD executable |
| B16 | 42, 58–60, 61 | R42-1, R42-2, S42-7, E42-7 | §1 row 19 | settings → controller **and** physics (58 §3.3) | UNVERIFIED (fixture is an identity) |
| B17 | 45, 48, 56–57, 61 | C1…C14, CMD41-2 | §1 rows 17, 20, 21 | prefab/import workflow | UNVERIFIED |
| B18 | 46, 48, 61–62 | W1…W9 | no new authoring value | one-envelope durability + source backup | UNVERIFIED (real SIGKILL is 46) |
| B19 | 58–60, 62 | S42-7, E42-*, D42-* | §1 rows 1–21 (captured) | closure builder | UNVERIFIED |
| B20 | 42, 48, 59, 62 | S42-1, S42-5, S42-11 | §1 rows 3, 4 | relay → preview | UNVERIFIED (no-browser failure is a real negative) |
| B21 | 58, 60, 62 | E42-1…E42-6, PM43-3 | §1 rows 5, 13–21 | export closure | UNVERIFIED |
| B22 | 59–62 | S42-11, R40-15 | §1 rows 1–21 | preview/export parity | UNVERIFIED — **physical keyboard/gamepad**; scripted keys executable |
| B23 | 54, 58–60, 62 | E42-8, S42-9 | no new authoring value | two-tree reproducibility | UNVERIFIED |
| B24 | 61–62 | PM43-3, S42-4/S42-8 | sample recipe (61) | sample recreation | UNVERIFIED |

**Honest browser feasibility (packet 38, not re-measured here).** The container
has a real headless Chrome-for-Testing/SwiftShader path: DOM/HUD, canvas
`toDataURL` pixels, console/network, resize, lifecycle, WAV decode and
preview/export loading are executable and must be **executed** by the owning
packets. It has **no physical gamepad, no audio device, no display and no
hardware GPU**; audible output (B13), physical keyboard/gamepad playthroughs
(B15/B22) and hardware-GPU claims stay **UNVERIFIED** with the owner manual annex
(`m3-acceptance.md` §5). **No browser or hardware row is PASS in this file;**
packet 43 ran no browser.

## 4. Cross-cutting ownership statements

- **One authoring path.** Every §1 value is created by exactly one op on the
  shared command surface (`authoring.md` §A2); no value has a side file, a JSON
  patch or a sample-only bootstrap. `content.game` has exactly one writer
  (`setGameConfig`); zones/spawns/lights/surfaces/animation profiles have one
  writer (`setComponent`, add or create-time `components`); audio/model bytes
  have one writer (`publishAsset`); presets have one op (`applySurfacePreset`).
- **One runtime owner.** Run state, events, reset and the view belong to
  `runtime`/`platformer-game` (`gameplay.md` §3.4); presentation resources belong
  to `three-adapter`/`game-host` (`presentation.md` §41.6); the run never writes
  authoring state.
- **One export identity.** `manifest.json` (`manifestVersion` 2) is the single
  structural input and embeds `settings`/`game`/`media`; `snapshotId`, `buildId`
  and `outputDigest` stay distinct (`delivery.md` §2.1/§2.4).
- **No second mutable document, artifact class or command path** is claimed by
  any row above.

**PROPOSED — not accepted.** Packet 39, part **39-B**
(`docs/planning/m3-packets.md` §39). This document proposes normative text for the
**commands** additions listed in [`diffs/commands.md`](diffs/commands.md): the
create/add/edit/remove/query surface for every value of
[`model.md`](model.md), plus the UI/MCP authorability table. Nothing in
`docs/contracts/**` is changed; the data model is 39-A
([`model.md`](model.md), [`storage.md`](storage.md)).

Read basis: `commands.md` §§2/3.1/5.1/5.3/5.4/6/8.x/9.1; `project-model.md`
§§6/10/18/20/21; `m3-sample.md` §§2–4; `m3-acceptance.md` rows B02/B03/B12/B16/
B17/B18; `packets 48/56/57` titles (surfaces only).

---

## A1 Scope and ownership

Command-layer only. Every new value has exactly one mutation path and one owning
op; no op accepts a value it does not own; no JSON-Patch, eval, batch or
caller-supplied-document path exists. Scene mutation still happens only through
`applyMutation`; the workspace remains the sole executor (accepted pipeline
§6.1). Media bytes/import fields are packet 41's; this document owns the typed
edits and their `change`/inverse/no-change semantics.

## A2 Command set additions (extends §2)

| Op | Kind | Effect | Revision |
|---|---|---|---|
| `createEntity` | mutation | **extended args** (§A3.1): optional add-capable `components` and `surfacePreset`; derived-ID prefix rule extended (§A4.1) | +1 |
| `setComponent` | mutation | **extended component union** (§A3.2): `box, camera, model, collider, controller, gameZone, playerSpawn, cameraFollow, light, surface, modelAnimation` | +1 |
| `applySurfacePreset` | mutation | **new** (§A4.4): copy one built-in preset's five values onto an entity's `surface` component | +1 |
| `setGameConfig` | mutation | **new** (§A4.5): create, partially edit or remove `content.game` | +1 |
| `publishAsset` | mutation | **extended args** (§A5): `kind` on create; `asset_kind_mismatch` on reimport kind change | +1 |
| `queryGameConfig` | query | **new** (§A7): the full `content.game` block or `null` | — |
| `queryEntities` | query | **extended args** (§A7): optional `component` filter | — |
| `queryProject` | query | **extended result** (§A7): content summary gains `game` (+ `audioAssets`) | — |

Non-goals added: no new entity **kind** and no change to the closed
`createEntity.kind` union `{"group","box","model"}` (justification §A3.1); no
camera creation; no game-config side file; no cue command separate from
`setGameConfig`; no asset deletion; no per-checkpoint script.

## A3 `args` per operation

### A3.1 `createEntity` (extended)

| Field | Type / constraint | Required |
|---|---|---|
| `kind` | `"group"` \| `"box"` \| `"model"` — **the accepted closed union is unchanged** | yes |
| `parentId`, `name`, `transform`, `box`, `model` | accepted §3.1 semantics, unchanged | accepted |
| `components` | object; keys ⊆ `{ "collider", "controller", "gameZone", "playerSpawn", "cameraFollow", "light", "surface", "modelAnimation" }`; each value is the corresponding §A3.2 add value (never `null`); at most 8 keys | no |
| `surfacePreset` | one of `"matte-ground" \| "hazard" \| "beacon"`; **only** with `kind` in `{box, model}` and **not** together with `components.surface` | no |

**Why components, not new kinds.** `commands.md` §2 intentionally closes
`createEntity.kind` to three geometry kinds and forbids camera creation. A
gameplay zone, spawn marker, light, surface or animation profile is not a new
geometry kind — it is a value that can sit on any holder entity, exactly like the
accepted `collider`/`controller` (which are components with add/edit/remove via
`setComponent`). Making them components keeps one registry, one canonical order,
one `setComponent` change/inverse shape and one projection path, and avoids new
ID-prefix kinds, new snapshot semantics and a parallel creation API. The M2
authoring-gap failure mode is fixed by accepting `components` **at creation**, so
a zone/spawn/light never requires a separate "then add the component" step that a
UI could omit.

Validation order (normative, fail-fast): request envelope (§3/§6.1) →
`kind` ∈ union → `components` key set (unknown key ⇒ `component_unknown`) →
`surfacePreset`/`components.surface` mutual exclusion (`field_value`) →
`parentId` resolves (`reference_missing`) → per-component values in the §A3.2
order → resulting scene rules ([`model.md`](model.md) §23.8) → limits → no-change
impossible for a create (a create always changes state; an empty request is
still a create).

### A3.2 `setComponent` (extended union)

`component ∈ { box, camera, model, collider, controller, gameZone, playerSpawn,
cameraFollow, light, surface, modelAnimation }`. `transform`, `behavior` and
`prefab` remain rejected (`field_value`) — unchanged.

| `component` | Accepted value (partial field replacement) | Add / edit / remove |
|---|---|---|
| `box`, `camera`, `model` | accepted §8.10 | edit only (accepted) |
| `collider`, `controller` | accepted §8.10 | add / edit / remove (`null`) |
| `gameZone` | `role`, `size`, `safeSpawnId`, `activation` ([`model.md`](model.md) §23.3.1) | add / edit / remove |
| `playerSpawn` | exactly `{}` | add (`{}`) / remove (`null`); no field edit |
| `cameraFollow` | `deadZone`, `smoothing`, `bounds` | add / edit / remove |
| `light` | `type`, `color`, `intensity`, `direction`, `castShadow` | add / edit / remove |
| `surface` | `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity` | add / edit / remove (a preset is §A4.4) |
| `modelAnimation` | `assetId`, `version`, `roles` | add / edit / remove |

Rules: a present field replaces the whole field; adding a `gameZone` with
`role: "checkpoint"` **requires** `safeSpawnId` and `activation` in the same
value (`field_missing` otherwise); switching `role` from `checkpoint` to another
role in one edit must drop both checkpoint fields, else `field_unexpected` (they
are present-but-forbidden); switching **to** `checkpoint` must add them; changing
a `light.type` from `directional` to `ambient` in one edit must drop
`direction`/`castShadow` (present-but-forbidden ⇒ `field_value`). `null` removes
the component for the six add-capable v3 components; removal of a referenced
spawn/controller/cameraFollow is `game_reference_in_use`
([`model.md`](model.md) §23.6).

Validation order (normative, per op): request envelope → `entityId` resolves
(`entity_not_found`) → `component` ∈ union → target-carries rule for
edit-only components (`component_missing`) → value shape (`field_*`) →
component-presence/conflict rules (`component_conflict`) → component field
validation (`number_out_of_range`, `field_value`, `zone_transform_unsupported`,
`spawn_transform_unsupported`) →
resulting scene + cross-block validation ([`model.md`](model.md) §23.8) →
reference-in-use checks (§23.6) → limits → no-change → durability.

### A3.3 `applySurfacePreset`

`args: { entityId: <existing entity id>, preset: "matte-ground" | "hazard" | "beacon" }`.

- Preconditions: `entityId` resolves; the entity carries `box` or `model`
  (`component_missing`, `expected: "box|model"`); `preset` is one of the three.
- Effect: the entity's `surface` component is created if absent or replaced
  wholesale with the frozen row of [`model.md`](model.md) §23.3.5 — all five
  fields, one atomic edit, one revision, one history entry.
- No preset id is persisted; a later `setComponent` edit of `surface` fields
  changes only that entity's copy.

### A3.4 `setGameConfig`

`args: { game: <GameConfig> | null }`.

- `content.game === null` and `game` is an object: **create**; the value must be
  a **complete** canonical `GameConfig` (all §23.4 fields; every reference
  resolves). A partial object here ⇒ `field_missing`.
- `content.game !== null` and `game` is a non-empty object: **partial edit**;
  each present top-level field replaces the whole field (`level` and `cues` are
  replaced whole, not merged); `changedFields` lists the replaced names.
- `game: null`: **remove** the block (legal; frees all its references).
- Any other value ⇒ `field_type`/`field_value`. Unknown fields ⇒
  `field_unexpected`. Empty object with a non-null block ⇒ `field_value`.

Validation order: request envelope → `game` type (`null` or object) → if create,
completeness; if edit, non-empty → field shapes/string bounds/`level`/`killY`
([`model.md`](model.md) §23.4) → reference resolution and role rules (player,
camera, cameraFollow, spawn, ≥1 goal, ≤1 checkpoint, cue kinds) →
`game_bytes` ≤ 16 384 → resulting document validation → no-change → durability.

### A3.5 `publishAsset` (extended)

`args` gains `kind`:

| Field | Rule |
|---|---|
| `kind` | `"model"` \| `"audio"`. **Required on `mode: "create"`** (`field_missing` otherwise). On `mode: "reimport"` it is optional; when present it must equal the record's `kind`, else `asset_kind_mismatch`. A create with a duplicate `assetId` is `asset_id_duplicate` (accepted); a reimport of an unknown id is `asset_not_found` (accepted). |

The `assetId`-to-kind binding is immutable: no reimport can turn a model into an
audio asset or vice versa. `importRecipe`/`metrics` profile fields for `audio`
are packet 41's; the limit names `audio_assets`/`audio_versions` are
[`model.md`](model.md) §23.10. Publication ordering, dedup-before-stage-lookup and
the blob-before-envelope discipline are the accepted §8.5/§13.3 rules, unchanged.

## A4 Per-operation semantics

### A4.1 Derived entity-ID prefix (extends §8.1 step 2/4)

For a created entity (including `components` in the same request) the derived
prefix is the **first** match in this order: `model` (carries `model`) → `box`
(carries `box`) → `zone` (carries `gameZone`) → `spawn` (carries `playerSpawn`)
→ `light` (carries `light`) → `group`. The smallest free `<prefix>-NNNN` in
`0001..9999` is assigned, checking the live scene plus IDs allocated earlier in
the same transaction (accepted rule). `id_exhaustion` now carries the extended
`kind` union. `camera` is never allocatable (accepted). A group carrying only
`cameraFollow`/`surface`/`modelAnimation`/`collider`/`controller` keeps the
`group` prefix.

### A4.2 Change, inverse, no-change (additions to §5.3/§9.1)

| Op | `change` | Inverse |
|---|---|---|
| `createEntity` (with components) | `{ type: "createEntity", id, entity }` — full entity with all components (accepted shape) | `{ kind: "delete", rootId: id }` (accepted) |
| `setComponent` (v3 components) | `{ type: "setComponent", id, component, previous, next, changedFields }` — accepted shape; `previous`/`next` full component values or `null`; `changedFields` in the component's canonical field order | `{ kind: "setComponent", id, component, restore: previous }` (accepted) |
| `applySurfacePreset` | `{ type: "applySurfacePreset", id, preset, previous, next, changedFields }` — `previous`/`next` full `surface` values (`previous: null` when the component was absent), `changedFields` = `["color","roughness","metalness","emissive","emissiveIntensity"]` | `{ kind: "setComponent", id, component: "surface", restore: previous }` |
| `setGameConfig` | `{ type: "setGameConfig", previous, next, changedFields }` — full blocks or `null`; `changedFields` = replaced top-level names in canonical order | `{ kind: "setGameConfig", restore: previous }` |

No-change rule (extends §6.5): the mutation is `no_change` when the resulting
canonical scene+content bytes are identical with `revision` masked — e.g.
`setComponent` with the values already present, `applySurfacePreset` on an
entity already carrying exactly that preset row, `setGameConfig` with an equal
block. `createEntity` never yields `no_change`.

Stale/conflict ordering (unchanged, restated): envelope validation → request
digest → **stale revision** (`revision_conflict`) → retry dedup
(`request_id_reused`) → pause check → apply → no-change → durability. As accepted
§6.5 states, `no_change` is reported as a validation-class **failure** that
carries no change and leaves the envelope bytes and the revision unchanged; the
new ops follow that rule exactly (they are never a silent success).

One revision and one history entry per success (accepted §5.1/§9.1). `undo`
applies the recorded inverse; `redo` re-applies the recorded `change` with
recorded values (no ID rescan for `createEntity`; `applySurfacePreset`’s redo
re-applies the recorded `next` surface value — the recorded-value rule). Every
success returns the new `revision`, the `change`, the `createdId` for creates,
and `history` depths.

### A4.3 Module boundary

All §A3/§A4 logic is pure (`commands` → `project-model` only). The workspace
executes the pipeline and writes one envelope per success. Media bytes never
enter a command request. No op writes `content.game` outside `setGameConfig`.

## A5 Prefab semantics (unchanged, restated for v3)

1. **Copy-on-instantiation is kept.** `instantiatePrefab` materializes independent
   copies; definition values are materialization sources, not links. Editing one
   copy cannot change another or the definition.
2. **Zones, `controller`, cameras and lights are not silently capturable.** The
   definition entity vocabulary stays exactly `{transform, model, box, behavior}`
   ([`model.md`](model.md) §23.3 adds no definition component). Capturing a
   subtree containing `gameZone`, `playerSpawn`, `cameraFollow`, `camera`,
   `light`, `collider` or `controller` is rejected with the accepted
   `prefab_component_forbidden` (`component` names the offending component) or
   `prefab_camera_capture_forbidden` for the camera; a nested prefab instance is
   `prefab_nested_forbidden`. The rejection is computed on the capture closure
   and nothing is written.
3. **Copied model references keep stable asset IDs.** Instantiation copies
   `components.model.asset.assetId` verbatim (accepted remap rules apply only to
   local entity-ID references). `surface` is *not* in the definition vocabulary,
   so a copied model gets no surface unless the caller adds one afterwards. No
   v3 component is captured, so no v3 reference is remapped and no animation
   profile is duplicated by accident.
4. Decoration prefabs (the sample's beacon/pillar) use the accepted
   `{transform, model}` definition with two independent copies.

## A6 Queries

- `queryGameConfig`: `{ ok, projectId, revision, game }` — the full normalized
  `GameConfig` or `null`; no page args; no mutation fields.
- `queryEntities` gains optional `component`: one of the accepted component names
  (v1/v2/v3 registry). When present, the page contains only entities carrying
  that component, still in document order; `total` counts the filtered set.
  Unknown component name ⇒ `field_value`. `limit ≤ 1024` (accepted).
- `queryProject` content summary becomes
  `{ assets, audioAssets, prefabs, behaviors, settingsKeys, game, zones, spawns }`
  — counts only, except `game` which is a boolean (`content.game !== null`).
  Never returns block contents, bytes or definitions.
- `queryEntity`/`queryAsset(s)` are unchanged and already expose full components
  and asset `kind`; the UI/MCP table (§A8) uses them for per-value reads.
- Queries are read-only, carry no `expectedRevision`/`requestId`, are never
  deduplicated and observe the last acknowledged state (accepted §2/§5.6).

## A7 Error codes (additions to §5.4)

`game_reference_missing`, `game_reference_in_use`, `zone_transform_unsupported`,
`spawn_transform_unsupported`, `zone_checkpoint_count_invalid`,
`zone_goal_missing`, `asset_kind_mismatch`,
`game_config_invalid` ([`model.md`](model.md) §23.9), plus the extended
`limits_exceeded` names (`zones`, `player_spawns`, `lights_directional`,
`lights_ambient`, `audio_assets`, `audio_versions`, `game_bytes`,
`animation_profile_bytes`) and the extended `id_exhaustion` kinds. No accepted
code changes meaning or carries-shape. `component_conflict` carries `reason`
where a v3 rule adds one (`animation_asset`).

## A8 Authorability table (every value → create → edit → query → UI → MCP → acceptance)

`UI` = packet 56 (gameplay/camera) or 57 (media/lighting/animation); `MCP` =
packet 48 typed tool. **Every row has a creation path.**

| # | Sample value | Create op | Edit / remove op | Query path | UI | MCP | Acceptance |
|---|---|---|---|---|---|---|---|
| 1 | Game config block (title, objective) | `setGameConfig` (complete, when `game === null`) | `setGameConfig` (partial), `null` to remove | `queryGameConfig`, `queryProject.game` | 56 title panel | `set_game_config` | B02, B04 |
| 2 | **Instructions string** (PR-1) | `setGameConfig.instructions` | `setGameConfig` | `queryGameConfig` | 56 title panel text field | `set_game_config` | B02, B04, B15 |
| 3 | Player / camera / start-spawn references | `setGameConfig` (create) | `setGameConfig` | `queryGameConfig` | 56 reference pickers | `set_game_config` | B02, B07 |
| 4 | Level bounds / `killY` | `setGameConfig` | `setGameConfig` | `queryGameConfig` | 56 bounds fields | `set_game_config` | B02, B06, B10 |
| 5 | Cue assignment (start/jump/checkpoint/death/goal) | `setGameConfig.cues` | `setGameConfig` | `queryGameConfig`, `queryAssets` | 57 cue pickers | `set_game_config` | B02, B12 |
| 6 | Hazard zone | `createEntity({kind:"group", components:{gameZone:{role:"hazard",size}}})` **or** `setComponent(e,"gameZone",…)` (add) | `setComponent` (edit/remove) | `queryEntities{component:"gameZone"}`, `queryEntity` | 56 zone tool | `set_component` | B02, B06 |
| 7 | Goal zone | same, `role:"goal"` | `setComponent` | `queryEntities{component:"gameZone"}` | 56 zone tool | `set_component` | B02, B08 |
| 8 | Checkpoint zone | same, `role:"checkpoint"` + required `safeSpawnId`/`activation` | `setComponent` | `queryEntities{component:"gameZone"}` | 56 zone tool | `set_component` | B02, B08 |
| 9 | **Checkpoint safe-spawn reference** (PR-1) | `setComponent(zone,"gameZone",{role:"checkpoint",safeSpawnId})` with an existing `playerSpawn` entity | `setComponent` | `queryEntity` (zone), `queryEntities{component:"playerSpawn"}` | 56 checkpoint inspector | `set_component` | B02, B07 |
| 10 | Player spawn marker (start + safe) | `createEntity({components:{playerSpawn:{}}})` or `setComponent(e,"playerSpawn",{})` | `setComponent(e,"playerSpawn",null)` to remove | `queryEntities{component:"playerSpawn"}` | 56 spawn tool | `set_component` | B02, B07 |
| 11 | **Checkpoint activation appearance** (PR-1) | `setComponent(zone,"gameZone",{…,activation:{emissive,emissiveIntensity,cueAssetId}})` | `setComponent` | `queryEntity` | 57 checkpoint appearance | `set_component` | B02, B08 |
| 12 | Camera-follow settings | `setComponent(cameraEntity,"cameraFollow",{…})` | `setComponent` | `queryEntity` | 56 camera panel | `set_component` | B02, B10 |
| 13 | Directional key light | `createEntity({components:{light:{type:"directional",…}}})` or `setComponent` add | `setComponent` | `queryEntities{component:"light"}` | 57 light panel | `set_component` | B02, B11 |
| 14 | Ambient fill light | same with `type:"ambient"` | `setComponent` | `queryEntities{component:"light"}` | 57 light panel | `set_component` | B02, B11 |
| 15 | Primitive surface values | `createEntity({…,surfacePreset})` or `setComponent(e,"surface",{…})` | `setComponent` | `queryEntity` | 57 material panel | `set_component` | B02, B11 |
| 16 | Three built-in presets (matte-ground / hazard / beacon) | `applySurfacePreset` | `applySurfacePreset` (another preset) / `setComponent` (fields) | `queryEntity` | 57 preset buttons | `apply_surface_preset` | B02, B11 |
| 17 | Model animation profile (idle/run/airborne roles) | `setComponent(modelEntity,"modelAnimation",{assetId,version,roles})` | `setComponent` | `queryEntity` | 57 animation panel | `set_component` | B02, B14 |
| 18 | Audio asset kind + bytes | `publishAsset` (`mode:"create"`, `kind:"audio"`) after stage/inspect/blob (accepted) | `publishAsset` (`mode:"reimport"`, same kind) | `queryAssets` (kind), `readBlob` | 57 import/cue panel | `publish_asset` | B02, B12 |
| 19 | Gameplay settings (M2 six keys) | `setSettings` (accepted) | `setSettings` | `queryProject.settingsKeys` | 56 settings panel | `set_settings` | B02, B16 |
| 20 | Decoration prefab + two independent copies | `createPrefab` then `instantiatePrefab` (accepted) | `instantiatePrefab` (new copies); no update | `queryPrefabs`, `queryEntity` | 57 prefab panel | `create_prefab`/`instantiate_prefab` | B02, B17 |
| 21 | Model asset import/reimport | `publishAsset` (`kind:"model"`) | `publishAsset` reimport | `queryAssets`, `readBlob` | 57 import panel | `publish_asset` | B02, B17 |

No row lacks a creation path; rows 2/9/11 are the plan-review PR-1 values and are
proven at packet 43's matrix. `entities`/`content` limits and every error in §A7
have negative fixtures (§A9).

## A9 Fixtures

`fixtures/m3/contracts/commands/`: a byte-exact before/messages/after scenario
covering `createEntity`+components, `setComponent` add/edit/remove,
`applySurfacePreset`, `setGameConfig` create/edit/remove, undo/redo with exact
revision and IDs; a `no-change` case; and a `failures.json` set where each entry
isolates one reachable failure (code, path, limit). `index.json` records SHA-256
and expectations; `tools/check-fixtures.mjs` replays revision/history arithmetic,
ID allocation, inverse/redo equality and no-change.

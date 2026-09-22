**PROPOSED — not accepted.** Packet 39, part **39-A**
(`docs/planning/m3-packets.md` §39). This document proposes normative text for
**project-model §23** and the small edits to §§6/8/10/12/13/17/18/19/20/21 listed
in [`diffs/project-model.md`](diffs/project-model.md). Nothing in
`docs/contracts/**` is changed; Gate K records accept/reject per diff, and a
separate docs-only promotion applies accepted rows before packet 44. Read with
[`storage.md`](storage.md) (envelope v3 + v2→v3 migration),
[`authoring.md`](authoring.md) (command surface) and
[`baseline.md`](baseline.md) (packet-38 findings). The packet-38 CSP finding is
**not** handled here (packet 42 owns `sessions.md` §17.4).

Read basis: `AGENTS.md`; `docs/STATUS.md`; `planning/m3-plan.md` §§2/2.1/3.1/4/5;
`planning/m3-packets.md` §39 + "Contract drafting and promotion";
`planning/m3-sample.md`; `planning/m3-acceptance.md` §2 rows B01/B02/B03/B12/B16/
B17/B18; `handoffs/38.md`; contracts `project-model.md` §§6/7/10/12/13/17/18/19/20/
21/22.4–22.5, `commands.md` §§2/3.1/5.3/5.4/8.x/9.1, `workspace.md` §§3/4.2/4.5/11/
13.9/14/15; public exports of `project-model`/`commands`/`workspace`.

---

## 23. M3 v3 data: scene schemaVersion 3 / storageVersion 3

### 23.0 Scope, ownership and which document is versioned

This section defines the v3 scene data, the game-configuration block and the
reference/deletion rules. It does **not** define runtime behaviour (packet 40),
media/import fields (packet 41) or the delivery manifest (packet 42).

**Naming rule (plan-review PR-4) — exactly one document moves per field:**

| Document | Version field | v2 value | v3 value | Owner of the v3 value |
|---|---|---|---|---|
| authoring manifest `project.json` (`project-model` §7) | `schemaVersion` | 1 | **1 (unchanged)** | this section; the authoring manifest is **not** the runtime manifest |
| authoring scene `scenes/main.json` embedded value | `schemaVersion` | 2 | **3** | this section |
| workspace envelope `scenes/main.json` top level | `storageVersion` | 2 | **3** | [`storage.md`](storage.md) §S3 |
| runtime-content export `manifest.json` (`sessions.md` §13, `export.md` §5) | `manifestVersion` | 1 | 2 | **packet 42** — not defined here; referenced only |

A reader must never infer one field from another. `storageVersion` versions the
envelope format, `scene.schemaVersion` versions the scene data,
`manifest.schemaVersion` versions the authoring manifest, and the export
`manifestVersion` versions the runtime-content delivery document.

### 23.1 Version taxonomy additions

`SCHEMA_VERSIONS_BY_DOCUMENT` becomes: manifest `[1]`; scene `[1, 2, 3]`.
Envelope `storageVersion` known set becomes `[1, 2, 3]`
([`storage.md`](storage.md) §S2). v1 and v2 readers/validators are unchanged and
remain selectable by their version.

### 23.2 Legal version combinations (supersedes nothing; adds one row)

The exhaustive combination table of `project-model` §6 and `workspace` §4.5 gains
exactly one passable row. `manifest 1 + scene 3 + storage 3` is the v3
combination; its envelope carries `content` with the additional required key
`game` ([`storage.md`](storage.md) §S3).

| `manifest.schemaVersion` | `scene.schemaVersion` | `storageVersion` | Result |
|---|---|---|---|
| 1 | 1 | 1 | **valid** — accepted M1 row, unchanged |
| 1 | 2 | 2 | **valid** — accepted M2 row, unchanged |
| 1 | 3 | 3 | **valid** — **new v3 row** (`content.game` present, `null` or an object) |
| 1 | 1 | 2 | `version_combination_unsupported` (accepted row, unchanged) |
| 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (accepted row, unchanged) |
| 1 | 1 | 3 | `version_combination_unsupported` — single error, checked before any scene/content field validation |
| 1 | 2 | 3 | `version_combination_unsupported` — single error |
| 1 | 3 | 1 | `version_combination_unsupported` — single error |
| 1 | 3 | 2 | `version_combination_unsupported` — single error |
| 2 | any | any | `manifest_invalid` → `schema_version_unsupported` — the authoring manifest stays `schemaVersion` 1 |
| any | any | ≥ 4 or ≤ 0 | `storage_version_unsupported` |
| any | ≥ 4 | any | `schema_version_unsupported` for that document |

Refusal is **non-destructive and non-repairing**: the combination error is a
single error at the envelope's `storageVersion` path, deeper scene/content checks
stop, the bytes are retained byte-identically, and no rewrite, normalization,
upgrade or downgrade occurs at open, on startup scan, or on any query. An
unsupported project is reported as unavailable with that code as the reason
(`workspace.md` §11).

### 23.3 Scene v3 component registry and canonical order

The v3 registry is the v2 registry plus six components, **appended in this
order** (no accepted component is renumbered or reinterpreted):

```text
transform, model, box, camera, behavior, prefab, collider, controller,
gameZone, playerSpawn, cameraFollow, light, surface, modelAnimation
```

`transform` remains required on every entity (`component_missing`). A component
name outside this list is `component_unknown`. Adding a component after v3
requires a new `schemaVersion` (§6/§17 — same-version extensions are forbidden).

Entity combinations added in v3 (all other accepted combinations unchanged):

| Combination | Meaning |
|---|---|
| `{ transform, gameZone }` / `+ box` / `+ model` / `+ surface` | gameplay zone, optionally with a visual marker |
| `{ transform, playerSpawn }` / `+ box` / `+ model` / `+ surface` | spawn marker, optionally with a visual marker |
| `{ transform, camera, cameraFollow }` | the single gameplay camera (the `camera` entity) |
| `{ transform, light }` / `+ box` / `+ model` | light entity |
| `{ transform, box, surface }` / `{ transform, model, surface }` | lit primitive/GLB surface values |
| `{ transform, model, modelAnimation }` | animated model instance |

### 23.3.1 `components.gameZone`

```ts
type GameZoneRole = 'hazard' | 'checkpoint' | 'goal';

interface CheckpointActivationAppearance {
  emissive: string;            // ^#[0-9a-f]{6}$ ; canonical lowercase
  emissiveIntensity: number;   // [0, 4]
  cueAssetId: string | null;   // null = use content.game.cues.checkpoint
}

interface GameZoneComponent {
  role: GameZoneRole;
  size: [number, number];      // [widthX, heightY] full extents, meters
  safeSpawnId?: string;        // REQUIRED iff role === 'checkpoint'
  activation?: CheckpointActivationAppearance; // REQUIRED iff role === 'checkpoint'
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `role` | string | yes | exactly `hazard` \| `checkpoint` \| `goal` | — |
| `size` | array of 2 finite numbers | yes | each `0 < v ≤ 1e6` (full extent, not half-extent) | — |
| `safeSpawnId` | string | iff `role === 'checkpoint'` | ID syntax; must resolve to an entity carrying `playerSpawn` | — |
| `activation` | object | iff `role === 'checkpoint'` | §23.3.1a | — |

Canonical key order: `role`, `size`, `safeSpawnId`, `activation` (present fields
only). `activation` key order: `emissive`, `emissiveIntensity`, `cueAssetId`.
Defaults are **not** filled for `activation` sub-fields: a checkpoint writes all
three fields explicitly (the normalizer never invents a presentation value).

Geometry and transform rules (normative):

- A zone is an **axis-aligned XY rectangle** centred on the entity's world
  position; half-extents are `size / 2`. Z is presentation depth only.
- A zone entity must be a **root** (`parentId` absent/`null`), at **unit scale**
  (`[1,1,1]` exactly) and with the **identity rotation** (`[0,0,0,1]`). A
  violation is `zone_transform_unsupported` carrying `path` and `reason`:
  `parented` / `scale` / `rotation` (§23.9). (Distinct from
  `spawn_transform_unsupported`, which is reserved for `playerSpawn`, and from
  `physics_transform_unsupported`, which stays reserved for
  `collider`/`controller`.)
- A zone never blocks movement and is never a physics body: `gameZone` with
  `collider` or `controller` on one entity is `component_conflict`.
- Zone overlays are authoring-only; nothing in the document marks an overlay as
  a game collider.

Counts: ≤ 64 `gameZone` entities per scene (`limits_exceeded` `zones`); ≤ 1 with
`role === 'checkpoint'` (`zone_checkpoint_count_invalid`); ≥ 1 with
`role === 'goal'` **when `content.game !== null`** (`zone_goal_missing`);
`hazard` count is bounded only by `zones`.

#### 23.3.1a `CheckpointActivationAppearance`

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `emissive` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | — |
| `emissiveIntensity` | number | yes | `[0, 4]` | — |
| `cueAssetId` | string or `null` | yes (may be `null`) | when non-null must resolve to an asset with `kind: "audio"` | — |

This is the plan-review PR-1 **activation-appearance slot**
(`m3-plan.md` §2.1): packet 41 owns the read-only presentation view bit the
adapter consumes and may extend or replace the value shape **by diff**; 39 owns
the slot's presence, requiredness, reference rule and canonical order. Session
HUD text alone is explicitly not this value.

### 23.3.2 `components.playerSpawn`

```ts
interface PlayerSpawnComponent { }   // field-less marker
```

- Canonical value: `{}` (exactly, no fields; unknown fields ⇒ `field_unexpected`).
- A spawn entity must be a **root** (`parentId` absent/`null`), at **unit scale**
  (`[1,1,1]` exactly) and with the **identity rotation** (`[0,0,0,1]`). A
  violation is `spawn_transform_unsupported` carrying `path`
  (`/scene/entities/<i>/parentId`, `/scene/entities/<i>/components/transform/scale`
  or `/scene/entities/<i>/components/transform/rotation`) and `reason`:
  `parented` / `scale` / `rotation` (§23.9). The rule mirrors the accepted
  `project-model.md` §21.2 physics-transform rule and the §23.3.1 zone rule
  exactly (same three conditions, same reason vocabulary); it is a **distinct
  code** from `zone_transform_unsupported` so a fixture or diagnostic names the
  bearer unambiguously. There is **no** `upright` reason for a spawn: the
  identity-rotation condition above is the whole tilt rule.
- `playerSpawn` with `gameZone`, `collider` or `controller` is
  `component_conflict`.
- ≤ 16 `playerSpawn` entities per scene (`limits_exceeded` `player_spawns`).
- The **start spawn** is the one named by `content.game.spawnId`; a
  **safe-checkpoint spawn** is one named by a checkpoint's `safeSpawnId`. A
  spawn not named by either is legal, unreferenced authoring data.

### 23.3.3 `components.cameraFollow`

```ts
interface CameraFollowComponent {
  deadZone: { x: number; y: number };                        // half-extents, meters
  smoothing: number;                                         // [0, 1]
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `deadZone` | object | yes | `x`, `y` finite, `0 ≤ v ≤ 1e6` | — |
| `smoothing` | number | yes | `[0, 1]`; `0` = hard snap | — |
| `bounds` | object | yes | finite, `|v| ≤ 1e6`, `minX < maxX`, `minY < maxY`, `maxX − minX ≥ 1e-6`, `maxY − minY ≥ 1e-6` | — |

Canonical key order: `deadZone`, `smoothing`, `bounds`; `deadZone`: `x`, `y`;
`bounds`: `minX`, `maxX`, `minY`, `maxY`.

- `cameraFollow` may appear **only** on the entity that carries `camera`
  (`component_conflict` otherwise — there is no parented or secondary camera in
  v3).
- When `content.game !== null`, the camera entity **must** carry
  `cameraFollow` (`game_reference_missing`, `reason: "camera_follow"`).
- The plan's camera **math** (fixed -Z view, Y up, clamp to frustum, hard snap,
  fixed-step smoothing) is packet 40's; this component stores data only.

### 23.3.4 `components.light`

```ts
interface LightComponent {
  type: 'directional' | 'ambient';
  color: string;                        // ^#[0-9a-f]{6}$
  intensity: number;                    // [0, 8]
  direction?: [number, number, number]; // directional only
  castShadow?: boolean;                 // directional only
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `type` | string | yes | `directional` \| `ambient` | — |
| `color` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | — |
| `intensity` | number | yes | `[0, 8]` | — |
| `direction` | array of 3 finite numbers | iff `type === 'directional'` | each `|v| ≤ 1`; `‖v‖ ≥ 1e-6`; **not** renormalized (the adapter normalizes a derived copy, like §10.1 quaternions) | — |
| `castShadow` | boolean | iff `type === 'directional'` (may be `false`) | — | `false` |

Canonical key order: `type`, `color`, `intensity`, `direction`, `castShadow`
(present fields only); `direction` is emitted only for `directional`. Present
`direction`/`castShadow` on an `ambient` light ⇒ `field_value`. A `light` entity
has no transform rule (it may be parented or scaled; only the value matters).

Counts: ≤ 1 `directional` (`limits_exceeded` `lights_directional`) and ≤ 1
`ambient` (`limits_exceeded` `lights_ambient`) per scene. The bounded one
key/fill shadow profile, the three primitive presets' realization and
shadow-degradation behaviour are packet 41/52's; v3 stores ordinary numbers.

### 23.3.5 `components.surface` and the three built-in presets

```ts
interface SurfaceComponent {
  color: string;              // ^#[0-9a-f]{6}$
  roughness: number;          // [0, 1]
  metalness: number;          // [0, 1]
  emissive: string;           // ^#[0-9a-f]{6}$
  emissiveIntensity: number;  // [0, 4]
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `color` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | `#b0b0b0` |
| `roughness` | number | yes | `[0, 1]` | `0.9` |
| `metalness` | number | yes | `[0, 1]` | `0` |
| `emissive` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | `#000000` |
| `emissiveIntensity` | number | yes | `[0, 4]` | `0` |

Canonical key order: `color`, `roughness`, `metalness`, `emissive`,
`emissiveIntensity`. `surface` may appear only on an entity carrying `box` or
`model` (`component_missing`, `expected: "box|model"`); `surface` + `camera` is
`component_conflict`.

The three built-in presets are **frozen value rows**, not linked resources
(copying a preset writes the five values; editing one copy cannot change another
or the table):

| Preset name | color | roughness | metalness | emissive | emissiveIntensity |
|---|---|---|---|---|---|
| `matte-ground` | `#6f6f6f` | `0.95` | `0` | `#000000` | `0` |
| `hazard` | `#d42a1e` | `0.55` | `0` | `#3a0703` | `0.35` |
| `beacon` | `#2f7fd4` | `0.4` | `0.1` | `#1bc8ff` | `1.2` |

Preset application is the `applySurfacePreset` mutation
([`authoring.md`](authoring.md) §A4.4): one edit, one history entry, one
revision, exact inverse. No preset id or asset reference is persisted.

### 23.3.6 `components.modelAnimation`

```ts
interface ModelAnimationComponent {
  assetId: string;    // must resolve in content.assets with kind === 'model'
  version: number;    // 1 ≤ version ≤ that record's currentVersion
  roles: {            // exactly these three keys, each an AnimationRoleBinding
    idle: AnimationRoleBinding;
    run: AnimationRoleBinding;
    airborne: AnimationRoleBinding;
  };
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `assetId` | string | yes | ID syntax; resolves to a `kind: "model"` record | — |
| `version` | integer | yes | `1 ≤ v ≤ currentVersion` of that record | — |
| `roles` | object | yes | exactly the keys `idle`, `run`, `airborne`; each an `AnimationRoleBinding`; canonical bytes ≤ 4096 | — |

Canonical key order: `assetId`, `version`, `roles`; `roles` in the fixed order
`idle`, `run`, `airborne`.

`AnimationRoleBinding` and its media fields are **packet 41's**
(`planning/m3-contracts/presentation.md`, project-model §24 proposal). 39 fixes
only: the role key set, all-three-required, that each binding is a non-empty JSON
object owned by that version, the `assetId`/`version` binding, and that no role
key may be added without a new `schemaVersion`. A binding is validated by
packet 41's rules; 39's load order validates the container first (§23.8).

- `modelAnimation` may appear only on an entity carrying `model`
  (`component_missing`, `expected: "model"`), and its `assetId` must equal that
  entity's `components.model.asset.assetId` (`component_conflict`,
  `reason: "animation_asset"`).
- This is the plan's **narrow exception** to `project-model` §18.1 rule 3
  (no persisted subresources): the binding is version-local and immutable, so a
  reordered reimport cannot create a false persistent reference. Packet 41
  supplies the exact replacement text for §18.1 rule 3; 39 does not.

### 23.3.7 `AssetRecord.kind` gains `audio`

`kind` becomes `"model" | "audio"` (`field_value` for anything else). All other
`AssetRecord`/`AssetVersion` rules (§§18.3/18.4) are unchanged: opaque
`assetId`, append-only `versions`, digest-addressed immutable bytes, no paths.
`kind` is fixed at create; a reimport that supplies a different `kind` for an
existing `assetId` is `asset_kind_mismatch` ([`authoring.md`](authoring.md) §A5).
The WAV import profile, decoded/PCM bounds and recipe fields for `audio` are
packet 41's; 39 fixes the discriminator, the cue-assignment data (§23.4) and the
limits `audio_assets` ≤ 16 / `audio_versions` ≤ 8 (§23.10). `components.model`
keeps resolving to `kind: "model"` only.

### 23.4 The game-configuration block `content.game`

One bounded block in the same content catalog — **no second mutable document, no
side-car file, no JSON blob**. In a v3 envelope the content key set is exactly
`assets, prefabs, behaviors, settings, behaviorTrust, game`; `game` is required
and is `null` or a `GameConfig`.

```ts
type CueRef = string | null;   // assetId (kind "audio") or null

interface GameConfig {
  configVersion: 1;
  title: string;         // 1–64 chars
  objective: string;     // 1–160 chars
  instructions: string;  // 1–320 chars
  playerId: string;      // entity id (the controller entity)
  cameraId: string;      // entity id (the camera + cameraFollow entity)
  spawnId: string;       // entity id (playerSpawn, the start spawn)
  level: { minX: number; maxX: number; minY: number; maxY: number };
  killY: number;
  cues: { start: CueRef; jump: CueRef; checkpoint: CueRef; death: CueRef; goal: CueRef };
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `configVersion` | integer | yes | exactly `1`; a shape change is a version change, not a same-version extension | — |
| `title` | string | yes | 1–64 chars, no control characters; display only | — |
| `objective` | string | yes | 1–160 chars, no control characters | — |
| `instructions` | string | yes | 1–320 chars, no control characters (no `\n`, no HTML, plain text only) | — |
| `playerId` | string | yes | must resolve to the scene's single `controller` entity | — |
| `cameraId` | string | yes | must resolve to the scene's single `camera` entity **carrying `cameraFollow`** | — |
| `spawnId` | string | yes | must resolve to an entity carrying `playerSpawn` | — |
| `level` | object | yes | `minX < maxX`, `minY < maxY`, each finite `|v| ≤ 1e6` | — |
| `killY` | number | yes | finite, `-1e6 ≤ v < level.maxY` | — |
| `cues` | object | yes | exactly the five keys; each `null` or an `assetId` resolving to `kind: "audio"` | all `null` (in a freshly created block the caller supplies them) |

Canonical key order: `configVersion`, `title`, `objective`, `instructions`,
`playerId`, `cameraId`, `spawnId`, `level`, `killY`, `cues`; `level`:
`minX`, `maxX`, `minY`, `maxY`; `cues`: `start`, `jump`, `checkpoint`, `death`,
`goal` (the sample's cue order — Start, jump, checkpoint, death, goal).

`instructions` is the plan-review PR-1 **bounded instructions string**
(`m3-plan.md` §2.1): 39 owns the field and its 320-char bound; it is authored
through `setGameConfig`, stored here and rendered as a text node by 55/56. It is
**not** a `game-host` constant.

`title`/`objective`/`instructions` are plain text: no HTML, markdown or markup is
interpreted; `<`, `>` and `&` are literal (the HUD must escape/insert as a text
node — packet 55's rule). No remote font or HTML is a v3 non-goal (§23.12).

### 23.5 Reference rules

Exactly one of each required role, and every reference resolves:

| # | Rule | Failure |
|---|---|---|
| 1 | ≤ 1 entity carries `controller` (accepted). When `content.game !== null`, **exactly one** is required and `game.playerId` must name it | `controller_count_invalid` (0 or ≥ 2) / `game_reference_missing` (`reason: "player"`) |
| 2 | exactly one entity carries `camera` (accepted); it must carry `cameraFollow` and be named by `game.cameraId` when `game !== null` | `camera_count_invalid` / `game_reference_missing` (`"camera"` / `"camera_follow"`) |
| 3 | `game.spawnId` resolves to a `playerSpawn` entity | `game_reference_missing` (`"spawn"`) |
| 4 | every checkpoint's `safeSpawnId` resolves to a `playerSpawn` entity | `game_reference_missing` (`"safe_spawn"`) |
| 5 | ≤ 1 `goal` zone when `game !== null` is **≥ 1**; checkpoints ≤ 1 (any time) | `zone_goal_missing` / `zone_checkpoint_count_invalid` |
| 6 | every `surface` sits on a `box`/`model` entity | `component_missing` |
| 7 | every `modelAnimation.assetId` equals its entity's `model` asset and `version` is in range | `component_conflict` (`"animation_asset"`) / `asset_version_invalid` |
| 8 | `components.model.asset.assetId` resolves to `kind: "model"` | `asset_reference_missing` / `asset_kind_mismatch` |
| 9 | every non-null cue asset reference and `activation.cueAssetId` resolves to `kind: "audio"` | `asset_reference_missing` / `asset_kind_mismatch` |
| 10 | no document contains a dangling reference of any kind after any load or command | (load) `reference_missing`/`game_reference_missing`; (command) rejection, never silent clearing |

What may reference what (closed):

- scene → content: `model.asset.assetId`, `modelAnimation.assetId`,
  `behavior.behaviorId`, `prefab.{prefabId,localId}`, cues/activation
  `assetId`s. Nothing else.
- scene → scene: `parentId` (accepted), `gameZone.safeSpawnId` (entities).
- content → scene: `game.playerId`/`cameraId`/`spawnId` — the **only** content
  block that may name entities. It is the sole reason deletion must consult the
  content block.
- There is **no** scene→export, scene→runtime, session, path, digest, URL, code
  or HTML reference; no second mutable document; no JSON blob field.

### 23.6 Deletion and mutation rules (rejection-first)

`deleteEntity` (accepted subtree deletion) gains a v3 reference check **before**
application, alongside the accepted camera/`entityRef` checks:

1. Compute the subtree closure as accepted. Reject with
   `game_reference_in_use` if the closure contains:
   - the entity named by `content.game.playerId`, `cameraId` or `spawnId`; or
   - the camera entity (already `camera_count_invalid`); or
   - any entity named by a checkpoint's `safeSpawnId`.
   `game_reference_in_use` carries
   `{ entityIds: [<closure ids>], references: [<JSON Pointer paths>] }` where each
   path is into the envelope document (`/game/playerId`,
   `/game/spawnId`, `/entities/<i>/components/gameZone/safeSpawnId`, …) and the
   list is in ascending codepoint order.
2. Component-level removals that would dangle a reference are rejected with the
   same code: `setComponent(entityId, 'playerSpawn', null)` for `game.spawnId` or
   a checkpoint's `safeSpawnId`; `setComponent(entityId, 'controller', null)`
   for `game.playerId`; `setComponent(entityId, 'cameraFollow', null)` for the
   camera entity while `game !== null`; `setComponent(entityId, 'model', …)` is
   never a removal (accepted).
3. Replacing `content.game` (a `setGameConfig` edit) never dangles anything, and
   removing the whole block (`value: null`) frees every reference; both are
   ordinary edits. A `setGameConfig` value whose references do not resolve is
   rejected (`game_reference_missing`) — never stored and repaired later.
4. **Assets are never deleted** in v3 (accepted M2 rule unchanged), so
   asset references cannot dangle. A reimport appends a version; a
   `modelAnimation.version` binding keeps pointing at its recorded immutable
   version and is never silently moved. Packet 41 owns role-binding reimport
   validation.
5. No operation silently clears a reference. Every rejection preserves the
   envelope bytes and the revision.

### 23.7 Canonical form additions

Extending §12.2: (a) fill the §23.3 defaults for present components only —
`surface` fields when a `surface` component is present; `light.castShadow` when a
`directional` light omits it; never fill a component that is absent, never fill
`activation` sub-fields, never fill `content.game` from `null`; (b) lowercase
`surface.color`, `surface.emissive`, `light.color`, `activation.emissive`;
(c) emit components in the §23.3 registry order and the field orders stated in
§§23.3/23.4; (d) `content.game` is emitted after `behaviorTrust`, as `null` or the
canonical block; (e) emit `entities` order unchanged and `content.assets` in
ascending `assetId` order as accepted; (f) byte output rules (§12.2 rule 6) and
idempotence (rule 7) unchanged.

Canonical key-order constant for a v3 content block:
`assets, prefabs, behaviors, settings, behaviorTrust, game`.

### 23.8 Validation order (v3 branch)

For a v3 scene the accepted per-document order (§12.3) is unchanged; the v3
additions run inside pass 4's collection step, in this order (all errors are
collected, not fail-fast, except where a single-error rule is stated):

1. component registry and combinations (§23.3, including the `gameZone`
   `zone_transform_unsupported` and the `playerSpawn` `spawn_transform_unsupported`
   of §23.9, and `component_conflict`);
2. per-component field values, ranges, canonical field order (§§23.3.1–23.3.6);
3. `modelAnimation` container: role keys/required/canonical bytes (§23.3.6);
4. counts and limits (§23.10);
5. entity-level `game` references that need only the scene: `playerId`/
   `cameraId`/`spawnId` existence and role match, checkpoint `safeSpawnId`
   resolution, `surface`/`modelAnimation` target rules, goal/checkpoint counts;
6. cross-block checks (with `content.game`): cue and `activation.cueAssetId`
   resolution, `kind` checks, `modelAnimation` asset/version resolution
   (§13 v3 extension);
7. `content.game` field validation (`configVersion`, strings, `level`, `killY`,
   `cues` shape) fails as one block-level `game_config_invalid` carrying `path`
   and `reason` (§23.9).

**Effective per-document order** (matches [`storage.md`](storage.md) §S4 and the
packet-39 fixture checker): combination check → envelope/content key set →
`content.assets` records and `kind` discriminators → `content.game` structural
validation (step 7) → scene validation (steps 1–5 above) → cross-block
resolution (step 6). Steps 1–5 collect independent errors; the combination
check, the envelope/content key set and `game_config_invalid` are single-error
rules that stop the pipeline.

Envelope-level order (`storageVersion` known → combination check → scene →
content → cross-block) is [`storage.md`](storage.md) §S4. A v3 combination
mismatch stops before any of the above.

### 23.9 New error codes

Added to §12.6 (model) and mirrored in `commands.md` §5.4 /
`workspace.md` §11 where a command or load reports them:

| Code | Raised when |
|---|---|
| `game_reference_missing` | `content.game` names an entity/asset that does not resolve, or a required role is absent; carries `path`, `reason` (`player`/`camera`/`camera_follow`/`spawn`/`safe_spawn`/`cue`) |
| `game_reference_in_use` | a deletion or component removal would dangle a game/checkpoint reference; carries `entityIds`, `references` (JSON Pointer paths) |
| `zone_transform_unsupported` | a `gameZone` entity is parented, non-unit-scaled or rotated; carries `path` and `reason` (`parented`/`scale`/`rotation`) (§23.3.1) |
| `spawn_transform_unsupported` | a `playerSpawn` entity is parented, non-unit-scaled or rotated/tilted; carries `path` and `reason` (`parented`/`scale`/`rotation`) (§23.3.2). Same three conditions, reason vocabulary and `path` forms as `zone_transform_unsupported`, but a separate code so the offending component is named; mirrors the accepted `physics_transform_unsupported` style (`project-model.md` §21.2) |
| `zone_checkpoint_count_invalid` | more than one `role: "checkpoint"` zone in the scene (single error; carries `zoneIds`) |
| `zone_goal_missing` | `content.game` is non-null and the scene has no `role: "goal"` zone |
| `asset_kind_mismatch` | a reference expects one `kind` and the resolved record has another (e.g. cue → `model`, animation → `audio`), or a reimport changes `kind` |
| `game_config_invalid` | `content.game` is malformed at the block level. Carries `path` and `reason`: `field_missing` (a required block field absent), `field_unexpected` (unknown block/cue field), `field_type`, or `field_value` (bad `configVersion`, string length/control char, `level`/`killY` relation). **Document rule:** envelope/content loading reports this one block-level code for structural failures; *commands* validate the same fields as request `args` and report the `field_*` codes of `commands.md` §5.4. References inside the block report `game_reference_missing` / `asset_reference_missing` / `asset_kind_mismatch`, never `game_config_invalid` |

`limits_exceeded` gains the limit names of §23.10. All new codes are additive:
no accepted code changes meaning or carries-shape.

### 23.10 Limits (v3 additions; reviewable at K)

All finite; exceeding one is `limits_exceeded` with `limit`, `current`, `max`.
Defaults are chosen for the sample and are **reviewable at Gate K** — the table
is contract material because fixtures reference the exact values.

| Class | Bound | Value | Failure |
|---|---|---|---|
| scene | zones per scene (`gameZone`) | 64 | `limits_exceeded` (`zones`) |
| scene | checkpoint zones per scene | 1 | `zone_checkpoint_count_invalid` |
| scene | goal zones per scene when `game !== null` | ≥ 1 | `zone_goal_missing` |
| scene | spawn markers per scene (`playerSpawn`) | 16 | `limits_exceeded` (`player_spawns`) |
| scene | directional lights | 1 | `limits_exceeded` (`lights_directional`) |
| scene | ambient lights | 1 | `limits_exceeded` (`lights_ambient`) |
| scene | entities per scene | 1024 (accepted) | `limits_exceeded` (`entities`) |
| content | `audio` asset records | 16 | `limits_exceeded` (`audio_assets`) |
| content | versions on an `audio` record | 8 | `limits_exceeded` (`audio_versions`) |
| content | canonical `content.game` bytes | 16 384 | `limits_exceeded` (`game_bytes`) |
| content | canonical `content` bytes | 1 048 576 (accepted) | `limits_exceeded` (`content_bytes`) |
| component | canonical `roles` bytes | 4 096 | `limits_exceeded` (`animation_profile_bytes`) |
| strings | `title` / `objective` / `instructions` | 64 / 160 / 320 chars | `field_value` (length) |
| numbers | `size`, `level`, `killY`, `deadZone`, `bounds` | `|v| ≤ 1e6` | `number_out_of_range` |
| numbers | `roughness`, `metalness`, `smoothing` | `[0, 1]` | `number_out_of_range` |
| numbers | `intensity` | `[0, 8]` | `number_out_of_range` |
| numbers | `emissiveIntensity` | `[0, 4]` | `number_out_of_range` |
| numbers | `light.direction` component | `|v| ≤ 1`, `‖v‖ ≥ 1e-6` | `number_out_of_range` |

### 23.11 Migration entry points (pure, v3)

Extending §12.4: `migrateSceneV3(scene)` accepts a logical v2 scene and returns
a logical v3 scene with `schemaVersion: 3`; every entity value, order, ID,
transform and component is carried **verbatim** (the v3 registry is a superset,
so no v2 entity needs editing). It is identity when the input is already v3.
It is pure, total and never touches disk. The envelope-level v2→v3 **copy**
operator (new identity, revision/retry/history reset, resumable crash
boundaries, no in-place upgrade) is [`storage.md`](storage.md) §S5.

### 23.12 Non-goals (v3)

No second mutable document; no JSON blob, script, expression, URL or HTML field;
no remote fonts/textures; no user-authored shader; no general event/behaviour
scripting; no light other than one directional + one ambient; no camera other
than the single gameplay camera with `cameraFollow`; no second physics owner; no
asset deletion/GC (accepted M2 non-goal unchanged); no runtime dependency on
editor/server/MCP code; no new numeric/gameplay tuning keys in
`content.settings` (the accepted six keys stand — packet 40/58 may propose a
reviewed change, 39 does not).

**PROPOSED — not accepted.** Packet 39 (`docs/planning/m3-packets.md` §39)
output. Section-level diffs for `docs/contracts/commands.md`. Normative text
lives in [`../authoring.md`](../authoring.md) §§A2–A7 and
[`../model.md`](../model.md) §23; this file names destinations, OLD/NEW text and
insertion anchors. Convention as in
`m2-contracts/diffs/commands.md`: `OLD` is accepted text exactly as it reads
today, `NEW` is the replacement, `+` blocks are insertions. Accepted section
numbers are never renumbered; new subsections are appended.

---

## A. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| C1 | §2 op table | insert 2 rows + reword 3 | this file |
| C2 | §2 non-goals | insert sentences | this file |
| C3 | §3.1 `createEntity` args | insert 2 fields + note | authoring.md §A3.1 |
| C4 | §3.1.6 `setComponent` | reword | authoring.md §A3.2 |
| C5 | new §3.1.9 / §3.1.10 / §3.1.11 | insert | authoring.md §§A3.3–A3.4, §A6 |
| C6 | §3.1.1 `publishAsset` | insert `kind` | authoring.md §A3.5 |
| C7 | §4 query request (`queryEntities`, `queryProject`) | insert rows/bullets | authoring.md §A6 |
| C8 | §5.3 change table | insert 2 rows | authoring.md §A4.2 |
| C9 | §5.4 error codes | insert rows + extend list | model.md §23.9 |
| C10 | §8.1 `createEntity` | insert derived-prefix rule | authoring.md §A4.1 |
| C11 | §8.10 `setComponent` | extend table + validation order | authoring.md §A3.2 |
| C12 | new §8.13 / §8.14 | insert op semantics | authoring.md §§A3.3–A3.4 |
| C13 | §9.1 inverse specs | insert 2 bullets | authoring.md §A4.2 |
| C14 | §12 fixture index | insert note | this file |

Not changed: §1, §6 (pipeline), §7, §8.2–8.9, §8.11–8.12, §9.2–9.4, §10, §11
accepted behaviour. Prefab semantics (§8.6/§8.7) are unchanged; the v3
rejections are additions to the existing forbidden-capture checks.

---

## B. Existing sections

### C1 — §2 op table

```diff
-| `createEntity` | mutation | Append one new entity (`group`, `box` or `model`) | +1 |
+| `createEntity` | mutation | Append one new entity (`group`, `box` or `model`), optionally with the add-capable components of §3.1 | +1 |
```

```diff
-| `setComponent` | mutation | Typed partial edit, add or remove of one owned component (`box`, `camera`, `model`, `collider`, `controller`) | +1 |
+| `setComponent` | mutation | Typed partial edit, add or remove of one owned component (`box`, `camera`, `model`, `collider`, `controller`, `gameZone`, `playerSpawn`, `cameraFollow`, `light`, `surface`, `modelAnimation`) | +1 |
```

```diff
-| `publishAsset` | mutation | Create an asset record or append one immutable `AssetVersion` (packet 15's delegated content mutation) | +1 |
+| `publishAsset` | mutation | Create an asset record (`kind: "model" | "audio"`) or append one immutable `AssetVersion` (packet 15's delegated content mutation) | +1 |
+| `applySurfacePreset` | mutation | Copy one built-in primitive preset's five surface values onto an entity, one undoable edit | +1 |
+| `setGameConfig` | mutation | Create, partially edit or remove the bounded `content.game` block | +1 |
```

```diff
-| `queryAssets` | query | Paged asset-catalog summaries (optional versions) | — |
+| `queryAssets` | query | Paged asset-catalog summaries (optional versions; each summary carries `kind`) | — |
+| `queryGameConfig` | query | The full `content.game` block or `null` | — |
```

### C2 — §2 non-goals

Anchor: the paragraph beginning `This contract excludes (normative non-goals): …`
— insert into the list.

```diff
-This contract excludes (normative non-goals): rename, reorder, camera
-creation (a valid scene always contains exactly one camera, project-model
-§10.3), arbitrary multi-entity batches, scene selection (single scene,
-project-model §3), prefab update/delete/variants/nesting, behavior **source**
-publication (§8.11), structural component add/remove for
-`box`/`camera`/`model` (the two physics components do support add/remove,
-§8.10), and any general
-JSON-Patch/eval/batch API.
+This contract excludes (normative non-goals): rename, reorder, camera
+creation (a valid scene always contains exactly one camera, project-model
+§10.3), arbitrary multi-entity batches, scene selection (single scene,
+project-model §3), prefab update/delete/variants/nesting, behavior **source**
+publication (§8.11), structural component add/remove for
+`box`/`camera`/`model` (the physics and M3 components do support add/remove,
+§8.10), and any general
+JSON-Patch/eval/batch API. M3 adds: no new `createEntity` kind (the union stays
+the closed `{"group","box","model"}` — zones/spawns/lights/surfaces/animation
+profiles are components, authoring.md §A3.1), no game-config side document, no
+command other than `setGameConfig` may write `content.game`, no asset deletion
+or GC, and no script, expression, HTML or URL field.
```

### C3 — §3.1 `createEntity`

Anchor: after the `model` row of the `createEntity` table.

```diff
+| `components` | object; keys ⊆ `{ "collider", "controller", "gameZone", "playerSpawn", "cameraFollow", "light", "surface", "modelAnimation" }`; each value is the corresponding §8.10 add value (never `null`); at most 8 keys | no |
+| `surfacePreset` | `"matte-ground" | "hazard" | "beacon"`; only with `kind` ∈ `{box, model}` and not together with `components.surface` | no |
```

Note (normative): `components` gives every v3 value a **creation** path in the
same transaction as its holder entity, so no value requires a second,
skippable command (authoring.md §A3.1).

### C4 — §3.1.6 `setComponent`

```diff
-**§3.1.6 `setComponent`** — `args: { entityId, component, value }`; `component ∈
-{ box, camera, model, collider, controller }` (it never accepts `transform`,
-`behavior` or `prefab`). Full semantics: §8.10.
+**§3.1.6 `setComponent`** — `args: { entityId, component, value }`; `component ∈
+{ box, camera, model, collider, controller, gameZone, playerSpawn, cameraFollow,
+light, surface, modelAnimation }` (it never accepts `transform`, `behavior` or
+`prefab`). Full semantics: §8.10.
```

### C5 — new §3.1.9, §3.1.10, §3.1.11

Anchor: after §3.1.8 (`acknowledgeBehaviorTrust`).

```diff
+**§3.1.9 `applySurfacePreset`** — `args: { entityId, preset }`;
+`preset ∈ { "matte-ground", "hazard", "beacon" }`. Full semantics: §8.13.
+
+**§3.1.10 `setGameConfig`** — `args: { game }`; `game` is `null` (remove), a
+complete `GameConfig` (create when the block is `null`), or a non-empty partial
+object of its top-level fields (edit). Full semantics: §8.14.
+
+**§3.1.11 `queryGameConfig`** — `args: {}`; returns the full `content.game`
+block or `null` (authoring.md §A6).
```

And the existing conventions paragraph gains:

```diff
 Conventions that apply to every new `args` object (already accepted for M1):
 unknown fields ⇒ `field_unexpected`; missing ⇒ `field_missing`; wrong type ⇒
 `field_type`; right type/wrong value ⇒ `field_value`; the request's canonical
 bytes must be ≤ 65 536 (`limits_exceeded` `request_bytes`, checked before
 argument validation).
+The same four `field_*` codes cover every v3 args object; `component_conflict`,
+`component_missing`, `game_reference_missing`, `game_reference_in_use`,
+`zone_transform_unsupported`, `spawn_transform_unsupported`,
+`zone_checkpoint_count_invalid`,
+`zone_goal_missing`, `asset_kind_mismatch` and `game_config_invalid` are the
+semantic codes of §§8.13–8.14/§8.10.
```

### C6 — §3.1.1 `publishAsset`

Anchor: after the `§3.1.1 publishAsset` paragraph.

```diff
+`kind` is `"model" | "audio"`, **required** on `mode: "create"` and optional on
+`mode: "reimport"` where it must equal the record's kind (`asset_kind_mismatch`
+otherwise). The kind binding is immutable (project-model §23.3.7).
```

### C7 — §4 query request

Anchor: at the end of the `queryEntities` page description and the `queryProject`
summary bullet in §5.6 (both below). In §4 add:

```diff
+`queryEntities` accepts an optional `component` filter (one of the accepted
+component names); `queryProject`'s content summary carries `game` (boolean),
+`zones`, `spawns` and `audioAssets` counts (authoring.md §A6).
```

### C8 — §5.3 change table

Anchor: after the `acknowledgeBehaviorTrust` row.

```diff
+| `applySurfacePreset` | `{ type, id, preset, previous, next, changedFields }` — full `surface` values (`previous: null` when absent), `changedFields` in the surface field order | `applySurfacePreset` success; undo/redo of it |
+| `setGameConfig` | `{ type, previous, next, changedFields }` — full `GameConfig` values or `null`, `changedFields` = replaced top-level names in canonical order | `setGameConfig` success (create/edit/remove); undo/redo of it |
```

And the inverse-summary paragraph gains a sentence: `applySurfacePreset`’s
inverse is the `setComponent` surface restore; `setGameConfig` is self-inverse
with swapped `previous`/`next`.

### C9 — §5.4 error codes

Anchor: after the `behavior_trust_unacknowledged` row.

```diff
+| `game_reference_missing` | `validation` | `path`, `reason` | a `content.game` reference or required role does not resolve (project-model §23.9) |
+| `game_reference_in_use` | `validation` | `entityIds`, `references` | a deletion or component removal would dangle a game/checkpoint reference (project-model §23.6) |
+| `zone_transform_unsupported` | `validation` | `path`, `reason` | a `gameZone` entity is parented, non-unit-scaled or rotated |
+| `spawn_transform_unsupported` | `validation` | `path`, `reason` | a `playerSpawn` entity is parented, non-unit-scaled or rotated (project-model §23.3.2/§23.9; same conditions as `zone_transform_unsupported`, separate code) |
+| `zone_checkpoint_count_invalid` | `validation` | `zoneIds` | more than one checkpoint zone exists |
+| `zone_goal_missing` | `validation` | — | `content.game` is non-null and no goal zone exists |
+| `asset_kind_mismatch` | `validation` | `assetId`, `expected`, `found` | a reference/reimport kind disagrees with the record |
+| `game_config_invalid` | `validation` | `path`, `reason` | `content.game` is malformed at the block level; `reason` ∈ `field_missing`/`field_unexpected`/`field_type`/`field_value` (project-model §23.9) |
```

`limits_exceeded`'s carried-limit list gains `zones`, `player_spawns`,
`lights_directional`, `lights_ambient`, `audio_assets`, `audio_versions`,
`game_bytes`, `animation_profile_bytes`; `id_exhaustion`'s `kind` union gains
`zone`, `spawn`, `light`. No accepted code's meaning or carries-shape changes.

### C10 — §8.1 `createEntity`

Anchor: after step 2's `camera`-never-allocatable sentence.

```diff
+   The derived prefix order is **first match**: `model` → `box` → `zone`
+   (`gameZone`) → `spawn` (`playerSpawn`) → `light` (`light`) → `group`. A
+   `components` argument is validated in the §3.1.1/§8.10 order and the entity is
+   stored with all of its components in canonical order (one `createEntity`
+   change; one revision; one history entry).
```

### C11 — §8.10 `setComponent`

Anchor: the accepted component table — append rows after the `controller` row.

```diff
+| `gameZone` | `role` (`"hazard" | "checkpoint" | "goal"`), `size` (`[w,h]`, `0 < v ≤ 1e6`), `safeSpawnId` (iff `checkpoint`), `activation` (iff `checkpoint`) | **add**/**edit**/**remove** via `null`; `zone_transform_unsupported`, `component_conflict` with `collider`/`controller`, `game_reference_missing`, `game_reference_in_use` (project-model §23.3.1/§23.6) |
+| `playerSpawn` | exactly `{}` | **add** with `{}`, **remove** via `null`; no field edit; `spawn_transform_unsupported` |
+| `cameraFollow` | `deadZone`, `smoothing`, `bounds` | **add**/**edit**/**remove**; only on the `camera` entity |
+| `light` | `type`, `color`, `intensity`, `direction` (iff `directional`), `castShadow` (iff `directional`) | **add**/**edit**/**remove**; count limits `lights_directional`/`lights_ambient` |
+| `surface` | `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity` | **add**/**edit**/**remove**; only on a `box`/`model` entity |
+| `modelAnimation` | `assetId`, `version`, `roles` | **add**/**edit**/**remove**; only on a `model` entity; `component_conflict` `animation_asset` |
```

Validation-order sentence extended: `… → field validation → the v3 component
rules (project-model §23.3, §23.6) → resulting-state validation + no-change →
durability.` The change-data paragraph gains the extended `component` union.

### C12 — new §8.13 / §8.14

Anchor: after §8.12 (`acknowledgeBehaviorTrust`).

```diff
+### 8.13 `applySurfacePreset`
+Normative text: [`../authoring.md`](../authoring.md) §A3.3 (preconditions,
+effect, one edit/one revision/one history entry, exact inverse and redo rule).
+
+### 8.14 `setGameConfig`
+Normative text: [`../authoring.md`](../authoring.md) §A3.4 (create/edit/remove
+rules, validation order, references, `previous`/`next`/`changedFields`, exact
+inverse, no-change).
```

### C13 — §9.1 inverse specs

Anchor: after the `acknowledgeBehaviorTrust` inverse bullet.

```diff
+- `applySurfacePreset` ⇒ `{ "kind": "setComponent", "id", "component": "surface", "restore": <full previous SurfaceComponent or null> }`.
+- `setGameConfig` ⇒ `{ "kind": "setGameConfig", "restore": <full previous GameConfig or null> }`.
```

### C14 — §12 fixture index

Anchor: at the end of §12.

```diff
+- Packet-39 v3 fixtures add `fixtures/m3/contracts/commands/*` (the
+  create/add/edit/remove scenario, no-change and the reachable failure set) and
+  `fixtures/m3/contracts/envelope/*` (byte-exact v3 envelopes), replayed by
+  `fixtures/m3/contracts/tools/check-fixtures.mjs`. Contract-level fixture
+  changes require the same review as contract text (project-model §17).
```

---

## C. Owner decisions recorded (no silent redefinition)

- **`createEntity` kind union stays closed**; v3 values are components. The
  justification is in authoring.md §A3.1 (one registry, one change/inverse shape,
  creation in the same transaction as the holder).
- **`content.game` is the only game-config home**; no side file, no new envelope
  key beyond `game`, no second writer.
- **`applySurfacePreset` is a distinct op** (not a `setComponent` value) so no
  persisted preset link is needed and the persisted component stays pure values.
- **`setComponent` never accepts `transform`/`behavior`/`prefab`** (accepted).

---

## Packet 41 additions — atomic media reimport and the presentation code rows

**PROPOSED by packet 41** (`planning/m3-contracts/presentation.md`). This
section is appended by packet 41 and rewrites no packet-39 row above. It fills
the two placeholders 39 marked as packet-41's (the audio `importRecipe`/
`metrics` and the animation role binding) at the command surface, and it adds
the exact `publishAsset` mapping field that makes reimport atomic.

| # | Destination | Kind | Normative text |
|---|---|---|---|
| CMD41-1 | §3.1.1 `publishAsset` args | extend | this file (C41-2 request to `authoring.md` §A3.5) |
| CMD41-2 | §8.5 `publishAsset` semantics | insert sub-part §8.5.1 | this file |
| CMD41-3 | §5.4 error table + `limits_exceeded` row | insert rows/names | this file |

### CMD41-1 — §3.1.1 `publishAsset`: the `kind` and `animation` fields

Anchor: the accepted §3.1.1 paragraph. OLD is verbatim:

```diff
-**§3.1.1 `publishAsset`** — `args: { mode, assetId, displayName?, sourceDigest,
- sourceByteLength, importRecipe, metrics, importedAt }`; `mode` is `"create" | "reimport"`;
- create on an existing `assetId` ⇒ `asset_id_duplicate`, reimport on an unknown
- one ⇒ `asset_not_found`; `importedAt` is a required project-model §7.2 timestamp
- (the pure layer has no clock — the caller supplies it); the args are
- **stage-free** (durable, digest-addressed facts only). On `reimport` a supplied
- `displayName` **replaces** the record's display name (absent ⇒ the existing name
- is kept); on `create` an absent `displayName` defaults to the `assetId`. Full
- order/dedup/inverse semantics: §8.5.
+**§3.1.1 `publishAsset`** — `args: { mode, assetId, kind?, displayName?,
+ sourceDigest, sourceByteLength, importRecipe, metrics, importedAt, animation? }`;
+ `mode` is `"create" | "reimport"`; `kind` is `"model" | "audio"`, **required on
+ `create`** (`field_missing`) and, on `reimport`, optional but if present must
+ equal the record's `kind` (`asset_kind_mismatch`) — it is fixed at create
+ (`authoring.md` §A3.5, packet 39's discriminator). `importRecipe`/`metrics` are
+ the profile-matched shapes of `project-model` §18.5/§18.6 (the `pcm-wav`
+ member is packet 41's, `presentation.md` §41.4.3). `animation` is the atomic
+ reimport mapping of CMD41-2. `create` on an existing `assetId` ⇒
+ `asset_id_duplicate`, reimport on an unknown one ⇒ `asset_not_found`;
+ `importedAt` is a required project-model §7.2 timestamp (the pure layer has no
+ clock — the caller supplies it); the args are **stage-free** (durable,
+ digest-addressed facts only). On `reimport` a supplied `displayName`
+ **replaces** the record's display name (absent ⇒ the existing name is kept); on
+ `create` an absent `displayName` defaults to the `assetId`. Full
+ order/dedup/inverse semantics: §8.5.
```

### CMD41-2 — §8.5: insert §8.5.1 "Atomic animated reimport"

Anchor: at the end of the accepted §8.5 `publishAsset` section, before §8.6.

```diff
+#### 8.5.1 Atomic animated reimport (`animation`)
+
+```ts
+interface PublishAssetAnimation {
+  entityId: string;
+  roles: ModelAnimationRoles;   // presentation.md §41.3.1
+}
+```
+
+`animation` is the **only** way a version-local role binding is written; there
+is no separate `setComponent` step that could leave the bytes and the mapping
+out of step.
+
+**Presence rule.** `mode: "reimport"` **requires** `animation` when the current
+scene contains at least one entity whose
+`components.modelAnimation.assetId === args.assetId`; absent ⇒ `field_missing`
+at `/args/animation`. It is rejected as `field_unexpected` for `mode: "create"`
+and for a `kind: "audio"` reimport. A reimport of an asset no animated entity
+references, and a reimport of an audio asset, omit it.
+
+**Validation order** (extends §8.5's order; fail-fast):
+
+1. accepted envelope/args checks, then the presence rule above;
+2. `assetId` resolves (`asset_not_found`) and `kind` agrees (accepted);
+3. `entityId` resolves (`entity_not_found`);
+4. the entity carries `modelAnimation` (`component_missing`,
+   `expected: "modelAnimation"`);
+5. that component's `assetId` equals `args.assetId` (`component_conflict`,
+   `reason: "animation_asset"`);
+6. binding structure/range/duplicates (presentation.md §41.3.2 stages 1–4)
+   against the **new** version's `metrics.animations`;
+7. the GLB animated profile and name agreement/ambiguity (presentation.md
+   §41.3.3 and §41.3.2 stages 5–6) against the supplied proposal;
+8. resulting document validation → no-change → durability.
+
+**Effect and atomicity.** One success appends exactly one `AssetVersion`,
+replaces the entity's `roles` value with `args.roles`, advances `revision` by
+one and records exactly one history entry. The change is
+
+```ts
+interface PublishAssetChange {          // extended
+  type: 'publishAsset';
+  mode: 'create' | 'reimport';
+  assetId: string;
+  previous: AssetRecord | null;
+  next: AssetRecord;
+  animation?: { entityId: string; previous: ModelAnimationRoles; next: ModelAnimationRoles };
+}
+```
+
+and the inverse restores **both** the previous record (or removes the created
+one) and the previous `roles` value. Undo/redo move both together or neither; a
+redo re-applies the recorded `next` values (the recorded-value rule, §9.1). Any
+rejection at steps 1–7 writes nothing: the previous `currentVersion`, the
+previous bytes, the previous `roles`, the revision and the history stacks are
+unchanged (`project-model` §18.1 rule 6). Reordered clips with an equivalent
+new mapping are accepted and the entity keeps its ID, transform and every other
+component (accepted §18.1 rule 5).
```

### CMD41-3 — §5.4 rows and limit names

Anchor 1: after the accepted `asset_reference_missing` row.

```diff
 | `asset_reference_missing` | `validation` | `assetId` | a `components.model`/`setComponent` `model` reference does not resolve in `content.assets` (project-model §11.2/§18.1) |
+| `animation_role_out_of_range` | `validation` | `path`, `role`, `clipIndex`, `clips` | a `modelAnimation` binding's `clipIndex` ≥ the named version's `metrics.animations` (presentation.md §41.3.2 stage 3) |
+| `animation_role_duplicate` | `validation` | `path`, `clipIndex`, `roles` | two roles of one `modelAnimation` share a `clipIndex` (stage 4) |
+| `animation_role_mismatch` | `validation` | `path`, `role`, `expected`, `found` | `clipName ≠ clips[clipIndex].name` at publication (stage 5) |
+| `animation_role_ambiguous` | `validation` | `path`, `role`, `clipName`, `matches` | the version's clip list has more than one clip named `clipName` (stage 6) |
+| `animation_skin_unsupported` | `validation` | `path` | the animated-profile GLB carries `skins` or a `JOINTS_0`/`WEIGHTS_0` attribute (presentation.md §41.3.3 A2) |
+| `animation_root_motion` | `validation` | `path`, `role`, `nodeIndex`, `nodeName` | a channel animates a scene root node's `translation` (A6) |
```

Anchor 2: the accepted `limits_exceeded` row's name list — append the new limit
names (the row text is otherwise unchanged):

```diff
-... `trust_entries`, `request_bytes`) |
+... `trust_entries`, `request_bytes`, `animation_clips`, `animation_tracks`,
+`animation_track_times`, `animation_clip_duration`, `audio_pcm_bytes`,
+`audio_cues`) |
```

## Not changed by packet 41

- No new op, no new `createEntity` kind, no `setComponent` field for media:
  audio bytes/publication stay `publishAsset`, cue assignment stays
  `setGameConfig` (39), preset application stays `applySurfacePreset` (39),
  and the role binding is written only by the atomic `publishAsset` mapping
  above (or by a same-version `setComponent` when the clip list is unchanged —
  the pure stages 1–4 of presentation.md §41.3.2).
- No command carries media bytes; the request-size/`content_bytes` limits are
  unchanged. Audio rejection is an **inspection** diagnostic
  (`asset-pipeline`, presentation.md §41.7.2 set C), not a command error; a
  corrupt/missing declared blob remains the accepted `blob_missing`/
  `blob_corrupt` / `export_failed` path.

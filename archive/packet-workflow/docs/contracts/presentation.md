# Thirdlight — Presentation Contract

Version: 0.1 (M3 contract, promoted on the Gate K architectural review) · Packet 41 · 2026-09-19
Status: accepted by the Gate K architectural review (a session review — **not**
owner approval and **not** an independent human review) under the owner's M3
execution authorization; final manual review pending. Promoted docs-only by the
M3 Gate K promotion step (`docs/handoffs/m3-promotion.md`) from
`docs/planning/m3-contracts/presentation.md`.
Scope: M3 presentation — the bounded lighting/shadow profile, the three copied
primitive presets, the rigid-node animation role profile and its atomic reimport,
the bounded PCM-WAV audio profile and its injected browser owner, and the
checkpoint activation appearance.
Companion documents (review together): `project-model.md` §§18/23 (media fields
and v3 data), `commands.md` (the command surface), `gameplay.md` (the read-only
`GameView` consumer), `runtime.md` §§9/12/13. Companion fixtures:
`fixtures/m3/media/**`.

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense.

---

## 41.0 Scope, ownership and non-goals

### 41.0.1 What this contract owns

| Area | Normative content here |
|---|---|
| Lighting/shadows | the one-key/one-fill realization profile, the single conservative shadow preset and its derived camera, the degradation rule and the no-WebGL outcome |
| Primitive presets | the three frozen rows' realization, application as one undoable edit, copy-not-link independence |
| Rigid animation | `AnimationRoleBinding`, the full validation order, the animated-GLB profile, atomic reimport, the §18.1 rule-3 replacement, the runtime role selector and the bounded crossfade |
| Audio | the PCM-WAV container/chunk rules, the exact byte accounting, the `pcm-wav` recipe/metrics, the inspection order and rejection codes, the cue bound, hard-failure vs sound-off, the injected browser audio owner |
| Activation appearance | the value 39 owns and the read-only view bit the adapter consumes, its lifetime, and its realization owners |
| Lifetimes | the ownership/disposal table for every created resource |
| Limits/errors | the finite limits, the closed error/diagnostic sets and their destination rows |

### 41.0.2 What this contract does **not** own

- v3 scene/storage/catalog data, the `activation` slot's presence/requiredness,
  the audio `kind` discriminator, asset IDs, cues, `content.game` — packet 39
  (`project-model.md` §23). This contract supplies exactly the fields 39 marked as
  packet-41 placeholders: the audio `importRecipe`/`metrics` and the
  `AnimationRoleBinding` shape.
- The run state machine, `GameView`, the reset barrier, camera math — packet 40
  (`gameplay.md`).
- The delivery manifest, CSP, bridge and static closure — packet 42. Bytes
  reach the browser only through the accepted immutable blob read path; this
  contract adds no locator, URL, token or fetch.
- Runtime phases, transform ownership, fail-stop semantics — accepted
  `runtime.md` §§12/13.
- Any general graphics system: no material graph, shader authoring, post
  processing, texture pipeline, second render loop or second scene-mutation
  path.

### 41.0.3 Ownership map (who realizes what)

| Unit | Owns |
|---|---|
| `project-model` | pure validation of `light`/`surface`/`modelAnimation`/`activation`/audio version records (44) |
| `commands` | pure edits, inverses, no-change and the atomic reimport validation (45) |
| `asset-pipeline` | pure bounded WAV inspection and the version-bound GLB role proposal over supplied bytes (47) |
| `workspace` | staging, immutable blob publication, load-time re-checks (46/48) |
| `three-adapter` | **all** GPU resources for lights/shadows/materials/GLB instances/mixers/actions (52/53); no fetch, no token, bytes or an injected resolver only |
| `game-host` (new, packet 54) | the browser audio owner: `AudioContext`, decode, voices, activation, mute, suspend, close |
| `platformer-game` | the read-only committed motion the selector consumes (49/50); no three import |
| `editor` (57) / `runtime` | authoring UI and the committed observation; neither mutates presentation resources directly |

Every resource has exactly one creating owner and one disposing owner
(§41.6). No package reaches another package's internals.

---

## 41.1 Lighting and shadows

### 41.1.1 Authored data (consumed, not redefined)

The authored values are `components.light` (`project-model.md` §23.3.4): at most one
`directional` and at most one `ambient` light per scene, `color` `^#[0-9a-f]{6}$`,
`intensity` `[0, 8]`, `direction` (directional only, each `|v| ≤ 1`,
`‖v‖ ≥ 1e-6`, not renormalized in the document) and `castShadow` (directional
only, default `false`). This contract does not add a field, a light type, a
second key, a light entity transform rule or a shadow parameter to the
document. An author who wants no shadows writes `castShadow: false`.

### 41.1.2 The single conservative realization profile

There is exactly **one** presentation quality profile; there is no user
setting and no per-entity override:

| Constant | Value | Meaning |
|---|---|---|
| `SHADOW_MAP_SIZE` | `512` | shadow map width = height, texels |
| `SHADOW_TYPE` | `'PCFShadowMap'` | three's `THREE.PCFShadowMap` (not `PCFSoftShadowMap`, not `VSM`) |
| `SHADOW_NEAR` | `0.5` | shadow camera near plane, metres |
| `SHADOW_DISTANCE` | `20` | light position offset from the shadow target, metres |
| `SHADOW_MARGIN` | `2` | metres added around the level bounds |
| `SHADOW_HALF_EXTENT_MAX` | `64` | metres, the largest accepted shadow half-extent |
| `SHADOW_FAR_MAX` | `200` | metres, the shadow camera far cap |

Realization rules (normative):

1. `ambient` → `THREE.AmbientLight(color, intensity)`, no shadow, no position
   dependence. `intensity` is used exactly as authored.
2. `directional` → `THREE.DirectionalLight(color, intensity)` with
   `castShadow = (castShadow === true && shadowAvailable)`; the derived light
   position is `target − normalize(direction) · SHADOW_DISTANCE`, the derived
   target is the derived shadow centre. Only a **derived copy** of `direction`
   is normalized (same rule as accepted `project-model` §10.1 quaternions);
   the authored document value is never rewritten.
3. The light entities' own `transform` is irrelevant to the light
   (`project-model.md` §23.3.4): the adapter reads only the component value.
4. Exactly one directional node and one ambient node exist per realized scene
   regardless of authoring order (39 caps both at 1).
5. `renderer.shadowMap.enabled` is `true` iff a directional light with
   `castShadow === true` exists **and** the shadow capability probe (§41.1.4)
   passed. A scene with no shadow-casting light allocates no shadow map.

`SHADOW_MAP_SIZE = 512` and `SHADOW_TYPE = 'PCFShadowMap'` are the packet-38
executed configuration (real browser probe: `renderer.shadowMap.type =
THREE.PCFShadowMap`, `key.shadow.mapSize.set(512, 512)`, shadow map allocated
— packet-38 baseline §1). The profile is frozen to that recorded, real-browser
configuration rather than to an unexecuted larger size.

### 41.1.3 Shadow camera derivation (exact)

Inputs: `content.game.level` (`minX`, `maxX`, `minY`, `maxY`) and the
directional `direction` `d`. Let `n = d / ‖d‖`.

- centre `c = ((minX + maxX) / 2, (minY + maxY) / 2, 0)`;
- `halfExtent = max((maxX − minX) / 2, (maxY − minY) / 2) + SHADOW_MARGIN`;
- `far = SHADOW_DISTANCE + halfExtent + SHADOW_MARGIN`;
- light position `p = c − n · SHADOW_DISTANCE`; target `c`;
- the shadow camera is orthographic with
  `left = −halfExtent`, `right = halfExtent`, `top = halfExtent`,
  `bottom = −halfExtent`, `near = SHADOW_NEAR`, `far = min(far, SHADOW_FAR_MAX)`.

If `halfExtent > SHADOW_HALF_EXTENT_MAX` the shadow is **not** allocated for
that scene and the degradation rule of §41.1.4 applies with reason
`shadow_bounds_exceeded`. `Z` is presentation depth only; the shadow camera
covers the authored XY level, not the whole scene.

### 41.1.4 Capability, degradation and the unplayable case

| Condition | Outcome | Class |
|---|---|---|
| no canvas / `getContext` throws / no WebGL at all | `SceneAdapter` creation fails with the accepted `render_unsupported`; the host presents the structured unplayable state and no runtime frame loop starts | **hard** (unplayable) |
| WebGL exists but the context is not WebGL 2 | same `render_unsupported`; the M3 target is WebGL 2 (`../planning/m3-contracts/baseline.md` §1: software WebGL 2) | **hard** (unplayable) |
| a shadow-casting light exists but the renderer cannot allocate the shadow map (`maxTextureSize < SHADOW_MAP_SIZE`, or the probe render throws/errors) | shadows are turned **off**: `castShadow` is ignored for realization, no shadow map is allocated, rendering continues with the key light only, and one bounded diagnostic is recorded | **soft** (shadow-off) |
| `halfExtent > SHADOW_HALF_EXTENT_MAX` (§41.1.3) | same shadow-off outcome, reason `shadow_bounds_exceeded` | **soft** (shadow-off) |
| a lost context at runtime | accepted `render_context_lost` behavior (packet 26) is unchanged; nothing is disposed on loss | accepted |

The adapter's diagnostics gain exactly two read-only fields:

```ts
interface SceneAdapterDiagnostics {
  // ... accepted fields ...
  readonly shadows: 'on' | 'off';                       // realization result for the current scene
  readonly shadowReason?: 'cast_shadow_false' | 'shadow_bounds_exceeded' | 'shadow_unsupported';
}
```

`shadowReason` is present iff `shadows === 'off'`; `cast_shadow_false` is the
author's own choice (no cast-shadow light) and is **not** an error. The
diagnostic is recorded once per realized scene, never per frame, and carries no
path, token or device string. Shadow degradation never changes gameplay:
hazards remain visible by shape/contrast as well as color (sample §4) and no
collision, trigger or camera value depends on the shadow state.

### 41.1.5 What is not promised

No identical-pixels guarantee between GPU drivers, browsers or a software
rasterizer; no product performance budget; no frame-rate, draw-call, memory or
GPU-memory claim. Packet-38 software-rendered observations are labelled
**SwiftShader** and are not hardware-GPU evidence. Any visual acceptance check
compares the **authored values and derived parameters** (a named checklist:
same preset row, same light color/intensity, same normalized direction, same
shadow preset constants) and, where a browser exists, records real pixels at
52/57/59/62 with the renderer named.

---

## 41.2 Primitive material presets

### 41.2.1 The three frozen rows

Model-wide, the closed preset table is packet 39's `project-model.md` §23.3.5. This
contract adds no fourth preset and no preset field:

| Preset id | `color` | `roughness` | `metalness` | `emissive` | `emissiveIntensity` |
|---|---|---|---|---|---|
| `matte-ground` | `#6f6f6f` | `0.95` | `0` | `#000000` | `0` |
| `hazard` | `#d42a1e` | `0.55` | `0` | `#3a0703` | `0.35` |
| `beacon` | `#2f7fd4` | `0.4` | `0.1` | `#1bc8ff` | `1.2` |

A preset is a **value row**, never a resource: no preset id, catalog entry or
reference is persisted by applying one (`project-model.md` §23.3.5). The realized
material is `THREE.MeshStandardMaterial` with `color`, `roughness`, `metalness`,
`emissive` and `emissiveIntensity` taken literally from the entity's
`surface` component value.

### 41.2.2 Application is one undoable edit

Applying a preset is exactly the accepted command of `commands.md` §8.13:
`applySurfacePreset { entityId, preset }` replaces the entity's whole `surface`
component with the frozen row — one atomic edit, one revision, one history
entry, `changedFields` exactly `["color","roughness","metalness","emissive",
"emissiveIntensity"]`, inverse `setComponent(entityId,"surface",previous)`
(`null` when the component was absent), redo re-applying the recorded `next`
value. Re-applying the row already present is `no_change` and changes nothing.
No op writes a preset id anywhere.

### 41.2.3 Realization and independence

- An entity carrying `surface` gets one material instance created per entity
  placement; **the material instance is owned by that entity's model/box
  instance** (`three-adapter`), not shared with another entity through a
  preset table or a link.
- Editing one entity's `surface` fields (or applying a different preset) changes
  only that entity's material; another entity that was given the same preset
  keeps its own values. The independence rule is value-level, not
  object-identity-level: two entities may happen to have equal field values and
  still be independent (36/57 fixtures assert this).
- An entity with `model` and no `surface` keeps the GLB's authored materials
  (`project-model.md` §23.3.5; M2 behavior unchanged). GLB materials are never
  remapped by preset ids.
- Changing `surface` during play is an authoring edit: the new committed
  snapshot reaches the host through the accepted capture path (42/58/59). The
  adapter holds no authoring reference and never subscribes to edits.

---

## 41.3 Rigid-node animation roles

### 41.3.1 The profile shape

```ts
type AnimationRole = 'idle' | 'run' | 'airborne';

interface AnimationRoleBinding {
  clipIndex: number;   // integer, 0 ≤ clipIndex < version.metrics.animations
  clipName: string;    // 1–128 chars, no control characters; must equal clips[clipIndex].name
}

interface ModelAnimationRoles {
  idle: AnimationRoleBinding;      // exactly these three keys, all required (model.md §23.3.6)
  run: AnimationRoleBinding;
  airborne: AnimationRoleBinding;
}
```

Canonical key order: role keys in the fixed order `idle`, `run`, `airborne`;
each binding exactly `clipIndex`, `clipName`. `components.modelAnimation`
(39 §23.3.6) carries `assetId`, `version`, `roles`, with
`roles` ≤ 4096 canonical bytes, and the binding is **owned by that
`(assetId, version)`**: a `roles` value is only valid against the clip list of
the version it is recorded with, so an atomic reimport appends the new version
and moves the referencing entity's component — `version` and `roles`
together — to it in the same revision (§41.3.4); nothing else about the entity
moves (39 §23.6.4). The entity data never carries a bare clip name
or a bare index without the version binding (§41.3.5).

`clipName` is a bounded consistency and display value only. The runtime selects
exclusively by `clipIndex`; `clipName` is checked to equal the version's real
clip name at publication and re-checked at load.

### 41.3.2 Validation order (normative)

The container order is packet 39's (`project-model.md` §23.8 step 3 before ranges).
Within this contract, the order below is fail-fast on the first failing stage;
each stage may collect several independent diagnostics.

| # | Stage | Check | Code |
|---|---|---|---|
| 1 | container | `roles` has exactly `idle`/`run`/`airborne`; unknown/missing key; canonical bytes ≤ 4096 | `field_missing` / `field_unexpected` / `limits_exceeded` (`animation_profile_bytes`) |
| 2 | binding fields | each binding is an object with exactly `clipIndex` + `clipName`; `clipIndex` is a non-negative integer (`Number.isInteger`); `clipName` a string 1–128 chars with no control characters | `field_missing` / `field_unexpected` / `field_type` / `field_value` |
| 3 | range (pure) | `clipIndex < version.metrics.animations` for the named version | `animation_role_out_of_range` |
| 4 | duplicates (pure) | no two roles share a `clipIndex` | `animation_role_duplicate` |
| 5 | name agreement (inspect/publish/load) | the version's clip list has `clips[clipIndex].name === clipName` | `animation_role_mismatch` |
| 6 | ambiguity (inspect/publish/load) | the version's clip list contains **exactly one** clip whose `name` equals `clipName` | `animation_role_ambiguous` |
| 7 | GLB profile | §41.3.3 A1–A6 on the supplied bytes, **after** stages 1–6 | `animation_skin_unsupported` / `animation_root_motion` / `limits_exceeded` (`animation_clips`, `animation_tracks`, `animation_track_times`, `animation_clip_duration`) |

Stages 3 and 4 are decidable **purely** from the envelope (the version record's
`metrics.animations` is persisted), which is what makes `setComponent` a pure
edit. Stages 5–7 need the real clip list and run in `asset-pipeline` during
inspection/publication (§41.3.4) and are re-checked by `three-adapter` at
load against `PreparedVisualResource.clips`.

Codes carry: `animation_role_out_of_range` `{ path, role, clipIndex, clips }`;
`animation_role_duplicate` `{ path, clipIndex, roles }`;
`animation_role_mismatch` `{ path, role, expected, found }`;
`animation_role_ambiguous` `{ path, role, clipName, matches }`;
`animation_skin_unsupported` `{ path }`;
`animation_root_motion` `{ path, role, nodeIndex, nodeName }`.

### 41.3.3 The animated-model GLB profile

An `inspectGlb` proposal (accepted §18.7.2) is additionally checked, in this
order, **iff** the caller requests the animated profile (the `publishAsset`
reimport carries command `animation`; §41.3.4):

| # | Check | Rejects with |
|---|---|---|
| A1 | `metrics.animations` `1 ≤ n ≤ ANIMATION_PROFILE_MAX_CLIPS = 8` | `limits_exceeded` (`animation_clips`) |
| A2 | no `skins` array and no primitive attribute `JOINTS_0`/`WEIGHTS_0` anywhere (the M3 profile has no skeletal animation; `clone(true)` isolation is never claimed) | `animation_skin_unsupported` |
| A3 | total animation channels ≤ `ANIMATION_PROFILE_MAX_TRACKS = 64`; channels in any one clip ≤ `ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP = 32` | `limits_exceeded` (`animation_tracks`) |
| A4 | summed sampler `input` keyframe count over all clips ≤ `ANIMATION_PROFILE_MAX_TRACK_TIMES = 4096` | `limits_exceeded` (`animation_track_times`) |
| A5 | every clip duration ≤ `ANIMATION_PROFILE_MAX_CLIP_MS = 10 000` (`metrics.clipDurationMs` covers the longest) | `limits_exceeded` (`animation_clip_duration`) |
| A6 | no channel targets a **scene root node** with path `translation` (root motion would double-move the entity holder: the entity transform already moves the model holder) | `animation_root_motion` |

A1–A6 run after stages 1–6 (so the binding is structurally valid and names the
version's real clips before the profile is judged). Stages 5–6 already use this
proposal's real clip list; there is no separate re-check.

Non-normative notes. "Animated tracks away from the entity's physics holder"
is realized by A6: the GLB scene root is exactly the node whose accumulated
transform the adapter's entity holder supplies, so a translation track on it is
root motion. A downward-facing translation track on a non-root internal node
(e.g. a bob) is allowed. Rotation/scale tracks on root nodes are allowed
(a rigid turntable decoration is legal). Materials remain authored in the GLB:
`surface` never overrides GLB material slots and no material-slot reference is
persisted (`project-model.md` §23.3.5, accepted §18.1).

### 41.3.4 Atomic reimport — new bytes and new mapping in one revision

A reimport of an asset that any entity references through
`components.modelAnimation` must submit the **new mapping with the new bytes**.
The command addition (destination `commands.md` §8.5, requested from 39's
`commands.md` §8.5/§9.1 — see C41-2/C41-3 in `commands.md`):

```ts
// publishAsset args gain, on mode: "reimport":
animation?: {
  entityId: string;                 // the referencing entity
  roles: ModelAnimationRoles;       // the new version-local binding
};
```

Rules (normative):

1. When `mode === "reimport"` and the scene contains **at least one** entity
   whose `components.modelAnimation.assetId` equals the published `assetId`,
   `animation` is **required**; absent ⇒ `field_missing` at
   `/args/animation`. A reimport of an unreferenced or non-animated asset does
   not require it. There is no silent "keep the old mapping".
2. `entityId` must resolve (`entity_not_found`), must carry `modelAnimation`
   (`component_missing`, `expected: "modelAnimation"`), and its
   `modelAnimation.assetId` must equal the published `assetId`
   (`component_conflict`, `reason: "animation_asset"`).
3. The appended `AssetVersion` and the updated `modelAnimation` component
   are applied in **one** transaction: one revision, one history entry. The
   component update moves the entity's `version` to the newly appended
   version and replaces `roles` with the submitted mapping — the binding is
   owned by that `(assetId, version)` (§41.3.1), so the new mapping is only
   valid against the new version's clip list; a roles-only update would leave
   the entity recording the previous version and capture would keep
   resolving it to the previous bytes (project-model §19.2: the recorded
   version wins over `currentVersion`) — a silent no-op success. The change
   is `{ type: "publishAsset", mode, assetId, previous, next, animation: {
   entityId, previous: ModelAnimationComponent, next: ModelAnimationComponent } }`
   (full components, project-model §23.3.6); the inverse restores both the
   previous record and the previous `modelAnimation` component (full value,
   so the rolled-back `currentVersion` and the restored `version` stay a
   valid binding) (or removes the created record and restores the
   previous binding). `undo`/`redo` move both together or neither.
   (CC-L-1, Gate L: the §41.3.1/commands.md §8.5.1 roles-only wording is
   superseded by this rule.)
4. Publication is validated against the **new** version's proposal
   (stages 1–6 of §41.3.2 and §41.3.3 A1–A6). Any rejection preserves the previous
   `currentVersion`, the previous bytes, the previous `roles` value, the
   revision and the history — nothing is written, no partial record exists
   (`project-model` §18.1 rule 6).
5. Reordered clips with an equivalent mapping work: `courier-reordered.glb`
   stores the same three clips in a different order; the submitted mapping
   `{idle:{clipIndex:2,…}, run:{clipIndex:1,…}, airborne:{clipIndex:0,…}}`
   is accepted and the referencing entity keeps its entity ID, transform and
   every other component (accepted §18.1 rule 5).
6. After a valid reimport the runtime loads the new version against the new
   mapping; a runtime that is already playing keeps its pinned snapshot and is
   never silently re-pointed (accepted §19.3/§19.2 pinning; 53's "authored bytes
   stay pinned during active play").

### 41.3.5 The §18.1 rule-3 replacement (exact)

The **only** accepted-model rule this packet replaces is
`project-model.md` §18.1 rule 3, and only for version-bound clip-role mapping.
The exact OLD/NEW text is in `project-model.md` (packet-41 section,
row PM41-1). In summary: the exception is scene-only, scoped to one immutable
`(assetId, version)`, invalidated by reimport, validated against the version's
real clip list at publication and load, never used as a lookup key, and it
permits no other persisted internal glTF name or index anywhere.

### 41.3.6 The runtime role selector and the bounded crossfade

The selector is a `three-adapter` addition realized in packet 53 (root subpath
— **no new subpath**):

```ts
type AnimationRoleName = 'idle' | 'run' | 'airborne';

interface AnimationRoleState {
  readonly role: AnimationRoleName;
  readonly weights: { readonly idle: number; readonly run: number; readonly airborne: number };
  readonly blending: boolean;          // true while a crossfade is in progress
  readonly stepIndex: number;          // the committed step the selector last consumed
}

interface AnimationRoleController {
  /** Validate and install the committed mapping against this instance's clips. */
  setRoles(roles: ModelAnimationRoles, version: number): { ok: true } | { ok: false; error: AdapterError };
  /** One host-driven advance; the host owns the frame loop. */
  update(deltaSeconds: number): { ok: true } | { ok: false; error: AdapterError };
  state(): AnimationRoleState;
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true } | { readonly ok: false; readonly error: AdapterError };
}
```

Normative rules:

1. **Input is the committed read-only view.** The selector consumes
   `GameView.state` and `GameView.playerMotion` (§41.3.7 request C41-1) plus the
   entity's committed interpolated transform; it never reads authoring state,
   never samples input, and never writes any transform.
2. **One host-driven update.** `update(deltaSeconds)` is called by the host
   frame (`runtime.onFrame` consumer) exactly once per rendered frame with the
   real frame delta; the controller installs **no** `requestAnimationFrame`, no
   timer, no mixer listener. `deltaSeconds` must be finite and
   `0 ≤ deltaSeconds ≤ 0.25` (`preview_invalid` otherwise).
3. **Role selection (fixed, no tuning key).** With `grounded` and `speed` from
   the committed view:
   `airborne` iff `!grounded`; else `run` iff `speed > RUN_SPEED_EPS`; else
   `idle`. `RUN_SPEED_EPS = 0.05` m/s. The selector is a pure function of the
   committed view: the same view yields the same role, and a role change is
   only ever driven by a committed step.
4. **Bounded crossfade.** `ANIMATION_CROSSFADE_SECONDS = 0.2`. A role change
   starts a single crossfade of exactly that duration between the outgoing and
   incoming actions (`THREE.AnimationAction.crossFadeTo`, `warp = false`); the
   weights are `1 − t/0.2` and `t/0.2` over the fade, and `blending` is `false`
   afterwards. Crossfades never overlap: a new role change while blending
   retargets the fade (the previous incoming action becomes the outgoing one).
5. **Independent state per instance.** Every `ModelInstance` owns its own
   `THREE.AnimationMixer` and its own `AnimationAction` objects. Two instances
   of the same `PreparedVisualResource` can be in different roles at the same
   time and the weight change of one never touches the other (the packet-38
   probe already showed one mixer unaffected by another). No global mixer, no
   shared action, no shared clock.
6. **No physics writes, no second loop, no root motion.** The selector writes
   only mixer time and action weights. It never writes entity transforms, never
   calls the runtime, physics or `PhysicsPort`, and never applies clip
   translation to the entity holder. It mutates no resource owned by the shared
   `PreparedVisualResource`.
7. **Invalid or absent mapping is a hard presentation failure, not a fallback.**
   `setRoles` returns `animation_role_unresolved` when the loaded clips do not
   satisfy the committed mapping (stage 5–6 re-check). The host then renders
   the model **statically at its committed transform** (no animation), records
   one bounded diagnostic, and the **role selector for that model does not run**
   (the runtime's run proceeds with the model static — the model itself loaded
   successfully; the residual case is digest-gated defense-in-depth, the accepted
   load-time re-check of the publish-validated mapping). A corrupt/undeclared
   declared asset is never silently mislabelled. Absent `modelAnimation` on an
   entity means "no selector"; that is not an error.
   **Non-player input (M4, C64-3 — clarification).** The committed view carries the
   player's motion only. For a **non-player** animated entity the selector's
   view is the constant neutral motion `{ speed: 0, grounded: true }`, so the
   accepted pure selection yields `idle` with no blending and no
   `run`/`airborne`. No new selector API, no tuning key, no second motion
   source.
8. **Disposal while blending is safe.** `dispose()` stops and uncaches its
   actions, releases the mixer and the instance-manager entry exactly once, and
   is idempotent (`alreadyDisposed: true` on the second call). Disposing an
   instance does not dispose the shared resource while another instance lives.

### 41.3.7 Read-only committed motion (request C41-1 to packet 40)

The selector needs two committed facts. `GameView` now carries them: the field
below was committed to `gameplay.md` §6 by the Gate K repair (**C41-1 resolved**,
**K-2/FU-4**; runtime row `runtime.md` R40-17):

```ts
interface PlayerMotion {
  readonly speed: number;      // |Δ| over the last completed motion segment × fixedStepHz, m/s, finite ≥ 0
  readonly grounded: boolean;  // the controller's committed grounding after that step
}
// GameView gains:  readonly playerMotion: PlayerMotion;
```

`playerMotion` is committed at the same point as the rest of the view (phase 8 /
the reset boundary), is `speed = 0, grounded = true` in `awaitingStart` and
`won`, is never fed back into the run, and adds no second simulation. The
motion value is derived from `lastMotionSegment(playerId)` (40 §3.3) and the
controller's committed grounding; `gameplay.md` §6 owns the exact derivation
(**no new state, no second writer**), 49/50 publish it and 53 consumes it. The
field is committed contract text; the earlier "if packet 40 declines" fallback
no longer applies, and the selector's input is no longer unnamed.

---

## 41.4 Audio: the bounded PCM WAV profile and the browser owner

### 41.4.1 Container and chunk rules (exact)

Accepted type: **RIFF/WAVE, linear PCM (format tag 1), mono, signed 16-bit
little-endian, 48 000 Hz, untagged, exactly two chunks.** The file is exactly
44 + `dataBytes` bytes; there is no padding, no trailing byte, no extra chunk.

| Offset | Size | Field | Required value |
|---|---|---|---|
| 0 | 4 | `RIFF` magic | ASCII `RIFF` |
| 4 | 4 | `riffSize` | uint32 LE, exactly `bytes.length − 8` |
| 8 | 4 | `WAVE` form | ASCII `WAVE` |
| 12 | 4 | chunk id | ASCII `fmt ` |
| 16 | 4 | `fmtSize` | uint32 LE, exactly `16` |
| 20 | 2 | `audioFormat` | uint16 LE, exactly `1` (PCM integer) |
| 22 | 2 | `channels` | uint16 LE, exactly `1` |
| 24 | 4 | `sampleRate` | uint32 LE, exactly `48000` |
| 28 | 4 | `byteRate` | uint32 LE, exactly `96000` (`48000×1×16/8`) |
| 32 | 2 | `blockAlign` | uint16 LE, exactly `2` (`1×16/8`) |
| 34 | 2 | `bitsPerSample` | uint16 LE, exactly `16` |
| 36 | 4 | chunk id | ASCII `data` |
| 40 | 4 | `dataBytes` | uint32 LE, exactly `bytes.length − 44`, even, `2 ≤ dataBytes ≤ 192000` |
| 44 | `dataBytes` | PCM samples | int16 LE, `frames = dataBytes / 2` |

The 44-byte header is exact: `RIFF`(12) + `fmt ` chunk (8 + 16) + `data`
chunk header (8). A `fmt ` chunk of any other size (including 18 with a
`cbSize`), a `LIST`/`fact`/`bext`/`cue `/`smpl` chunk, RF64/RIFX/BW64, an odd
`dataBytes`, zero frames, trailing bytes and any declared/actual length
disagreement are rejected.

### 41.4.2 Byte accounting (normative)

```text
frames        = dataBytes / 2                    (integer)
pcmBytes      = dataBytes                        (== frames × 1 × 2)
sourceBytes   = 44 + dataBytes                   (== sourceByteLength)
durationMs    = floor(frames × 1000 / 48000) = floor(frames / 48)   (integer)
byteRate      = 48000 × 1 × 16 / 8 = 96000
blockAlign    = 1 × 16 / 8 = 2
```

Caps (all inclusive) and their exact arithmetic:

| Cap | Value | Equivalent |
|---|---|---|
| `pcmBytes` (`== dataBytes`, the primary bound) | `192000` | 96 000 frames × 1 channel × 2 bytes |
| frames (derived) | `96000` | `pcmBytes / 2` |
| `durationMs` (derived) | `2000` | `floor(96000 / 48)` |
| `sourceByteLength` (derived) | `192044` | `44 + pcmBytes` |
| source-file hard bound (stage 1, before any profile cap) | `196608` | 192 KiB; rejects a file that is not even a plausible cue before the PCM cap is read |
| referenced cues (distinct audio assets named by `content.game.cues` + checkpoint `activation.cueAssetId`) | `6` | 5 cue keys + 1 optional activation cue |

The `pcmBytes ≤ 192000` cap is the single normative PCM bound; `frames`,
`durationMs` and `sourceByteLength` are exact derived quantities reported in
`PcmWavMetrics`, not independent tunables (at these constants a byte cap and a
duration cap are the same statement, so only the byte bound is a `limits_exceeded`
limit name). The **decoded** byte count is
`pcmBytes` (Web Audio's decoded `AudioBuffer` holds `frames × channels`
float32 samples, but no float size is persisted or capped: the source PCM cap is
the contract bound). `content.assets.audio_assets ≤ 16` and
`audio_versions ≤ 8` remain packet 39's.

### 41.4.3 The audio import recipe and metrics

```json
{
  "profile": "pcm-wav",
  "recipeVersion": 1,
  "toolchain": { "asset-pipeline": "0.1.0" }
}
```

| Field | Rule |
|---|---|
| `profile` | exactly `"pcm-wav"` for an audio version; `"gltf-glb"` for a model version |
| `recipeVersion` | exactly `1`; advances when a *decision* changes (which header fields feed metrics, how caps are applied) |
| `toolchain` | 1–8 entries, keys ascending codepoint order; for `pcm-wav` exactly `{ "asset-pipeline": "<the repository's pinned package version>" }` — the only tool whose version can change the inspected result. There is no decoder, no `three`, no codec library, and no Node built-in in the inspection path |
| `extensions` | present and `[]` for `gltf-glb`; **absent** for `pcm-wav` (there are no glTF extensions in a WAV) |

`recipeDigest = SHA-256(canonical JSON of importRecipe)` with the accepted
canonical JSON rules (`commands.md` §6.6 rule 2, `importRecipeDigest`).
`metadataDigest` is the accepted `importMetadataDigest` over
`{status, kind, sourceDigest, sourceByteLength, importRecipe, metrics}`.

`PcmWavMetrics` (the audio `metrics` member):

```ts
interface PcmWavMetrics {
  container: 'riff-wave';
  encoding: 'pcm-s16le';
  channels: 1;
  sampleRate: 48000;
  bitsPerSample: 16;
  frames: number;          // 1..96000
  durationMs: number;      // floor(frames / 48), ≤ 2000
  pcmBytes: number;        // == frames * 2, ≤ 192000
  dataChunkBytes: number;  // == pcmBytes
  riffChunkBytes: number;  // == 36 + pcmBytes
}
```

Canonical key order is exactly the field order above. On every load the
workspace re-checks `sourceByteLength === 44 + pcmBytes` and every cap of
§41.4.2 against the record; a disagreeing record is invalid
(`limits_exceeded`/`field_value`), never normalized. This is the direct
analogue of the accepted GLB "re-validated against the caps on every load"
rule (`project-model` §18.6). **CC-47-1 (promoted at Gate L):** the packet-39
audio placeholder records (`catalog/audio-asset-record-v3.json`,
`envelope/valid/demo-0003-media-v3.json`, `envelope/invalid/cue-kind-mismatch.json`)
were regenerated to this section at packet 47; the two contract envelopes'
`components.modelAnimation.roles` still carry the packet-41 `{"binding":
"packet-41-placeholder"}` stub, which §23.3.6 accepts as a non-empty object but
§41.3.1's real `AnimationRoleBinding` rejects — packet 53 owes a real-roles
fixture before its `setRoles` evidence.

### 41.4.4 Inspection order and rejection codes

`inspectAudio(bytes, options)` (packet 47, `asset-pipeline`; no I/O, no Node
built-in, no decoder, no network) runs these stages in order and stops at the
first failing stage; a stage may collect independent diagnostics. Codes are the
audio additions to the accepted `ImportDiagnosticCode` set.

| # | Stage | Rejects with |
|---|---|---|
| 1 | size: `44 ≤ bytes.length ≤ 196608` | `audio_source_bytes_exceeded` |
| 2 | container: `RIFF`/`WAVE` magic; `riffSize === bytes.length − 8` | `audio_container_invalid` |
| 3 | chunk framing: first chunk `fmt ` with `fmtSize === 16`; second chunk `data`; chunk bytes exactly fill the file; no third chunk; no trailing byte | `audio_chunk_invalid` |
| 4 | format: `audioFormat === 1` | `audio_format_unsupported` |
| 5 | channels: `channels === 1` | `audio_channel_unsupported` |
| 6 | rate: `sampleRate === 48000` | `audio_sample_rate_unsupported` |
| 7 | depth: `bitsPerSample === 16` | `audio_bit_depth_unsupported` |
| 8 | derived header arithmetic: `byteRate === 96000`, `blockAlign === 2` | `audio_chunk_invalid` |
| 9 | data size: `dataBytes === bytes.length − 44`, `dataBytes` even | `audio_data_size_invalid` |
| 10 | non-empty: `dataBytes ≥ 2` (⇒ `frames ≥ 1`) | `audio_empty` |
| 11 | PCM byte cap: `dataBytes ≤ 192000` | `limits_exceeded` (`audio_pcm_bytes`) |
| 12 | accept: emit `PcmWavMetrics` exactly, the recipe, and a bounded inspection summary (no sample data) | — |

Rejection is **not** driven by a file
extension, a caller-supplied MIME type or a declared `kind`: the bytes alone
decide. `kind`/`profile` mismatch is a publication error:
`asset_kind_mismatch` (accepted, 39 §23.3.7). No URL, `data:`, HTTP, archive
or compressed (ADPCM/µ-law/A-law/float) form is ever accepted; a non-WAV byte
string fails stage 2.

### 41.4.5 Cue references and the six-cue bound

`content.game.cues` has exactly five keys (`start`, `jump`, `checkpoint`,
`death`, `goal`; 39 §23.4) and each is `null` or an `assetId` resolving to
`kind: "audio"`; a checkpoint's `activation.cueAssetId` is `null` or another
`audio` asset. The **distinct** referenced audio assets are counted and capped
at `AUDIO_MAX_REFERENCED_CUES = 6` (`limits_exceeded` `audio_cues`). **CC-47-5
(promoted at Gate L):** because `content.game.cues` has exactly five fixed keys
and the scene allows at most one checkpoint zone (§`zone_checkpoint_count_invalid`,
`checkpointZones = 1`), the maximum distinct referenced audio assets is
exactly `5 + 1 = 6`; the value is therefore a **structural maximum, not a
reachable rejection bound** (no valid v3 state can exceed it). It stays in the
closed limit-name set so the vocabulary is complete and a future key-set change
cannot silently escape the cap. The
catalog may hold up to 16 audio records (39) — unreferenced audio is legal
authoring data. Every reference resolves at load; a dangling cue is
`game_reference_missing`/`asset_reference_missing` (39 §23.9), never silently
dropped.

### 41.4.6 Corrupt/missing (hard) vs policy denial (sound-off)

| Situation | Class | Outcome |
|---|---|---|
| a referenced audio blob is missing or its bytes do not match the recorded digest | **hard** | `blob_missing`/`blob_corrupt` on read; the Play/export build fails closed (`export_failed`), no partial output replaces a previous one, and no runtime starts |
| a persisted audio version's metrics disagree with its bytes/caps on load | **hard** | model load error (`field_value`/`limits_exceeded`); bytes retained, nothing rewritten |
| a declared cue asset is of the wrong `kind` | **hard** | `asset_kind_mismatch` at validation/publication |
| `AudioContext` is absent or undeclared by the environment | **soft** | status `sound-off` (`unsupported`); the game plays silently, all keys/gamepad completion works, HUD shows an honest sound status |
| autoplay policy rejects `resume()` / no audio output device | **soft** | status `sound-off` (`blocked`); an in-game local "Enable sound" gesture may retry |
| the user mutes | **soft** | status `muted`; nothing is decoded or played |
| a cue's decode throws at runtime | **soft** | the cue is skipped, one bounded diagnostic is recorded, the game continues |

Hard failures are never converted into a silent sound-off, and a policy denial
is never reported as a content failure. `stop()`/`replay` never require audio.

### 41.4.7 The injected browser audio interface

The owner is created in packet 54 in the browser entry of the new
`game-host` package (DOM/`window` access is isolated there; the pure runtime
never constructs an `AudioContext`, never imports the owner and never sees
bytes). The host injects it; the owner itself is deterministic and testable
with an injected context factory.

```ts
type CueKind = 'start' | 'jump' | 'checkpoint' | 'death' | 'goal';

interface GameCueEvent {              // typed, committed; derived from GameView.events + content.game.cues
  readonly id: string;                // the GameEvent id `${runId}/${kind}/${stepIndex}` — the dedupe key
  readonly kind: CueKind;
  readonly assetId: string;
  readonly runId: string;
  readonly stepIndex: number;
}

type GameAudioStatus =
  | { readonly state: 'unsupported'; readonly reason: 'no_audio_context' }
  | { readonly state: 'blocked'; readonly reason: 'autoplay_denied' | 'no_device' }
  | { readonly state: 'ready'; readonly muted: boolean; readonly unlocked: boolean }
  | { readonly state: 'disposed' };

interface GameAudioOwner {
  /** Register verified bytes for one asset (bytes in — never a URL, token or fetch). */
  registerCue(assetId: string, bytes: Uint8Array): { ok: true } | { ok: false; error: GameAudioError };
  /** Committed cue events, in view order; may be called every frame. */
  submit(events: readonly GameCueEvent[]): { ok: true } | { ok: false; error: GameAudioError };
  /** A local user gesture (never a relayed/synthetic message). */
  unlock(): Promise<GameAudioStatus>;
  setMuted(muted: boolean): GameAudioStatus;
  setHidden(hidden: boolean): GameAudioStatus;
  status(): GameAudioStatus;
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true };
}

interface GameAudioError {
  readonly code: 'audio_decode_failed' | 'audio_unsupported' | 'audio_disposed' | 'audio_invalid_bytes';
  readonly message: string;   // ≤ 256 chars, log-safe
}
```

Normative rules:

1. **Bytes in only.** `registerCue` takes a `Uint8Array` the host obtained
   through the accepted immutable blob read. There is no URL, locator,
   `data:` string, `fetch`, `XMLHttpRequest`, `Audio` element or base64 payload
   in the owner, in the bridge, or in any WebSocket frame (delivery request
   C41-5). Cue events carry `assetId` only.
2. **Decode is bounded and asynchronous.** `decodeAudioData` is used on a copy
   of the supplied bytes; a decode failure is a bounded per-cue diagnostic,
   never a throw across the host boundary. Bytes are never mutated.
3. **Voice cap.** At most `AUDIO_MAX_VOICES = 8` voices sound concurrently. A
   new cue when all 8 are busy is dropped with a bounded diagnostic
   (`voice_cap`), never queued unboundedly and never allowed to grow the voice
   set. Every voice is released on `ended`/stop.
4. **Dedupe by run/event identity.** Each `GameCueEvent.id` is played at most
   once per owner; a repeated `submit` with the same `id` is a no-op. Dedupe
   memory is bounded: the ids of the current `runId` are kept, and a `runId`
   change clears them (`checkpointActivated` therefore never refires on
   re-entry — 40 §4.5).
5. **Stale async work is cancelled.** `stop()`/`replay` (a `runId` change) and
   `dispose()` mark every in-flight decode and pending voice as stale: a decode
   that resolves afterwards is discarded and its buffer closed, never played.
   A cue from a previous run is never replayed into a new run.
6. **Suspend on hidden/stop.** `setHidden(true)` and runtime `stop()` suspend
   the owned `AudioContext` (no sound while the tab is hidden) and
   `setHidden(false)` attempts `resume()` only when already unlocked; a
   rejected resume degrades to `blocked` status, not an error. Hidden-resume
   never fast-forwards or replays accumulated cues.
7. **Local gesture unlock only.** `unlock()` is effective only from a real
   local user gesture inside the preview/game (keyboard/gamepad/pointer
   listener). A `postMessage`, an MCP relay, a synthetic `dispatchEvent` and a
   programmatic call are not trusted activation: they never unlock and never
   make sound. Gameplay, HUD and goal completion never wait for audio.
8. **Close on dispose.** `dispose()` closes exactly the contexts it created,
   once; a second call returns `alreadyDisposed: true`. Closing is synchronous
   with respect to the owner's public state: after `dispose()`, every other
   method returns `audio_disposed`/`disposed`.
9. **Never a server sound device.** No backend, MCP, export build or Node
   process decodes, plays or probes audio; the backend only stores and serves
   bytes. A headless container has no audio device (packet-38 baseline §1), so
   audibility stays **UNVERIFIED** by this contract and must be witnessed on a
   real device at 54/62.

### 41.4.8 What is not promised

No spatial/3D audio, no streamed or background music, no compressed formats,
no remote or CDN audio, no per-frame resampling claim, no gapless timing, no
decibel/bit-exact playback claim, and no autoplay success. packet-38 baseline §1
records that PCM decode and a real gesture reaching `running` were executed,
but audibility itself is UNVERIFIED (no audio device), and counters/analysers
are not audible output.

---

## 41.5 Checkpoint activation appearance (PR-1)

### 41.5.1 The data

The authored value is packet 39's `CheckpointActivationAppearance`
(`project-model.md` §23.3.1a), required on every `role: "checkpoint"` zone:

| Field | Type | Constraint |
|---|---|---|
| `emissive` | string | `^#[0-9a-fA-F]{6}$`, canonical lowercase |
| `emissiveIntensity` | number | `[0, 4]` |
| `cueAssetId` | string or `null` | when non-null, resolves to `kind: "audio"`; `null` means "use `content.game.cues.checkpoint`" |

Canonical key order `emissive`, `emissiveIntensity`, `cueAssetId`; the
normalizer never fills an `activation` sub-field. This contract adds no field
and renames none. The PR-1 requirement is a **visible** change plus a cue: the
checkpoint's own marker material changes emissive color/intensity, and the
checkpoint cue sounds once per run.

### 41.5.2 The read-only view bit and its lifetime

The adapter consumes exactly the committed read-only bit published by packet 40
(`gameplay.md` §6): `GameView.checkpointActive` (`boolean`) and
`GameView.checkpointId` (`string | null`). No other runtime surface, no event
replay and no authoring read is involved.

| Run moment | `checkpointActive` | `checkpointId` | Presentation |
|---|---|---|---|
| `awaitingStart` | `false` | `null` | checkpoint marker renders its authored `surface` values |
| `playing`, before activation | `false` | `null` | same |
| the commit that activates the checkpoint | `true` | the zone entity id | the adapter applies the appearance in that frame |
| `respawning` after activation | `true` | retained | appearance retained (no flicker during the delay) |
| `playing` after respawn | `true` | retained | retained |
| `won` | retained | retained | retained |
| `replay` | `false` | `null` | appearance reverted to the authored `surface` in the first frame of the new run |
| a death before any checkpoint | `false` | `null` | never activated; unchanged |
| runtime `failed` | last committed value retained (40 §6) | retained | unchanged; no further transition |

The appearance is **derived, never persisted**: the run stores only the bit and
the id; the emissive values live in the frozen snapshot's checkpoint component.
No runtime step, view or event carries the color.

### 41.5.3 Realization (52, 53, 57)

- **52** realizes the material change through the shared resource owner: when
  `checkpointActive` transitions `false → true` and `checkpointId` resolves to
  a zone entity carrying `box`/`model` + `surface`, it writes that entity's
  **own material instance** `emissive`/`emissiveIntensity` to the
  `activation` values; on `true → false` (replay) it restores the entity's
  `surface` `emissive`/`emissiveIntensity`. Exactly one material-instance write
  per transition, no new resource, no shared-material mutation, no effect on
  another entity. A checkpoint zone without a visual marker simply has nothing
  to change (the zone itself is never rendered).
- **53** raises the checkpoint cue from the committed
  `checkpointActivated` event (dedupe by event id, §41.4.7 rule 4) — including
  the `activation.cueAssetId` override when non-null. The checkpoint transitions
  are independent: the cue is driven by the event, the material by the bit.
- **57** authors the value through the existing `setComponent(zoneId,
  "gameZone", { role: "checkpoint", safeSpawnId, activation })` path
  (`commands.md` §12 row 11). It shows a preview through the same injected
  `game-host` audio owner and the same adapter material path; it introduces no
  second scene mutation path and no session-local appearance state.
- **55** renders HUD checkpoint text only; per `m3-plan.md` §2.1, HUD text alone
  does not satisfy this requirement.

---

## 41.6 Ownership and lifetime table

Every resource has exactly one creator and one disposer. "Once" means the
disposer is idempotent (`alreadyDisposed: true` on repeat) and no other unit
releases the resource.

| Resource | Creator | Disposer (exactly once) | Counter / observable |
|---|---|---|---|
| `WebGLRenderer` + canvases | `three-adapter` `createSceneAdapter` | `SceneAdapter.dispose()` | `diagnostics().renderer` state; `adapter_disposed` after |
| shadow map (`directional.shadow.map`) | `three-adapter` realization of a casting light | `SceneAdapter.dispose()` (three releases it with the light) | `diagnostics().shadows`/`shadowReason`; `shadowMapAllocated` probe (38) |
| scene lights (key/fill) | `three-adapter` per realized scene | `SceneAdapter.dispose()`; replacing a scene realization releases the previous nodes | light count ≤ 2 |
| `BufferGeometry` (primitive boxes) | `three-adapter` box realization | the owning model/box instance's `dispose()` | `visual-resource` ledger `geometries` |
| `MeshStandardMaterial` (per entity `surface`/preset) | `three-adapter`, one per placed entity | that entity instance's `dispose()` | ledger `materials` |
| GLB geometries/materials/textures | the injected `GlbLoaderPort` (`LoadedGlb`) | `PreparedVisualResource.dispose()` after the last instance is gone (`LoadedGlb.dispose()` once) | `PreparedVisualResource.ownership()` ledger |
| `ModelInstance` holder `Group` | `PreparedVisualResource.createInstance()` | that `ModelInstance.dispose()` | `diagnostics().instances` |
| `THREE.AnimationMixer` (rigid roles or preview) | the instance's role controller / preview controller | that controller's `dispose()` | `AnimationRoleState`; controller idempotence |
| `AnimationAction` objects | the instance's controller (`clipAction`) | that controller's `dispose()` (`stop()` + `uncacheAction`) | action count ≤ 3 for roles |
| `AudioBuffer` (decoded cue) | `game-host` audio owner (`decodeAudioData`) | owner `dispose()` (or per-cue replace/eviction) | registered cue count |
| voice source nodes/gains | `game-host` audio owner | owner `dispose()`/`ended` | live voices ≤ `AUDIO_MAX_VOICES`; `voice_cap` drops |
| `AudioContext` | `game-host` audio owner (or an injected factory) | owner `dispose()` (`close()`, once) | `status()` becomes `disposed` |
| preview override materials | `AssetPreviewController` | that controller's `dispose()` | preview controller state |

Repeated create/dispose rules (normative):

1. Every public `dispose()` is idempotent and returns
   `alreadyDisposed: true` on repetition; no double free, no throw.
2. Disposing the last `ModelInstance` releases shared GLB resources exactly
   once; disposing one of two instances leaves the other fully usable.
3. One instance's material/emissive/mixer change never changes another
   instance or the shared resource (fixture `ownership/ownership-cases.json`).
4. An authoring edit (preset/surface/role mapping) reaching a host through a
   new snapshot releases the previous realization through the host's normal
   replace path, exactly once; the adapter keeps no authoring reference.
5. Failing mid-load releases everything already created (`prepareVisualResource`
   counters return to zero); a cancelled/superseded load releases a late
   completion (packet-26 behavior, unchanged).
6. `stop()`/`replay` dispose no shared visual resource; only the host's frame
   consumer stops. A stopped runtime can be started again without re-creating
   the shared resource.

---

## 41.7 Limits, errors and diagnostics

### 41.7.1 Finite limits (this contract's additions)

| Class | Bound | Value | Failure |
|---|---|---|---|
| animation | clips in the animated profile | 8 | `limits_exceeded` (`animation_clips`) |
| animation | channels total / per clip | 64 / 32 | `limits_exceeded` (`animation_tracks`) |
| animation | sampler input keyframes summed | 4096 | `limits_exceeded` (`animation_track_times`) |
| animation | longest clip duration | 10 000 ms | `limits_exceeded` (`animation_clip_duration`) |
| animation | canonical `roles` bytes (39) | 4096 | `limits_exceeded` (`animation_profile_bytes`) |
| animation | crossfade | 0.2 s (constant, not authored) | — |
| audio | PCM bytes (frames/duration derived, §41.4.2) | 192 000 | `limits_exceeded` (`audio_pcm_bytes`) |
| audio | source-file hard bound (stage 1) | 196 608 | `audio_source_bytes_exceeded` |
| audio | referenced cues | 6 (a structural maximum: 5 fixed cue keys + ≤1 checkpoint activation; not a reachable rejection bound — CC-47-5) | `limits_exceeded` (`audio_cues`) |
| audio | concurrent voices | 8 | bounded diagnostic `voice_cap` (drop, not error) |
| lighting | directional / ambient lights (39) | 1 / 1 | `limits_exceeded` (`lights_directional`/`lights_ambient`) |
| shadow | shadow half-extent | 64 m | `shadow_bounds_exceeded` → shadow-off diagnostic |

All values are contract constants, not `content.settings` keys (39 §23.12,
40's C40-D1 pattern). No new settings key is proposed.

### 41.7.2 Closed code sets

**A. Model/command codes** (destination: `commands.md` §5.4 rows,
`project-model.md` §23.9 vocabulary; class `validation` unless noted):

| Code | Carries | Raised when |
|---|---|---|
| `animation_role_out_of_range` | `path`, `role`, `clipIndex`, `clips` | a binding's `clipIndex` ≥ the named version's `metrics.animations` |
| `animation_role_duplicate` | `path`, `clipIndex`, `roles` | two roles share a `clipIndex` |
| `animation_role_mismatch` | `path`, `role`, `expected`, `found` | `clipName ≠ clips[clipIndex].name` (inspection/publication/load) |
| `animation_role_ambiguous` | `path`, `role`, `clipName`, `matches` | the version's clip list has more than one clip named `clipName` |
| `animation_skin_unsupported` | `path` | the animated-profile GLB carries `skins` or a `JOINTS_0`/`WEIGHTS_0` attribute |
| `animation_root_motion` | `path`, `role`, `nodeIndex`, `nodeName` | a channel animates a scene root node's `translation` |

**B. `limits_exceeded` limit-name additions:** `animation_clips`,
`animation_tracks`, `animation_track_times`, `animation_clip_duration`,
`audio_pcm_bytes`, `audio_cues`.

**C. `asset-pipeline` audio diagnostic codes** (added to
`ImportDiagnosticCode`; returned on a `status: "rejected"` proposal):
`audio_source_bytes_exceeded`, `audio_container_invalid`, `audio_chunk_invalid`,
`audio_format_unsupported`, `audio_channel_unsupported`,
`audio_sample_rate_unsupported`, `audio_bit_depth_unsupported`,
`audio_data_size_invalid`, `audio_empty`; the PCM-cap stage reports
`asset_limits_exceeded` with the §41.7.1 limit name. `kind`/profile mismatch
reports `asset_kind_mismatch` at publication.

**D. `three-adapter` code addition:** `animation_role_unresolved`
(validation-class, hard) — the loaded version's clips do not satisfy the
committed mapping (§41.3.6 rule 7); `models_config_invalid` (validation-class,
hard) — the M4 `models` block is structurally invalid against the snapshot
(scene without `modelAnimation`/`model` mismatch, or present on a non-v3
scene) (M4 `delivery.md` §2.2); `models_asset_unresolved` (validation-class,
bounded diagnostic) — a `model` entity's `assetId` resolves to no declared
asset row (defensive residual; unreachable for a well-formed capture) (M4
`delivery.md` §2.3). The accepted adapter code set is otherwise unchanged
(no `shadow_*` error: degradation is a diagnostic, not an error).

**E. `game-host` audio codes** (packet 54, its own closed set):
`audio_decode_failed`, `audio_unsupported`, `audio_disposed`,
`audio_invalid_bytes`; plus the bounded status/`voice_cap` diagnostics.

### 41.7.3 Destination rows

| Set | Destination | Owner |
|---|---|---|
| A + B | `commands.md` §5.4 (rows + extended `limits_exceeded` names), `project-model.md` §23.9 mirror | this packet's `commands.md` section, promoted at K |
| C | `asset-pipeline` `ImportDiagnosticCode`/`ImportLimitName` (packet 47 implements) | this packet's `commands.md` note; 47 realizes. **CC-47-4 (promoted at Gate L):** the pipeline also carries the six §41.7.2 A codes verbatim (`animation_role_*`, `animation_skin_unsupported`, `animation_root_motion`), because `inspectGlb`'s animated profile reports them at stages 5–7; the §41.3.2 stage-1/2 container failures stay model-owned (`field_*`) |
| D | `three-adapter` `ERROR_CODES` (packet 52) | 52 realizes from this contract |
| E | `game-host` (packet 54) | 54 realizes from this contract |

---

## 41.8 Fixtures

`fixtures/m3/media/**` (self-generated, redistribution-safe bytes; no
downloaded asset):

| Group | Content |
|---|---|
| `glb/courier-roles.glb`, `glb/courier-reordered.glb` | positive rigid-node GLBs with `Idle`/`Run`/`Airborne` clips; the reordered file stores them in a different order |
| `glb/bad-skin.glb`, `glb/bad-root-motion.glb`, `glb/dup-names.glb`, `glb/many-clips.glb`, `glb/many-tracks.glb`, `glb/long-clip.glb` | negatives for §41.3.3 |
| `glb/profile-cases.json` | every §41.3.2/§41.3.3 case with the re-derived verdict/code |
| `wav/cue-*.wav` (five cues + `cue-max.wav` at exactly 96 000 frames) | positive PCM cases |
| `wav/rejections/*.wav` | one negative per §41.4.4 stage |
| `wav/wav-cases.json` | per-file re-derived header arithmetic, metrics and verdict |
| `render/light-surface-cases.json` | light validation, the three preset rows, preset independence, shadow profile/degradation cases |
| `activation/appearance-cases.json` | appearance values + the `checkpointActive` timeline |
| `ownership/ownership-cases.json` | creator/disposer/counter and repeated-dispose/isolation cases |
| `audio/audio-cases.json` | voice cap, dedupe, stale cancellation, hide/suspend, dispose-once, sound-off statuses |
| `errors/codes.json` | the closed code sets of §41.7.2 and their classes |

`tools/generate-fixtures.mjs` (committed, no dependency) generates every byte
and JSON case deterministically; `tools/check-fixtures.mjs` (committed, no
dependency, no eval, no network, no `three`) independently re-derives the WAV
header arithmetic, the GLB clip/skin/root-motion facts, the preset/light rules,
the activation timeline and the ownership/audio invariants, and verifies the
`index.json` digests. A deliberate-corruption negative control must exit
non-zero (see `verification.md`).

Fixture bytes are original, generated content with an explicit reuse
declaration (`README.md`); nothing is downloaded and no license is asserted over
third-party assets.

---

## 41.9 Public-surface additions (no new package, subpath or pin)

| Unit | Subpath | Additions (realized by the named packet) |
|---|---|---|
| `three-adapter` | `.` (existing root, loader-free) | `createAnimationRoleController`/`AnimationRoleController` + the profile/state types (§41.3.6); shadow/light realization options on the accepted `createSceneAdapter` options; `AnimationRoleBinding`-shaped input types validated against `PreparedVisualResource.clips`; `animation_role_unresolved` in `ERROR_CODES`; the `SceneAdapterDiagnostics.shadows`/`shadowReason` fields; the **M4 `models` block on `createSceneAdapter` options** (the resolved model-asset map, the per-`modelAnimation`-entity committed mappings, and the injected byte resolver — the accepted packet-26 `AssetByteSource` shape; the adapter realizes `model` entities as attached `ModelInstance`s under the entity holders and drives one role controller per animated entity from the single `renderFrame` loop, M4 `delivery.md` §2), with `models_config_invalid` / `models_asset_unresolved` in `ERROR_CODES` (new, closed set) and the `SceneAdapterDiagnostics.models` counters block (`assets`/`instances`/`pending`/`animations`/`failed` — counters only, no paths/tokens/IDs; absent when `models` is absent). All on the existing root subpath — **no new subpath, no new three subpath, no pin change** |
| `asset-pipeline` | `.` (existing) | `inspectAudio(bytes, options)` plus the audio `ImportRecipe`/`PcmWavMetrics` types and the audio diagnostic/limit names (packet 47). No new dependency (no decoder library, no Node built-in) |
| `project-model` | `.` (existing) | the `modelAnimation`/audio version types and validators (packet 44) |
| `game-host` (new unit, packet 54) | `.` audio entry | the injected audio owner surface of §41.4.7; created only in packet 54 after Gate K accepts the `dependencies.md` rows (42's PR-5 obligation) |

`three` stays pinned at `0.186.0`; `three/examples/jsm/loaders/GLTFLoader.js`
(+ the animation loader) is the only `examples/jsm` import
(`dependencies.md` §4.2, unchanged). No new package, no new subpath and no pin
change is requested.

---

## 41.10 Compatibility, change rules and non-goals

- Everything here is **additive** to v3: v1/v2 scenes have no `light`/
  `surface`/`modelAnimation`/audio data and their readers are unchanged. A v2
  envelope cannot carry `kind: "audio"` (39 §23.3.7), so the recipe/metrics
  union is v3-only in effect.
- Accepted M1/M2 GLB realization, preview controller, ownership ledger, error
  codes and the M2 profile validation order are unchanged except where
  §41.7.2 explicitly adds a code.
- Changing a preset row, a shadow constant, a profile cap or a binding field is
  a contract change requiring a reviewed diff (it changes persisted values or
  the meaning of a version's profile).
- Non-goals: no fourth preset or preset catalog; no light beyond one key + one
  fill; no second shadow-casting light; no post-processing, shader authoring,
  texture pipeline, LOD, instancing system or performance budget; no skeletal
  animation, IK, blend tree, root motion or general animation graph; no
  advanced audio.

---

## 41.11 Contract-change requests (numbered; resolutions recorded at promotion)

| # | Destination | Request |
|---|---|---|
| C41-1 | `gameplay.md` §6 (packet 40) | **Resolved** by the Gate K bounded repair (K-2/FU-4): the read-only `GameView.playerMotion: { speed, grounded }` field (§41.3.7) with its exact derivation is now committed in `gameplay.md` §6 and `runtime.md` R40-17, so the role selector consumes committed motion. Additive; the packet-40 `game-view` fixture is extended by packet 43. |
| C41-2 | `commands.md` §8.5/§9.1 (packet 39) | `publishAsset` `args` gain the optional `animation: { entityId, roles }` field and the atomic rule of §41.3.4 (required for a reimport of a referenced animated asset). 39's file is not edited here; the exact destination text is in this packet's `commands.md` section. |
| C41-3 | `commands.md` §8.5 + §5.4 | The atomic reimport change/inverse shape (§41.3.4) and the code/limit rows of §41.7.2. |
| C41-4 | `project-model.md` §18.1 rule 3 | The version-local clip-role exception (PM41-1 in `project-model.md`) — the only accepted model rule this packet replaces. |
| C41-5 | `sessions.md`/delivery (packet 42) | Cue payloads carry `assetId` only: **no base64 or binary in WebSocket frames**, no URL/CDN audio, bytes only through the accepted immutable blob read; the CSP must permit Web Audio without permitting `eval` (38's finding, 42's diff). |
| C41-6 | `dependencies.md` §3/§4 (packet 42/54) | The `game-host` unit row and its audio-entry edges (DOM/Web Audio isolated there; the editor UI may not import `game-host`). |
| C41-7 | `project-model.md` §18.5/§18.6/§18.9 | The `pcm-wav` recipe/toolchain rule, the `AssetMetrics` union and the audio codes (PM41-2…PM41-4). |
| C41-8 | `project-model.md` §19.2 (packet 44/58) | Confirmation that the captured closure includes `audio` versions by digest (39's PM16 reword); nothing else changes. |

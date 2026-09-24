# Phase 15 — Everything editable

Goal: every piece of data the game reads is an object in the editor — seen,
selected, edited in the Inspector, and handled in the Scene view when it has
a size, range, direction or path — and the gameplay values that are
hard-coded constants today become data with generic engine defaults.
Scripts declare which of their properties the editor shows (public/private).
Read `docs/roadmap.md` (principles) first.

## 1. Where things stand (survey, 2026-09-24)

Project data with no or partial editor UI (16):
1. `controller` has no fields (capsule, movement tuning are constants) —
   phase 14.0 adds the capsule; this phase adds the rest.
2. `playerSpawn` is a bare marker (no facing).
3. `camera` fovY/near/far have no Inspector fields (created with fixed
   values in `editor/src/ui/App.tsx`); the frustum gizmo is fixed-size.
4. Polygon colliders: vertices read-only; "Add collider" always makes a box;
   no hx/hy handles.
5. `box.size` has no field (only transform scale).
6. `cameraFollow.bounds`: fields and a drawn rectangle, no handles.
7. `content.game.level` bounds and `killY`: fields, nothing drawn.
8. `trigger`/`switch`/`pickup`/`enemy` sizes and `enemy.range`: fields and
   outlines, no handles (phase 14.0 adds size handles; ranges here).
9. `audioSource.range`: field and bar, no handle.
10. `enemy.chase`, `faceMovement`: fields only, not visualised.
11. `animator.parameters` (per-object initial values): no UI.
12. `instances` (instance-set copies): not selectable or editable one by one.
13. Behavior source: a raw JSON textarea; declarations: a one-property form.
14. Light range/angle/direction: fields and read-only gizmos, no handles.
15. `fogVolume.size`: fields and a wire box, no handles.
16. Checkpoint activation, surface, `modelAnimation` roles and game cues are
    only in the Media tab, not in the Inspector.

Hard-coded values a designer would tune (30; file:line in §7): player capsule (4 copies)
and the gameplay blocks' player box; stomp bounce 9; hit bounce 5; default
invulnerability 1 s; knockback duration 0.25 s and its ×2 peak; defeat
squash 0.3 s; chase height 2 m; stomp tolerance 0.2 m; enemy wall/ledge
probe distances; default pickup size 0.8; mover push clamp/skin; faceMovement
fallbacks; acceleration 40 / deceleration 60; coyote 6 steps, jump buffer 8
steps, jump-release factor 0.5; ground snap 0.1, skin 0.01, autostep off;
settle pre-roll 12; fixed step 120 Hz; max catch-up 8; respawn delay 30
steps; camera Z 12 (the authored camera z is ignored) and max camera step
4 m; default aspect 16:9; query budget 32/step; drop-through 15 steps;
zones per scene 64; audio voices 8 / assets 16 / music 64; music fade 1 s;
animation crossfade 0.2 s and run threshold 0.05; shadow-follow extent 24 m;
stick dead zone 0.2. Several are "contract constants" pinned by replay
fixtures (`platformer/src/constants.ts`, `physics-rapier/src/constants.ts`).

## 2. Decisions (owner, 2026-09-24)

- Gameplay values get Inspector fields; defaults are generic engine defaults
  (roadmap principle 1), equal to today's constants unless a constant is
  demo-shaped (then fix it and log why).
- Scripts decide what the editor shows with a public/private declaration,
  like Unity: public properties appear in the Inspector (per object),
  private ones do not (they keep their declared default; a read-only debug
  view may show them during Play).

## 3. How to work

`docs/roadmap.md` → "How every phase is worked".

## 4. Work items

### 15.0 Component descriptors

- One descriptor registry in project-model (data, no UI code): for every
  component and content block, its fields with type (number, int, bool,
  enum, vec2, vec3, color, asset ref with kinds, entity ref, signal name,
  string), unit, min/max/step, default, group, label, tooltip, and a
  Scene-view handle kind where it applies (`box2`, `radius`, `capsule`,
  `segment1d` (x range), `cone`, `direction`, `path`, `polygon`, `point`).
- The validators keep their rules; a unit test checks every validator's
  fields match its descriptor (no field without a descriptor).
- The editor may read descriptors (types and data only; respect the
  package boundaries — if the editor must not import project-model values,
  expose the registry through `queryGameConfig`/a protocol message, as
  `inputDefaults` does, with a parity test).

### 15.1 Generic Inspector

- The Inspector builds each component section from its descriptor (one
  field widget per type, grouped, with tooltips and units); the bespoke
  editors (BlocksEditor, LightEditor, FogVolumeEditor, the Gameplay tab's
  camera/game forms) are replaced where the generic one covers them; custom
  widgets stay where they add something (the Media-tab cue pickers become
  asset-ref widgets in the Inspector; the Media tab keeps asset-level
  settings only).
- Every component can be added from "+ Add component" with its descriptor
  defaults; components that exclude each other say why.
- e2e: add, edit and remove each component kind through the Inspector.

### 15.2 Scene handles for everything

- A handle system driven by descriptors: box sizes, radii, capsules, x
  ranges (enemy range, bounds), cones and directions (lights), paths
  (mover), polygons (collider vertices: drag, add on edge, delete),
  points; one undo step per drag; snapping; handles only for the selection.
- Draw what is not drawn: level bounds and killY, enemy chase radius,
  camera frustum from its real fovY/near/far and aspect.
- Polygon collider editing and "Add collider → box / polygon from model
  outline".
- `box.size` field; `camera` fields; `playerSpawn.facing` (left/right/
  none); `animator.parameters` per-object initial values (from the
  controller's parameter list).
- Instance sets: select one copy in the Scene view (with the set's entity
  selected), move/rotate/scale/delete it, add copies (brush) — edits go
  through `tl_instance_buffer`-equivalent commands with undo.
- e2e per handle kind (drag → stored value → undo).

### 15.3 Tuning values as data

- Character (on `controller`, grouped "Movement", "Jump", "Collision"):
  acceleration, deceleration, coyote time (seconds, not steps), jump buffer
  (seconds), jump-release factor, ground snap, skin, autostep (on/off +
  height), max slope — defaults = today's values (a human-scale generic
  platformer character; record the reasons).
- Combat and blocks: stomp bounce and stomp tolerance on `enemy`; hit bounce,
  knockback duration and invulnerability default on `health`; defeat effect
  (none / squash / fade, duration) on `enemy`; chase height on `enemy`;
  ledge/wall probe distances on `enemy`; a pickup without `size` uses its
  model's bounds (the runtime never loads GLBs: take them from the model
  asset's recorded metrics/bounds, add bounds to the metrics if missing),
  else a documented neutral 1 × 1 m.
- Game/session (content): respawn delay, drop-through time, settle time.
- Camera: `cameraFollow` distance (default: the authored camera's distance
  from the player at start — the authored z is honoured), max camera speed,
  aspect handling.
- Project settings: fixed step (60/120/240 Hz, default 120), audio voices
  (limit stays a cap), music fade default, animation crossfade default.
- Replays: every default equals the old constant, so recorded replays stay
  valid; add fixtures for non-default values; update the "contract
  constant" comments.
- Engine limits that stay constants (query budget, zone cap, asset caps…)
  are listed in `docs/deployment.md` as limits.

### 15.4 Script property visibility (public/private)

- Declared properties gain `visibility: 'public' | 'private'` (default
  `public` — today's behaviour), plus optional `group`, `tooltip`, `header`.
  Public: shown in the Inspector of every object carrying the behavior,
  overridable per object. Private: not shown and not overridable; the
  script reads its declared default. Validation, canonical form, commands,
  MCP text.
- In the TypeScript source, a script may declare its properties in code
  (e.g. `export const properties = { speed: property.number(3, { min: 0 }),
  secret: property.private.number(1) }`) and the compiler derives the
  declaration from it, so the declaration and the code cannot drift; the
  JSON declaration stays accepted.
- Play debug view: while Play runs, selecting an object shows its scripts'
  current property values (public and private) read-only.
- The Behaviors tab: a proper declaration editor (all property types,
  visibility, groups) replacing the one-property form; the source editor
  moves to a centre tab in phase 16.

### 15.5 Demo-shaped defaults audit

- Go through every engine default (components, content, editor "New …"
  presets, GameObject menu presets, templates) and check it against
  roadmap principle 1; fix demo-shaped ones (e.g. anything tuned to Sprout's
  size or the meadow) and log each. Templates (Beacon Reach) keep their own
  values in their own data.

### 15.6 Wrap-up

- `docs/deployment.md`: the Inspector, handles, tuning fields, script
  visibility; STATUS row 15.

## 5. Progress

| Item | Status | Commits |
|---|---|---|
| 15.0 descriptors | done 2026-09-24 | 44e8170 |
| 15.1 generic Inspector | done 2026-09-24 | 97aa0c6 |
| 15.2 Scene handles, instance copies | todo | |
| 15.3 tuning values as data | done 2026-09-24 | c5d9d53, c69f144 |
| 15.4 script property visibility | done 2026-09-24 | 7a1adf6, 359016a |
| 15.5 defaults audit | todo | |
| 15.6 wrap-up | todo | |

## 6. Decision log

- 2026-09-24 (15.0): the registry is `DESCRIPTORS` in `project-model/src/descriptors.ts`; every component and content block is one root field descriptor (`value`, usually an `object`) — one shape for a component, a nested object, a list item and a content block, so one generic Inspector and one handle system walk them all.
- 2026-09-24 (15.0): field types beyond the plan's list, where the data needs them: `quat` (transform rotation), `sceneRef` (exit loads, level scenes, title scene), `ref` with a target (material, animator, behavior, prefab, animator parameter/state, clip), `map` (materials, score points, animator/behavior values, bakes), `components` (a prefab entity's bag) and `json` (values typed elsewhere — behavior values by the declaration — or written whole by a tool: asset versions, behavior source, bakes, trust entries).
- 2026-09-24 (15.0): variants are `when` conditions on a sibling (`../key` for the enclosing object), compared on the sibling's effective value (its default when absent); a key may appear twice with conditions that never hold together (a light's intensity in candela for point/spot, a factor otherwise; shader params per shader) — simpler for a generic Inspector than nested variant tables.
- 2026-09-24 (15.0): handles are listed per component with the fields they edit by role (`HANDLE_ROLES`: box2 = size | hx/hy | minX..maxY bounds, capsule = radius/height/offset, cone = direction/angle/range…), and each edited field names its handle kind; `box3` was added for `box.size` and `fogVolume.size` (3D sizes). `point` is defined but no current field needs it.
- 2026-09-24 (15.0): components also carry how they are added (`menu` value / `pick` refs first / `tool` / `never`), presets (a light per type, a zone per role), `requiresAnyOf`, symmetric `excludes` with reasons, the prefab flag (the prefab vocabulary) and placement rules — what 15.1's "+ Add component" and "excludes each other say why" need. The add values are today's editor presets.
- 2026-09-24 (15.0): the editor may import project-model types only, so the registry travels as `queryGameConfig {args:{descriptors:true}}` (~120 KB, asked once by the editor client, `getDescriptors()`); plain game queries stay small. MCP: `tl_content_query {target:"game", includeDescriptors:true}`. Parity: a workspace test compares the query answer with `DESCRIPTORS`; an e2e checks the editor's first game query gets it from the real backend.
- 2026-09-24 (15.0): the unit test probes the real validators from valid bases (one per variant): unknown key refused and every key the validator lists has a descriptor, required/optional, min/max accepted, just outside refused, int fractions, enum options, string lengths, list counts, types and null; plus coverage (every descriptor node reached), defaults/add values/presets validate, exclusions derived pairwise from the scene validator. To make the reverse check possible the input validator now names its allowed action and binding fields in the error (message only, rules unchanged).
- 2026-09-24 (15.0): found, not changed (validators keep their rules): `cameraFollow.deadZone`/`smoothing`, directional/ambient light `intensity`, `surface` roughness/metalness/emissiveIntensity and the checkpoint glow strength accept negatives (`|v| <= max` where the message says `0 <= v`); the descriptors state the intended `min: 0` and the test lists these as known looser validators. A candidate for 15.5 (tighten with a load-time clamp).
- 2026-09-24 (15.0): the v4 game block has no level bounds or kill height (phase 12 moved game rules to scripts), so §1 item 7's `content.game.level`/`killY` are v3-only data and have no descriptor.
- 2026-09-24 (15.1): the generic Inspector is a pure model (`editor/src/session/descriptor-fields.ts`: widget per type, `when` conditions, edits → command values, the add list) plus React widgets (`ui/DescriptorFields.tsx`); the Inspector renders one section per component in registry order from the projection's raw component bag (`ProjectedEntity.components`, kept current by every change) — new descriptor fields (15.3, 15.4) appear with no editor change.
- 2026-09-24 (15.1): a field's accessible name is its component and path ("trigger radius", "controller capsule height", "mover waypoints 1 x"; the transform has no prefix: "position x"), sliders add " slider", sections are "<component> component"; existing e2e labels were moved to these names (blocks, sensors, lights, environment, capsule, menus, animator, animator-sprout).
- 2026-09-24 (15.1): an edit is one command with the changed top-level fields whole (`setComponent`/`setTransform`/`setGameConfig` partial semantics, `null` removes): fields whose `when` stops holding are dropped and required fields that start holding are filled in the same edit — from a preset of that variant (a polygon collider gets the Polygon preset's corners, a directional light the Directional preset's intensity), else the first fitting object/asset for a reference (a checkpoint's respawn spawn), else the default; a number the new variant refuses (a point light's 30 cd as a directional factor) starts over; a required text without a default starts as its key name (a custom pickup's counter "counter"). An optional field set back to its default is removed (absent means the default) — the old editors did this for flags and modes.
- 2026-09-24 (15.1): box, camera and model are added and removed with `setComponent` like every component (a complete value / `null`; commands, MCP text and two contract tests updated; `commands/src/component-add-remove.test.ts`). The camera stays constrained by the project rule "exactly one active camera in the start scenes": adding a second or removing the only one is refused and the Inspector shows the rule (refusals now show the first detail message).
- 2026-09-24 (15.1): found and fixed in `setComponent` while testing every field through the real commands (`tests/integration/m15-inspector`): a zone's `load`/`unload`/`spawnId` were refused as unknown fields (editing an exit zone failed), a collider's `oneWay` alone was refused (the shape was required), a model's `piece` was not editable. A parity test checks every top-level descriptor field of a `setComponent` component is a `setComponent` field.
- 2026-09-24 (15.1): replaced: BlocksEditor, LightEditor, FogVolumeEditor, the collider/controller control list, the Gameplay tab's Camera form (the tab now points to the camera object) and, for v4 blocks, its Game form (the `game` block built from its descriptor; the old form stays for a v3 `configVersion 1` block). The Media tab's checkpoint activation, lights, surface and model-animation pages are Inspector sections now; the game cues are sound pickers of the game block (content, not a component, so they are in Gameplay → Game, not the object Inspector); the Media tab keeps listening to sounds (asset level). The old model-animation roles are shown read-only (the descriptor marks them tool-written: projects move to an animator when opened) and the component can still be removed.
- 2026-09-24 (15.1): kept as descriptor-keyed extensions: the capsule's Fit to model/Default, an exit zone's Edit exit…, the material mapping editor (it knows the model's own material names), a script's declared-property list (15.4 reworks it), surface presets (`applySurfacePreset`). The Component menu is the same add list as "+ Add component" (presets as submenus; a disabled submenu is now a disabled item with its reason).
- 2026-09-24 (15.1): the Scene view rebuilds an object's own helpers when a component that shapes them is added, removed or changed (kind, light type/direction/range/cone/mode, fog volume, spawn), keeping children and a realized model under the node.
- 2026-09-24 (15.1): §4 15.2's "just fields": `box.size` and the camera's fovY/near/far are Inspector fields now (generic); `playerSpawn.facing` is not in the data yet (15.2); `animator.parameters` shows read-only (15.2 edits per-object initial values from the controller's list).
- 2026-09-24 (15.1): found, not changed (descriptor data, 15.0/15.5): `game.cameraId` names "a camera" in its descriptor but the game rules want the camera carrying camera follow, and a game block needs a goal zone — the Game tab's "Create game block" picks a camera with camera follow and the refusal names the goal-zone rule.
- 2026-09-24 (15.3): every new tuning field is optional and appended last in its canonical form, absent = the old constant — so existing scenes, content, manifests and digests are byte-identical and every recorded replay stays valid (the existing replay/trace fixtures pass unchanged; an integration test shows "all spelled out at their defaults" = "none set" bit-for-bit, and `tests/integration/m15-tuning/replay-nondefault.json` pins a 60 Hz run with every kind of non-default value).
- 2026-09-24 (15.3): character tuning lives flat on `controller` (acceleration, deceleration, coyoteTime, jumpBuffer, jumpRelease, groundSnap, skin, autostep, autostepHeight), grouped Movement/Jump/Collision by the descriptors only. Windows are seconds converted to whole steps at the step rate (`round(s × hz)`): 0.05 s and 8/120 s give exactly the old 6 and 8 steps at 120 Hz. The jump-buffer default is stored as 8/120 (0.0667 s), not rounded to a prettier number, so it stays 8 steps.
- 2026-09-24 (15.3): max slope is not duplicated on `controller`: it stays the project setting `max_slope_climb_deg` (already data, with run speed, jump speed and gravity) — two sources for one value would be ambiguous; the controller descriptor says where it is.
- 2026-09-24 (15.3): autostep uses Rapier's `enableAutostep(height, minWidth = capsule radius, dynamic bodies off)`; default height 0.25 m (above a 0.18 m stair step for the default 1.8 m character); the port's correction bound allows the step lift. Skin 0.001–0.1 m, ground snap 0–1 m; the physics port validates these ranges instead of the old exact contract constants (the three `config-*` failure fixtures now use out-of-range values).
- 2026-09-24 (15.3): combat/block tuning on the components: health `hitBounce` 5 m/s, `knockbackTime` 0.25 s (the ×2-then-ease-out knockback shape stays: its mean is `knockback`); enemy `stompBounce` 9, `stompTolerance` 0.2 m, `defeat` none/squash/fade + `defeatTime` 0.3 s, `chaseHeight` 2 m, `wallProbe` 0.05 m and `ledgeProbe` 0.4 m (edges patrol; the ledge ray still starts 0.1 m above the feet); mover `maxPush` 60 m/s (0.5 m/step at 120 Hz, per step = maxPush / hz — `60/120` is exactly 0.5). The push gap is derived (player skin + 1 mm = the old 0.011), not a field. `fade` is drawn by the three-adapter (transparent copies of the entity's materials at the runtime's `entityOpacity()`); the pixels are owner look pending (unit-tested on materials only).
- 2026-09-24 (15.3): faceMovement had no hidden fallback left to expose: yawRight/yawLeft are required and turnSeconds (0.12 s) is already an optional field with a descriptor default; the 1e-4 m "is it moving" threshold is a numeric epsilon, not a tuning value.
- 2026-09-24 (15.3): the pickup default area 0.8 × 0.8 m was demo-shaped (a coin's size) and changed as the plan decided: absent size → the model's recorded bounds (own model, else first model child; width × height scaled by the transforms), else a neutral 1 × 1 m. This is the one default that changes behaviour for existing projects (pickups without a size and without new-import bounds collect over 1 × 1 instead of 0.8 × 0.8).
- 2026-09-24 (15.3): model bounds are an optional `metrics.bounds` computed at import from the POSITION accessors' min/max through the default scene's node transforms (`_COL` nodes skipped) — no vertex read; files without min/max (non-conformant, e.g. the packet-24 test fixtures) record none, so their metrics and metadata digests are unchanged. Bounds travel content view → manifest asset row (`bounds`, only when present) → `RuntimeSnapshot.modelBounds` (built by the preview and export hosts); the runtime never loads a model. Versions imported before have no bounds (re-import to get them; versions are append-only).
- 2026-09-24 (15.3): session timing (respawnDelay 0.25 s, dropThroughTime 0.125 s, settleTime 0.1 s) are optional fields of the v4 game block (configVersion 2 only; v3 blocks keep their exact field set). `setGameConfig` partial edits accept `null` to remove one; whole-block create/remove list only the timing fields the block carries in `changedFields` (the recorded change data of older scenarios is byte-exact).
- 2026-09-24 (15.3): engine settings (`fixed_step_hz` 60/120/240, `audio_voices` 1–32 default 8, `music_fade_s` 1, `animation_crossfade_s` 0.2) extend the `content.settings` registry as *optional* keys: resolved only when the project sets them, so the resolved settings block, `settingsDigest` and every manifest/buildId of a project that sets none are unchanged; the manifest validator accepts the six keys then the optional ones in registry order. The settings spec gains `integer`/`values`/`optional`/label/tooltip/group; the descriptor for a choice of numbers is an `int` with `values` (added to the descriptor types, probed by the parity test). The crossfade setting drives the legacy idle/run/airborne role controller and the migration's transition durations; the voice cap 32 stays an engine limit.
- 2026-09-24 (15.3): the host passes `fixed_step_hz` to the runtime and the physics solver; the settle pre-roll, respawn delay and drop-through become `round(seconds × hz)` steps (still exactly 12/30/15 at 120 Hz); the export's `thirdlight-export.json` records the project's rate.
- 2026-09-24 (15.3): camera rule — `cameraFollow.distance` absent: the camera's z is never written (the authored z is honoured, as the renderer already did) and the v3 level frustum clamp uses the placed distance (camera z − player z; a camera placed 12 m out frames exactly as the old constant; a non-positive placed distance falls back to 12). Set: the module writes z = player z + distance each step. `maxSpeed` default 480 m/s (per step = maxSpeed / hz = the old 4 m). v4 has no level frustum clamp, so in v4 the distance only sets the depth.
- 2026-09-24 (15.3): aspect handling is not a field: the renderer always uses the canvas aspect; the runtime's 16:9 is only the pre-report value of the v3 level frustum clamp (v4 has none), listed with the engine limits in `docs/deployment.md`. A v4 "keep the view inside bounds" option would be a new feature, not tuning.
- 2026-09-24 (15.3): engine limits kept as constants (catch-up 8 steps, 32 queries/step, 64 zones/scene, 32 view events, voice cap 32, 16 sound assets / 64 music tracks, spawn caps, 64 timers, epsilons, run threshold 0.05 m/s, shadow-follow extent 24 m, stick dead-zone default 0.2 per action) are listed in `docs/deployment.md` "Engine limits".
- 2026-09-24 (15.1+15.3 integration): an `int` with `values` renders as a select of those values (no slider; other values refused before the command); Gameplay → Settings is built from the settings descriptor (the hand-written six-key form stays only as a fallback before the descriptors arrive) so the engine settings are editable — one partial `setSettings` per edit; emptying a setting is refused in the form because `setSettings` has no removal.
- 2026-09-24 (15.4): declared properties gain `visibility` (`public` default, omitted from the canonical form so older declarations stay byte-identical; `"public"` sent explicitly is normalized away by the command), `group` (1–64), `header` (1–64) and `tooltip` (1–256), no control characters; canonical order after `bounds`: visibility, group, header, tooltip.
- 2026-09-24 (15.4): private values are never stored: `setBehaviorProperties` and prefab overrides naming a private key are refused with the new code `property_private`, and a write stores public keys only. The model rule "every declared key has a stored value" is relaxed to "stored keys ⊆ declared keys" (an absent key reads its default — the runtime and editor already did) — so a property made private or public, or a key added to a behavior in use, needs no migration of existing objects; a stored value of a now-private key is inert (the runtime reads the default; still type-checked so making it public again is valid) and is dropped on the object's next property write.
- 2026-09-24 (15.4): `declaration-update` now keeps the behavior's published source (it was dropped, so tuning a scripted behavior's declaration detached its script); the compiled code does not embed the declaration (the host feeds the record's values).
- 2026-09-24 (15.4): code declarations: `export const properties = { key: property[.public|.private].<type>(default, options?) }` in src/index.ts, read statically by a small literal parser in `behavior-build/src/declare.ts` (no evaluation; any other shape is `behavior_source_invalid`/`properties` with the position), then the statement is rewritten to plain data (key → declared property) before bundling so no `property` helper is needed at run time. Precedence: **code wins** — a JSON declaration sent with the source is ignored and the prepared (derived) declaration is what the publication asserts (the source route's `declaration` is optional); the manifest, prepared facts and the stored source record carry `declaredInCode: true`, and a JSON `declaration-update` of such a record is refused (`behavior_declaration_mismatch`, reason `declared_in_code`) — so declaration and code cannot drift. Only the entry file is read; a source still publishes into an existing record.
- 2026-09-24 (15.4): the Play debug view reads the values from the running game: `tl.game.observe` (bridge), the observe HTTP body and the WS relay frame take an optional `entityId`; the preview answers `behaviors: { entityId, scripts: [{ behaviorId, properties: [{ key, label, type, visibility, value }] }] }` from the runtime's new read-only `behaviorProperties(entityId)` (≤ 8 scripts, strings clipped to 64 characters to stay in the 16 KiB bound). The editor polls it twice a second over the bridge (its own relay ids, not forwarded to the backend); `tl_game_observe {entityId}` returns the same block. Values are the instance's materialized values (constant for a run: scripts cannot write properties).
- 2026-09-24 (15.4): the Behaviors tab's one-property form is replaced by `DeclarationEditor` (all seven types, visibility, group/header/tooltip, type limits, add/remove/reorder; one `publishBehavior`); the Inspector's behavior section (`PropertyControls.tsx`) shows public properties only, ungrouped first then one foldable section per group, headers and tooltips. The editor's "publish source" now goes through the source route with the stage (prepare + the same command) so a code declaration can be published from the editor.
- 2026-09-24 (run): 15.3 and 15.4 were built in parallel with 15.1 and merged before 15.2 (which needs the descriptor-driven Inspector and the tuning fields to exist); items were started in order, only the merge order differs.
- 2026-09-24 (15.5): method — every default was checked against principle 1: the descriptor registry (field defaults, add values, presets), validators' absent-value fills, the runtime/platformer/physics/game-host/three-adapter/input/audio fallbacks, the starter project, the GameObject/Component menus, the Environment/Material/Animator/Input/Game-flow panels and the Beacon Reach template path. Sizes are judged against the engine's own default character (1.8 m capsule, 4 m/s run, 1.25 m jump at 2 g), never Sprout's (~1 m) or Beacon Reach's. Template instantiation (`createProjectFrom`) hard-codes nothing of Beacon Reach; the sample keeps its own values in its data. Findings:
- 2026-09-24 (15.5): validators tightened — `cameraFollow.deadZone.x/y` and `smoothing`, directional/ambient light `intensity` (point/spot/hemisphere already refused them through a second check, now folded into the one range check), `surface.roughness/metalness/emissiveIntensity` and checkpoint `activation.emissiveIntensity` now refuse negatives (`checkFiniteNumber` gained an inclusive `min`); the descriptors test's known-looser list is gone. No load-time clamp: a scan of every JSON file in the repo (fixtures, samples, replays) and in the server's data root found no negative value in these fields, so a clamp would be code for data that does not exist; an old project with one reports the exact field on open.

| Default | Where | Verdict |
|---|---|---|
| Directional/Ambient light presets #fff4e0 1.6 [0.4,−1,−0.6] / #8a94b0 0.9 (and the GameObject menu's copies) | descriptors, App.tsx | **fixed**: they were Beacon Reach's key and fill; now the starter lights (white 1.2 [0.4,−1,−0.3] with shadows, #8090a8 0.6); the menu reads the presets from the registry (`presetValue`); the directional `direction` field default follows. Parity test `workspace/src/starter-defaults.test.ts`, e2e in `menus.e2e.ts` |
| Hemisphere preset ground #5a4a38 (earth brown) | descriptors, App.tsx | **fixed**: #444444 (the field default and the renderer's fallback; no outdoor ground assumed) |
| GameObject → Camera fov 45 at [0, 4, 12] | App.tsx | **fixed**: Beacon Reach's camera; now the descriptor's camera (60°), 4 m in front of the Scene-view focus. Found: `createEntity` never accepted cameras and a v4 project keeps exactly one camera in its start scenes, so the item could never succeed; it now goes object + `setComponent` and removes the object when refused. Making the item useful is left open |
| Checkpoint glow #1bc8ff 1.2 | descriptors, editor `DEFAULT_CHECKPOINT_ACTIVATION` | **fixed**: Beacon Reach's beacon cyan; now plain white at 1 (reads as lit in any palette). Stored checkpoints keep their values |
| Gradient sky bottom #6b7b5a (grass olive) | descriptors, three-adapter fallback, Environment window | **fixed**: #757575, a neutral grey of the same brightness (no project on disk uses a gradient sky; render-only, replays unaffected; pixels owner look pending) |
| Instance scatter 40 × 8 m | App.tsx | **fixed**: 20 × 20 m (a side-scroller strip assumed a view direction) |
| Surface preset mirror in the editor | `editor/session/media.ts` | **fixed**: every row had drifted from the authoritative project-model rows; now equal, pinned by `media.test.ts` |
| Title pan 6 m / time-bonus 120 s / score points 1 (descriptors) vs 4 m / 60 s / 10 (Game window) | descriptors | **fixed**: one value each (the Game window's, reasons next to them) |
| Mover waypoint default [[2,0,0]] vs add value [[4,0,0]]; exit dialog 2 × 3 vs `DEFAULT_ZONE_SIZE.exit` 1.5 × 2.5; fog colour #c8d8e8 vs #c8d2dc | descriptors, App.tsx, EnvironmentPanel | **fixed**: one value each |
| v3 game form instructions naming a W/Up jump | GameplayPanel | **fixed**: "Move and jump." (the descriptor's; no default binding jumps on W/Up) |
| "Empty scene (camera, lights, ground)" | Projects.tsx | **fixed**: the starter has no ground — "(camera and lights)" |
| "Sprout's rule" / "e.g. Sprout's kits" comments | materials.ts, material-schema.ts, pieces.ts | **fixed**: stated as the engine's conventions |
| Settings gravity −19.62, run 4, jump 7, fall −30, slopes 45/30 | content.ts | kept (reasons added): 2 g action-game fall, a jog, a 1.25 m jump for a 1.8 m character; always resolved into manifests, so changing them would change every build id and replay |
| Controller capsule 0.3/1.8, tuning, block tuning, session timing | components.ts, blocks.ts, content.ts | kept: 15.3's reasons (adult human, few-frame windows); the pickup 0.8 m was already fixed in 15.3 |
| Zone sizes (hazard 1.5 × 0.5, checkpoint 1.5², goal 2², exit 1.5 × 2.5), enemy 0.8 m, trigger 2 m, switch 1 m, door 3 m, coin 0.4 m | descriptors, gameplay.ts, App.tsx | kept (reasons added against the default character and jump) |
| cameraFollow dead zone 0.5 / smoothing 0.2 | descriptors | kept: generic follow values (Beacon Reach uses the same numbers in its own data) |
| Starter camera [0, 0.5, 4] 60°, placement fallback and orbit target y 0.5 | store-v4.ts, App.tsx, viewport.ts | kept: 0.5 m is the centre of the editor's first 1 m box resting on the ground, not a character height (viewport.ts not touched: 15.2 works there) |
| Point light warm #ffd9a0 30 cd 8 m, spot white 80 cd, fog volume 6 × 3 × 4, audio 0.8 / 12 m, faceMovement ±90° | descriptors | kept (reasons added) |
| Sky: procedural clear day, sun 35°/160°, gradient/colour blues; fog 10–120 m; post neutral + AgX; wind a light breeze; quality high | descriptors, three-adapter, materials.ts | kept (reasons added): an outdoor day is the engine's neutral starting sky; night/space/interiors set their own |
| Foliage sway ≈ 0.1 m at the tip (absolute metres) | three-adapter material-library | kept (comment added): grass/shrub scale, windBend/windFlutter scale it 0–4×; changing it would move every project's foliage unobserved — a size-relative sway is a phase 18 candidate |
| Surface presets `matte-ground` #6f6f6f and `beacon` | project-model, commands | kept: `beacon` is a generic noun (a glowing marker look) and a contract enum recorded in the M3 command replays; renaming would break them |
| Platformer animator preset (idle/run/jump/fall/land; 0.2 m/s, ±0.5 m/s) | AnimatorPanel | kept (reasons added): an opt-in preset for the built-in controller, thresholds relative to the default run and jump |
| Default input (move 1D, jump, attack, interact…) | input.ts | kept: the built-in controller moves in the X/Y plane |
| Classic HUD prompts hard-coding A/D and Space | game-host hud.ts | **fixed** (see the next line) |
| Runtime default module `thirdlight.demo:box-motion` | runtime.ts | kept: the M1 runtime contract's default when a host passes no module list; every host passes one |
| Material "new" color #ffffff roughness 0.8 vs surface #b0b0b0 0.9 | materials.ts | kept: a material override starts from the shader's own defaults, a surface/box from a neutral grey — different things |
- 2026-09-24 (15.5): the classic HUD's prompts name the game's actual bindings (`game-host/src/bindings.ts` `hudPrompts`): move and jump come from the project's input actions as the platformer reads them (two-key pairs; pad button pairs and axes, the standard D-pad / left stick / A where a part has no pad binding), with the player's saved rebinding and any rebinding made while playing (the host tracks what it last passed to the input owner's `configure`); the pad's names are shown while a pad is in use (the browser input owner's new `activeDevice()`: a key press → keyboard, a pad button or a stick past 0.5 → gamepad). Confirm (Enter or Space / A) and mute (M) stay the input package's fixed menu-channel bindings. A game without a flow now applies the player's saved rebinding too (before, only the flow's settings did), so the prompt and the controls agree. The rebinding functions moved out of the flow controller into `bindings.ts` (one implementation for settings, saved settings and prompts). Tests: `game-host/src/bindings.test.ts` (rebound jump → "K to jump", pad names, saved rebinding), a host test (saved rebinding without a flow → configured and shown; pad in use), `input` `activeDevice`, and `tests/integration/m15-hud-prompts` pinning game-host's copy of the default move/jump (game-host imports input for types only).

## 7. Appendix: where the hard-coded values live (survey 2026-09-24; lines drift)

- Capsule 0.3 / 0.6: `platformer/src/constants.ts:32-33`,
  `physics-rapier/src/constants.ts:20-21`, `platformer-game/src/constants.ts:19,21`,
  `runtime/src/runtime.ts:158,160`; blocks' player box
  `runtime/src/blocks.ts:27-28`.
- `runtime/src/blocks.ts`: stomp bounce :29, hit bounce :30, invulnerability
  :31, knockback duration :33 (and ×2 peak ~:640), squash :35, chase height
  :37, stomp tolerance ~:552, wall/ledge probes ~:607-608, pickup size ~:232,
  mover push clamp/skin ~:437-438/:139, faceMovement fallbacks ~:184-186.
- `platformer/src/constants.ts`: accel 40 / decel 60 :37-38, coyote 6, jump
  buffer 8, release 0.5 :39-41, ground snap/skin/autostep :34-36 (also
  `physics-rapier/src/constants.ts:24,27,61`), settle 12 :42, fixed step 120
  :46 (also `physics-rapier/src/constants.ts:17`, `runtime/src/runtime.ts:124`
  default with override), max catch-up 8 `runtime/src/runtime.ts:128`.
- Respawn delay 30 steps: `runtime/src/game-session.ts:34`,
  `platformer-game/src/constants.ts:37`.
- Camera Z 12, max step 4 m: `platformer-game/src/camera.ts:42,46`,
  `runtime/src/game-session.ts:40,42`; aspect 16:9 `platformer-game/src/camera.ts:50`.
- Query budget 32: `runtime/src/runtime.ts` (three literals in `physicsClient`).
- Drop-through 15 steps: `runtime/src/runtime.ts` (~:2053).
- Zones per scene 64: `platformer-game/src/constants.ts:43`.
- Audio: voices 8, assets 16, music 64 `game-host/src/audio.ts:61,65,156`;
  music fade 1 s ~:748.
- Animation crossfade 0.2 s, run threshold 0.05: `three-adapter/src/animation.ts:44,41`.
- Shadow-follow extent 24 m: `three-adapter/src/adapter.ts:186`.
- Stick dead zone 0.2: `input/src/types.ts:28`, `input/src/actions.ts:52`.
- Editor dock/tabs: `editor/src/ui/App.tsx` (`centerTab` state, `BOTTOM_TABS`),
  `editor/src/ui/layout.ts` (dock sizes).

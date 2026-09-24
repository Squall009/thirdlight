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
| 15.0 descriptors | todo | |
| 15.1 generic Inspector | todo | |
| 15.2 Scene handles, instance copies | todo | |
| 15.3 tuning values as data | todo | |
| 15.4 script property visibility | todo | |
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

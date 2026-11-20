# Script API types (from `SaveResult`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-save-result"></a>
## `SaveResult`

```ts
/** The outcome of one save, load or delete, or a settings document storage refused (`ctx.saves.results()`). */
export interface SaveResult {
  readonly op: 'save' | 'load' | 'delete' | 'settings';
  /** The slot (0: a document given at the start, e.g. by `tl_play_start`, and the settings document). */
  readonly slot: number;
  readonly ok: boolean;
  /** Why it failed. */
  readonly reason?: string;
  /** Set when the player's storage refused it. */
  readonly code?: SaveStorageCode;
}
```

<a id="script-type-save-storage-info"></a>
## `SaveStorageInfo`

```ts
/**
 * The player's storage as the browser reports it (`ctx.saves.storage()`):
 * whether it keeps the game's data under disk pressure (asked for at the
 * first save), and the site's usage and quota in bytes. Null where unknown
 * (no storage manager, or not answered yet).
 */
export interface SaveStorageInfo {
  readonly persisted: boolean | null;
  readonly usage: number | null;
  readonly quota: number | null;
}
```

<a id="script-type-asset-handle-state"></a>
## `AssetHandleState`

```ts
/** A handle's state as a script reads it. */
export type AssetHandleState = 'loading' | 'ready' | 'failed';
```

<a id="script-type-behavior-ui-view"></a>
## `BehaviorUiView`

```ts
/** `ctx.ui.view()`: the view the UI is drawn over. */
export interface BehaviorUiView {
  /** CSS px. */
  readonly width: number;
  readonly height: number;
  /** width / height. */
  readonly aspect: number;
  /** Device pixels per CSS px. */
  readonly pixelRatio: number;
}
```

<a id="script-type-behavior-ui-event"></a>
## `BehaviorUiEvent`

```ts
/** One UI event of this step (from the input frame). */
export interface BehaviorUiEvent {
  /** click (a button's event action), submit (an input), focus (the focus moved to `widget`), custom, show, hide, toggle; mode (a mode action: `value` is the mode), restart (the engine's restart), scene (the game shell's move along its scene list: `value` is the entry), reload / load / unload (a scene engine action: `value` is the scene), hold (a shell screen holding play). */
  readonly kind: 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene' | 'reload' | 'load' | 'unload' | 'hold';
  /** The UI document it happened in. */
  readonly doc: string;
  /** The widget ('' for none). */
  readonly widget: string;
  /** The event name ('' for focus, show, hide). */
  readonly name: string;
  /** The value the action carried (or the submitted text). */
  readonly value?: number | string | boolean | null;
  /** The list item it came from. */
  readonly index?: number;
}
```

<a id="script-type-behavior-stats-time"></a>
## `BehaviorStatsTime`

```ts
/** A frame time over the stats window: the mean and the slowest frame, in ms. */
export interface BehaviorStatsTime {
  readonly avg: number;
  readonly worst: number;
}
```

<a id="script-type-behavior-stats-occlusion"></a>
## `BehaviorStatsOcclusion`

```ts
/** Occlusion culling in the last frame: what hidden draws the view left out. */
export interface BehaviorStatsOcclusion {
  /** The path it culls on: 'hiz' (a depth pyramid on the GPU, WebGPU) or 'off'. */
  readonly path: 'off' | 'hiz';
  /** Draws tested against what is in front of them. */
  readonly tested: number;
  /** Draws left out of the view because something in front hides them. */
  readonly culled: number;
}
```

<a id="script-type-behavior-stats-lighting"></a>
## `BehaviorStatsLighting`

```ts
/** The lighting the page draws, as `ctx.stats.lighting` reports it. */
export interface BehaviorStatsLighting {
  /** The quality level's lighting tier: low (saved light only, always on WebGL 2), medium or high (live). */
  readonly tier: 'low' | 'medium' | 'high';
  /** Whether the static surfaces' light is computed live on this device. */
  readonly live: boolean;
  /** Whether it has caught up: live, nothing left to light again; saved, the saved light read. */
  readonly settled: boolean;
}
```

<a id="script-type-dialogue-variable-value"></a>
## `DialogueVariableValue`

```ts
/** A value of a dialogue variable or binding. */
export type DialogueVariableValue = number | string | boolean | null;
```

<a id="script-type-behavior-dialogue-state"></a>
## `BehaviorDialogueState`

```ts
/** The conversation now. */
export interface BehaviorDialogueState {
  readonly conversation: number;
  readonly dialogueId: string;
  readonly nodeId: string;
  /** line, choice, signal (waiting for resume), wait. */
  readonly kind: 'line' | 'choice' | 'signal' | 'wait';
  readonly speaker: string;
  /** The line as shown (rich text; '' when not on a line). */
  readonly text: string;
  /** Visible characters of the line so far, and in all. */
  readonly revealed: number;
  readonly total: number;
  /** The options shown, in order (a choice), as their texts. */
  readonly options: readonly string[];
}
```

<a id="script-type-behavior-dialogue-event"></a>
## `BehaviorDialogueEvent`

```ts
/** One dialogue event (seen by scripts in the step after it happened). */
export interface BehaviorDialogueEvent {
  /** start, lineStart, lineEnd, choice (options shown), chosen, signal, end. */
  readonly kind: 'start' | 'lineStart' | 'lineEnd' | 'choice' | 'chosen' | 'signal' | 'end';
  /** The conversation (the number `start` returned). */
  readonly conversation: number;
  readonly dialogueId: string;
  /** The node (a line, a choice, a signal; '' for start/end). */
  readonly nodeId: string;
  /** lineStart: the speaker id ('' for narration). */
  readonly speaker: string;
  /** lineStart: the line as shown (rich text); chosen: the option's text. */
  readonly text: string;
  /** signal: its name; end: why (end, stopped, loop). */
  readonly name: string;
  /** signal: its value. */
  readonly value: string;
  /** chosen: the option's index among those shown; else -1. */
  readonly index: number;
}
```

<a id="script-type-behavior-dialogue-history-entry"></a>
## `BehaviorDialogueHistoryEntry`

```ts
/** One line (or a chosen option) in the backlog. */
export interface BehaviorDialogueHistoryEntry {
  readonly dialogueId: string;
  readonly nodeId: string;
  readonly speaker: string;
  /** The speaker's display name ('' for narration or a chosen option). */
  readonly name: string;
  readonly text: string;
  /** A line, or the option the player picked. */
  readonly choice: boolean;
}
```

<a id="script-type-behavior-mode-transition"></a>
## `BehaviorModeTransition`

```ts
/** How a switch looks (absent fields: the target mode's own transition, then the camera's blend). */
export interface BehaviorModeTransition {
  /** The camera blend into the mode's camera: cut, linear or eased. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds of the camera blend (0–30). */
  blendTime?: number;
  /** A UI document shown from the switch for `fadeTime` seconds (its show/hide tweens make the fade). */
  fade?: string;
  /** Seconds the fade document stays (0.05–10; default 0.5). */
  fadeTime?: number;
}
```

<a id="script-type-behavior-mode-event"></a>
## `BehaviorModeEvent`

```ts
/** One enter or exit of a game mode switch (`ctx.modes.events()`). */
export interface BehaviorModeEvent {
  /** enter (the mode became current) or exit (it ended). */
  readonly kind: 'enter' | 'exit';
  /** The mode entered or left. */
  readonly mode: string;
  /** The mode on the other side of the switch ('' at a run start). */
  readonly other: string;
}
```

<a id="script-type-behavior-timeline-event"></a>
## `BehaviorTimelineEvent`

```ts
/** One timeline event (seen in the step after it happened). */
export interface BehaviorTimelineEvent {
  /** started, ended or marker (a marker of the timeline was reached). */
  readonly kind: 'started' | 'ended' | 'marker';
  readonly handle: number;
  /** The timeline's id. */
  readonly timeline: string;
  /** marker: its name ('' otherwise). */
  readonly name: string;
  /** ended: finished, skipped or stopped ('' otherwise). */
  readonly reason: '' | 'finished' | 'skipped' | 'stopped';
  readonly stepIndex: number;
}
```

<a id="script-type-environment-change-options"></a>
## `EnvironmentChangeOptions`

```ts
/** How a change to an environment preset happens (`ctx.environment.set`). */
export interface EnvironmentChangeOptions {
  /** Seconds the blend takes (0–600; 0 or absent: at once). */
  blend?: number;
  /** How the blend progresses. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  /** Per-field changes over the preset: { sky?, fog?, post?, lights?, lightmap? }, each merged over the preset's (a light list adds entries). */
  override?: { readonly [part: string]: unknown };
}
```

<a id="script-type-wind-change"></a>
## `WindChange`

```ts
/** A change of the global wind (`ctx.environment.setWind`): any of the wind's fields. */
export interface WindChange {
  /** Horizontal direction [x, z], each -1–1, not both 0. */
  direction?: readonly [number, number];
  /** Base strength (0–10; 0: still air). */
  strength?: number;
  /** Extra strength at the gust pattern's peaks (0–10). */
  gust?: number;
  /** Gusts per second (0–10): the pattern's speed when `speed` is not given. */
  gustFrequency?: number;
  /** Small-scale variation (0–1). */
  turbulence?: number;
  /** Metres per second the gust pattern travels (0–100). */
  speed?: number;
  /** Metres the gust pattern spans (0.5–10000). */
  scale?: number;
  /** A texture asset id: the gust pattern (its red channel). */
  noise?: string;
}
```

<a id="script-type-entity-write-result"></a>
## `EntityWriteResult`

```ts
/** What `set` answers: queued (`ok`), or refused with the field and why. */
export interface EntityWriteResult {
  readonly ok: boolean;
  /** The refused field (`light.type`), or the component ('' when queued). */
  readonly field: string;
  /** Why it was refused ('' when queued). */
  readonly code: EntityWriteCode | '';
  readonly message: string;
}
```

<a id="script-type-ui-event-kind"></a>
## `UiEventKind`

```ts
/** What a UI event is. */
export type UiEventKind = 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene' | 'reload' | 'load' | 'unload' | 'hold';
```

<a id="script-type-declared-property"></a>
## `DeclaredProperty`

```ts
export interface DeclaredProperty {
  key: string;
  label: string;
  type: PropertyType;
  default: PropertyValue;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  values?: string[];
  bounds?: PropertyBounds;
  /**
   * Who may see and set the property. `public` (the default; the
   * canonical form omits it) is shown in the Inspector of every object
   * carrying the behavior and overridable per object; `private` is neither
   * shown nor overridable — the script always reads `default`.
   */
  visibility?: PropertyVisibility;
  /** The Inspector section the property is listed in (1–64 characters). */
  group?: string;
  /** A heading shown above the property in the Inspector (1–64 characters). */
  header?: string;
  /** The hover help of the property's field (1–256 characters). */
  tooltip?: string;
}
```

<a id="script-type-debug-command-arg"></a>
## `DebugCommandArg`

```ts
export type DebugCommandArg = number | string | boolean;
```

<a id="script-type-save-storage-code"></a>
## `SaveStorageCode`

```ts
export type SaveStorageCode = (typeof SAVE_STORAGE_CODES)[number];
```

<a id="script-type-project-save-file"></a>
## `ProjectSaveFile`

```ts
/** A stored save document (the whole body of a slot; also what `tl_play_start` accepts as `save`). */
export interface ProjectSaveFile {
  readonly format: 'thirdlight.save';
  readonly formatVersion?: number;
  /** The project document's schema version. */
  readonly version: number;
  readonly playSeconds?: number;
  /** The project's own document. */
  readonly doc: unknown;
  /** Engine state the schema opts into. */
  readonly sections?: Readonly<Partial<Record<SaveSection, unknown>>>;
  /** Format version 2: where the play stands (absent when the game that saved it does not keep it). */
  readonly world?: WorldSave;
}
```

<a id="script-type-dialogue-input-kind"></a>
## `DialogueInputKind`

```ts
export type DialogueInputKind = 'advance' | 'choose' | 'skip' | 'auto' | 'backlog';
```

<a id="script-type-physics-vec3"></a>
## `PhysicsVec3`

```ts
/** A 3D vector (m). */
export interface PhysicsVec3 {
  x: number;
  y: number;
  z: number;
}
```

<a id="script-type-plane-lock"></a>
## `PlaneLock`

```ts
/** A plane: its normal's world axis and where it lies along that axis (m). */
export interface PlaneLock {
  axis: PlaneAxis;
  origin: number;
}
```

<a id="script-type-gamepad-family"></a>
## `GamepadFamily`

```ts
/** The gamepad families glyphs distinguish (from the pad's id; `generic` when unknown). */
export type GamepadFamily = 'xbox' | 'playstation' | 'switch' | 'generic';
```

<a id="script-type-input-binding-status"></a>
## `InputBindingStatus`

```ts
/** One binding of an action as scripts see it (its position in `bindings` is the index rebinding addresses). */
export interface InputBindingStatus extends InputGlyph {
  readonly device: InputBindingDevice;
  /** The binding kind (key, gamepadButton, keys1d, pointerButton, …). */
  readonly kind: string;
  /** Hold instead of tap: seconds the binding must be held. */
  readonly hold?: number;
}
```

<a id="script-type-input-glyph-part"></a>
## `InputGlyphPart`

```ts
/** One part of a composite binding's glyph. */
export interface InputGlyphPart {
  readonly part: InputBindingPart;
  readonly label: string;
  readonly icon: string;
  /** The project's own image (a texture asset id), when it overrides the icon. */
  readonly image?: string;
}
```

<a id="script-type-input-binding-part"></a>
## `InputBindingPart`

```ts
/** A composite binding's part (two keys/buttons: negative, positive; four keys: up, down, left, right). */
export type InputBindingPart = 'negative' | 'positive' | 'up' | 'down' | 'left' | 'right';
```

<a id="script-type-input-binding-conflict"></a>
## `InputBindingConflict`

```ts
/** An action binding that uses the same input as a new binding. */
export interface InputBindingConflict {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
}
```

<a id="script-type-rebind-conflict-policy"></a>
## `RebindConflictPolicy`

```ts
/** What happens when a new binding's input is already used by another action of the same map. */
export type RebindConflictPolicy = 'swap' | 'refuse' | 'allow';
```

<a id="script-type-debug-command-arg-spec"></a>
## `DebugCommandArgSpec`

```ts
/** One declared argument of a debug command. */
export interface DebugCommandArgSpec {
  /** The argument's name (a letter or _, then letters, digits, _ . : -). */
  readonly name: string;
  readonly type: DebugCommandArgType;
  /** May be left out of a call (a call without it has no such key). */
  readonly optional?: boolean;
}
```

<a id="script-type-grid-door-side"></a>
## `GridDoorSide`

```ts
/** One side of a linked door (world metres; `facing`: degrees about +Y turning +Z toward the way out of the door on that side). */
export interface GridDoorSide {
  readonly position: readonly [number, number, number];
  readonly spawn: readonly [number, number, number];
  readonly facing: number;
}
```

<a id="script-type-block-cell"></a>
## `BlockCell`

```ts
/** One cell's value. At least one of `block` / `meta`. */
export interface BlockCell {
  /** The block type (`content.blockTypes[].blockId`); absent = a metadata-only cell. */
  block?: string;
  /** Degrees about +Y (counter-clockwise seen from above): 90, 180 or 270; absent = 0. */
  rot?: 90 | 180 | 270;
  /** The variant index; absent = picked from the weights by the cell coordinates. */
  variant?: number;
  /**
   * The heights of the block's top corners — −x−z, +x−z, +x+z, −x+z in the
   * layer's axes, whatever the rotation — in cell heights above the cell's
   * bottom, 0–4 in steps of 1/64 (absent: a flat full top, all 1). A
   * single-cell `full` block only: sloped terrain. Above 1, so a slope that
   * crosses row boundaries inside one column stays one smooth surface (the
   * cell reaches into the cells above it, which then stay empty). The top is
   * two triangles split along one diagonal (`splitsMainDiagonal`); the sides
   * follow the corners.
   */
  corners?: [number, number, number, number];
  /** Metadata overrides (field key → value); the block's defaults and the schema's fill the rest. */
  meta?: Record<string, CellMetaValue>;
}
```

<a id="script-type-block-edge"></a>
## `BlockEdge`

```ts
/** One edge piece. */
export interface BlockEdge {
  /** The edge block type (`placement: 'edge'`). */
  block: string;
  /** 180: it faces the other way (−x or −z); absent: +x for an x-line edge, +z for a z-line one. */
  rot?: 180;
  /** The look (variant index); absent: picked from the weights by the edge's place. */
  variant?: number;
  /** Open (a door): it lets passage through and has no collider. Absent: closed; stored only when true. */
  open?: boolean;
}
```

<a id="script-type-voxel-value"></a>
## `VoxelValue`

```ts
/** A voxel as scripts read and write it. */
export interface VoxelValue {
  /** Material id (0: air). */
  readonly material: number;
  /** Role (0: air): what the voxel is to meshing and collision (ground, wall, beam, …). */
  readonly role: number;
  /** Fill level, 0 (empty) to 15 (full). */
  readonly shape: number;
  /** Wetness, 0 (dry) to 7. */
  readonly wetness: number;
}
```

<a id="script-type-voxel-ray-options"></a>
## `VoxelRayOptions`

```ts
/** What stops a ray (`raycast`): a voxel drawn as a body (`solid`), or one that blocks light (`light`). */
export interface VoxelRayOptions {
  readonly stop?: 'solid' | 'light';
}
```

<a id="script-type-voxel-ray-hit"></a>
## `VoxelRayHit`

```ts
/** Where a ray met the world. */
export interface VoxelRayHit {
  /** Metres from the origin to where the ray enters the voxel. */
  readonly distance: number;
  /** That point (world metres). */
  readonly point: readonly [number, number, number];
  /** The centre of the voxel hit (world metres): `get`, `dig` and `set` at it act on that voxel. */
  readonly at: readonly [number, number, number];
  /** The face entered, as its outward normal (0, 0, 0: the ray started inside). */
  readonly normal: readonly [number, number, number];
  /** The voxel (null: met in the coarser levels or the far field, which hold no single voxel). */
  readonly voxel: VoxelValue | null;
  /** Met in the far field or a coarser level than full detail. */
  readonly far: boolean;
}
```

<a id="script-type-voxel-region-info"></a>
## `VoxelRegionInfo`

```ts
/**
 * The open region a cell is in (`regionAt`): connected open cells (not drawn as a body: air, liquid, rails and
 * posts; joined across cell faces, never by an edge alone), or a portal (the cells of a door or window opening,
 * which separate the regions either side of it).
 */
export interface VoxelRegionInfo {
  /** The region's id: the same while the region does not change (it is joined or split by an edit, or grows as chunks load). */
  readonly id: number;
  /** The cell is in an opening (a portal between regions), not in a region. */
  readonly portal: boolean;
  /**
   * Nothing of the region is under open sky, it reaches no space that is not loaded yet, and not the world's
   * edge: a room whose openings are its only ways out. A region reaching a chunk not loaded is never enclosed.
   */
  readonly enclosed: boolean;
  /** The region reaches no space that is not loaded yet (false: it may continue there). */
  readonly complete: boolean;
  /** The region's volume in m³ (the loaded part of it while not complete). */
  readonly volume: number;
  /** This cell is under open sky: no solid voxel above it in its column (as far as the world is loaded). */
  readonly sky: boolean;
  /** Some cell of the region is under open sky. */
  readonly seesSky: boolean;
  /** A region: the portals (openings) on its boundary; a portal: the regions it joins. */
  readonly portals: number;
  /** A room, the outdoors, a portal, or not known yet ({@link VoxelRegionKind}). */
  readonly kind: VoxelRegionKind;
  /** The box its cells fill (world metres; the loaded part while not complete). */
  readonly bounds: VoxelBox;
  /** Its surface against solid voxels in m² (cell faces of 0.25 m²; door and window openings are not surface). */
  readonly surface: number;
  /**
   * Its mean free path in metres, 4 × volume / surface: the mean distance sound travels between two reflections in
   * it (Sabine's room estimate; 0 with no surface). A 4 × 3 × 5 m room: 2.55 m.
   */
  readonly meanFreePath: number;
}
```

<a id="script-type-voxel-portal-info"></a>
## `VoxelPortalInfo`

```ts
/** A door or window opening (`portalsOf`): its box and the regions it joins. */
export interface VoxelPortalInfo {
  /** The portal's id (its cells read as this in `regionAt`, with `portal` true). */
  readonly id: number;
  /** The box its opening cells fill (world metres). */
  readonly bounds: VoxelBox;
  /** Its opening's area across: the cells it holds × 0.125 m³ (its volume, m³). */
  readonly volume: number;
  /** The regions it joins (ids, ascending): a door between a room and the outdoors names both. */
  readonly regions: readonly number[];
}
```

<a id="script-type-voxel-walk-options"></a>
## `VoxelWalkOptions`

```ts
/** How a path or reach query walks (`findPath`, `reach`), in metres. */
export interface VoxelWalkOptions {
  /**
   * The walker's height (default 2 m, at most 8): it goes only where that much is free over the floor (whole 0.5 m
   * cells, rounded up). Its footprint is one cell: a walker up to 0.25 m in radius.
   */
  readonly height?: number;
  /** The deepest drop it walks off a ledge (default 0: it never drops; whole cells, rounded down; with its height at most 8 m). */
  readonly maxDrop?: number;
  /** At most this many places searched (default: no bound): past it the answer is `partial`, the way to where it got closest. */
  readonly maxNodes?: number;
}
```

<a id="script-type-voxel-material-info"></a>
## `VoxelMaterialInfo`

```ts
/**
 * A voxel material as the game reads it at run time (`ctx.voxels.materialOf`): the record that voxel id is, with its
 * physics resolved and its game data (both as the build ships them: profile numbers and game data folded in).
 */
export interface VoxelMaterialInfo {
  /** The voxel material id. */
  readonly id: number;
  readonly materialId: string;
  readonly name: string;
  readonly use: VoxelMaterialUse;
  /** The kit whose pieces its edges draw (null: none). */
  readonly kit: string | null;
  readonly physical: ResolvedPhysical;
  /** The game's own data (null: none), never read by the engine. */
  readonly gameData: MaterialGameData | null;
}
```

<a id="script-type-voxel-region"></a>
## `VoxelRegion`

```ts
/**
 * Where a read or change applies, in world metres: the cell holding a
 * point, every cell a box touches, or every cell whose centre lies within a
 * ball.
 */
export type VoxelRegion =
  | { readonly at: readonly [number, number, number] }
  | { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }
  | { readonly center: readonly [number, number, number]; readonly radius: number };
```

<a id="script-type-voxel-write"></a>
## `VoxelWrite`

```ts
/** The voxel `set` writes: shape absent is full, wetness absent is dry. */
export interface VoxelWrite {
  readonly material: number;
  readonly role: number;
  readonly shape?: number;
  readonly wetness?: number;
}
```

<a id="script-type-voxel-edit-result"></a>
## `VoxelEditResult`

```ts
/** A change's answer: its id (named again by its entry in `changes`) and the cells it changed (0: it changed nothing). */
export type VoxelEditResult = { readonly ok: true; readonly edit: number; readonly cells: number } | VoxelRefused;
```

<a id="script-type-voxel-paint"></a>
## `VoxelPaint`

```ts
/** What `paint` changes: material and wetness only (shader data; meshes and colliders stand). */
export interface VoxelPaint {
  readonly material?: number;
  readonly wetness?: number;
}
```

<a id="script-type-voxel-field"></a>
## `VoxelField`

```ts
/** A field of a voxel (what a save keeps of a change is chosen by field). */
export type VoxelField = 'material' | 'role' | 'shape' | 'wetness';
```

<a id="script-type-voxel-rings"></a>
## `VoxelRings`

```ts
/** The distances a world streams with now (metres, after the quality level), the level they are for and its memory budget. */
export interface VoxelRings {
  readonly ring: { readonly loadRadius: number; readonly unloadRadius: number; readonly loadHeight: number; readonly unloadHeight: number };
  readonly collision: { readonly radius: number; readonly height: number };
  readonly levels: { readonly level0: number; readonly level1: number; readonly relief: number };
  /** The quality level (null: the page has not reported one yet; the scene's own distances apply). */
  readonly quality: string | null;
  /** The stream memory budget in bytes (null: the host's). */
  readonly budgetBytes: number | null;
  /** Relief lattice steps a cell within `levels.relief` (the quality level's; 0: no relief). */
  readonly reliefSteps: number;
}
```

<a id="script-type-voxel-ring-change"></a>
## `VoxelRingChange`

```ts
/** A change to a world's distances in metres (each group and field optional; what is left out stays). */
export interface VoxelRingChange {
  /** Where chunks load (`loadRadius`, `loadHeight`) and how far past it they stay (`unloadRadius`, `unloadHeight`). */
  readonly ring?: { readonly loadRadius?: number; readonly unloadRadius?: number; readonly loadHeight?: number; readonly unloadHeight?: number };
  /** Where loaded chunks have colliders round a focus. */
  readonly collision?: { readonly radius?: number; readonly height?: number };
  /** Where level 0 (full detail, with the kit pieces) and level 1 are drawn, past level 1 level 2; within `relief` (0: none) surfaces are drawn with relief. */
  readonly levels?: { readonly level0?: number; readonly level1?: number; readonly relief?: number };
}
```

<a id="script-type-voxel-rings-result"></a>
## `VoxelRingsResult`

```ts
/** A ring change's answer: the distances now in use, or why nothing changed. */
export type VoxelRingsResult = { readonly ok: true; readonly rings: VoxelRings } | VoxelRefused;
```

<a id="script-type-voxel-mismatch-choice"></a>
## `VoxelMismatchChoice`

```ts
/**
 * What wins where a save was made on other world files than the running
 * game's (a re-exported world changed the chunk): the player's changed
 * cells over the new files (`save`), or the new files alone (`base`).
 */
export type VoxelMismatchChoice = 'save' | 'base';
```

<a id="script-type-voxel-restore-result"></a>
## `VoxelRestoreResult`

```ts
/** A restore's answer: its id (named again in `changes` once the loaded pieces it changed are swapped in) and the save's changed pieces. */
export type VoxelRestoreResult = { readonly ok: true; readonly edit: number; readonly chunks: number } | VoxelRefused;
```

<a id="script-type-voxel-box"></a>
## `VoxelBox`

```ts
/** A box in world metres. */
export interface VoxelBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
```

<a id="script-type-voxel-path-status"></a>
## `VoxelPathStatus`

```ts
/**
 * How a path query ended: `found` (the cheapest way, or within a few per cent of it on a long path), `partial` (its
 * `maxNodes` was spent: the way to where it got closest), `unreachable` (every way out of the start is known and none
 * reaches the end), `unknown` (it ran into chunks not loaded yet: the way to where the known world ends nearest the
 * end, or no world loaded).
 */
export type VoxelPathStatus = 'found' | 'partial' | 'unreachable' | 'unknown';
```

<a id="script-type-entity-write-code"></a>
## `EntityWriteCode`

```ts
/** Why a write was refused: the descriptor check's codes and the runtime's. */
export type EntityWriteCode =
  | ScriptWriteCode
  | 'entity_unknown'
  | 'component_missing'
  | 'entity_physics'
  | 'entity_camera'
  | 'entity_character'
  | 'entity_static'
  | 'entity_driven'
  | 'material_parameter'
  | 'material_unknown'
  | 'write_limit';
```

<a id="script-type-property-type"></a>
## `PropertyType`

```ts
export type PropertyType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'enum'
  | 'vec3'
  | 'entityRef'
  | 'assetRef';
```

<a id="script-type-property-bounds"></a>
## `PropertyBounds`

```ts
export interface PropertyBounds {
  min: Vec3;
  max: Vec3;
}
```

<a id="script-type-property-visibility"></a>
## `PropertyVisibility`

```ts
/** Declared-property visibility (Unity-like public/private). */
export type PropertyVisibility = 'public' | 'private';
```

<a id="script-type-save-storage-codes"></a>
## `SAVE_STORAGE_CODES`

```ts
/**
 * Why the player's storage refused a write, for the game's own message
 * (the browser's text is the result's `reason`): the disk or the site's
 * quota is full, the page has no storage (IndexedDB off, a private window
 * that refuses it), or any other refusal.
 */
export const SAVE_STORAGE_CODES: readonly ["storage_full", "storage_unavailable", "storage_failed"];
```

<a id="script-type-save-section"></a>
## `SaveSection`

```ts
export type SaveSection = (typeof SAVE_SECTIONS)[number];
```

<a id="script-type-world-save"></a>
## `WorldSave`

```ts
/**
 * Where the play stands in a save — the scenes loaded (in load
 * order), the spawn respawns use, the game shell's scene list entry (-1:
 * none) and the character (the controller's object) with its velocity (m/s)
 * and the way it faces (degrees about +Y, as
 * `characterState().facing` reads it; older saves have none), or null
 * without a character. With several player controllers `character` is the
 * first's and `characters` holds the others by their object (absent: a save
 * of one player, or an older one — the others stay where they are).
 */
export interface WorldSave {
  readonly scenes: readonly string[];
  readonly activeSpawn: string | null;
  readonly listedScene: number;
  readonly character: SavedCharacter | null;
  readonly characters?: Readonly<Record<string, SavedCharacter>>;
}
```

<a id="script-type-plane-axis"></a>
## `PlaneAxis`

```ts
export type PlaneAxis = (typeof PLANE_AXES)[number];
```

<a id="script-type-input-binding-device"></a>
## `InputBindingDevice`

```ts
/** Where a binding comes from. */
export type InputBindingDevice = 'keyboard' | 'mouse' | 'gamepad';
```

<a id="script-type-debug-command-arg-type"></a>
## `DebugCommandArgType`

```ts
/** The type of a debug command argument. */
export type DebugCommandArgType = 'number' | 'string' | 'boolean';
```

<a id="script-type-cell-meta-value"></a>
## `CellMetaValue`

```ts
/** A metadata value: bool, number (int/float) or string. */
export type CellMetaValue = boolean | number | string;
```

<a id="script-type-voxel-region-kind"></a>
## `VoxelRegionKind`

```ts
/**
 * What a region is to a game: a `room` (enclosed: complete, nothing of it under open sky, not at the world's edge),
 * the `outdoors` (some cell of it under open sky), a `portal` (a door or window opening between regions), or
 * `unknown` (it reaches space not loaded yet, or the world's edge: not a room, not known to be outdoors).
 */
export type VoxelRegionKind = 'room' | 'outdoors' | 'portal' | 'unknown';
```

<a id="script-type-voxel-material-use"></a>
## `VoxelMaterialUse`

```ts
export type VoxelMaterialUse = (typeof VOXEL_MATERIAL_USES)[number];
```

<a id="script-type-resolved-physical"></a>
## `ResolvedPhysical`

```ts
/** A material's physics with every number filled in, as the game and the engine read it. */
export interface ResolvedPhysical {
  /** The profile it came from (absent: none named). */
  readonly profile?: string;
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  /** Absent: not a liquid (no profile or override gives one). */
  readonly flowRate?: number;
}
```

<a id="script-type-material-game-data"></a>
## `MaterialGameData`

```ts
/** Opaque game data (any JSON within the kit format's depth bound). */
export type MaterialGameData = GameDataJson;
```

<a id="script-type-voxel-refused"></a>
## `VoxelRefused`

```ts
/** A change or restore not made, and why. */
export interface VoxelRefused {
  readonly ok: false;
  readonly reason: VoxelRefusal;
  readonly message: string;
}
```

<a id="script-type-script-write-code"></a>
## `ScriptWriteCode`

```ts
/** Why a write was refused (the runtime adds its own: see runtime `EntityWriteCode`). */
export type ScriptWriteCode = 'component_unknown' | 'patch_invalid' | 'field_unknown' | 'field_not_writable' | 'field_not_applicable' | 'field_value';
```

<a id="script-type-vec3"></a>
## `Vec3`

```ts
/** Three finite numbers (meters), in canonical order. */
export type Vec3 = [number, number, number];
```

<a id="script-type-save-sections"></a>
## `SAVE_SECTIONS`

```ts
export const SAVE_SECTIONS: readonly ["grid", "materials", "spawned", "storage", "environment", "dialogue", "components", "world"];
```

<a id="script-type-saved-character"></a>
## `SavedCharacter`

```ts
/** A player controller's place in a save: position, velocity (m/s) and, in 3D, its facing (degrees). */
export interface SavedCharacter {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly facing?: number;
}
```

<a id="script-type-plane-axes"></a>
## `PLANE_AXES`

```ts
/** The world axes a plane's normal may lie along (Y is "up", so a plane through it would be a floor). */
export const PLANE_AXES: readonly ["x", "z"];
```

<a id="script-type-voxel-material-uses"></a>
## `VOXEL_MATERIAL_USES`

```ts
/** What a voxel material is used for. */
export const VOXEL_MATERIAL_USES: readonly ["construction", "terrain", "liquid"];
```

<a id="script-type-game-data-json"></a>
## `GameDataJson`

```ts
export type GameDataJson = null | boolean | number | string | GameDataJson[] | { [key: string]: GameDataJson };
```

<a id="script-type-voxel-refusal"></a>
## `VoxelRefusal`

```ts
/** Why a change was not made (nothing was written). */
export type VoxelRefusal = 'no_world' | 'not_resident' | 'invalid';
```

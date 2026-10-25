# Script API types (from `InputRebindTarget`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-input-rebind-target"></a>
## `InputRebindTarget`

```ts
/** A rebind's target: an action, which of its bindings and (composites) which part. */
export interface InputRebindTarget {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
}
```

<a id="script-type-input-rebind-options"></a>
## `InputRebindOptions`

```ts
/** Options of a listen-for-input rebind (`ctx.input.rebind`). */
export interface InputRebindOptions {
  /** Which of the action's bindings (its index in `bindings()`); absent: the first one of the device. */
  readonly index?: number;
  /** A composite binding's part (negative/positive, up/down/left/right). */
  readonly part?: InputBindingPart;
  /** The device to listen to (absent: the device used last). Keyboard and mouse listen together. */
  readonly device?: InputDeviceKind;
  /** When the input is already used in the same map: swap (default), refuse or allow. */
  readonly policy?: RebindConflictPolicy;
  /** The key that cancels listening (a KeyboardEvent.code; default Escape). */
  readonly cancelKey?: string;
  /** Seconds to listen before giving up (default 10; 1–60). */
  readonly timeout?: number;
}
```

<a id="script-type-health-event-record"></a>
## `HealthEventRecord`

```ts
/** A change of an object's health (seen in the step after it happened). */
export interface HealthEventRecord {
  readonly type: 'damaged' | 'healed' | 'died';
  /** The object whose health changed. */
  readonly entity: string;
  /** damaged/healed: how much it changed (died: 0). */
  readonly amount: number;
  /** Its health after the change. */
  readonly current: number;
  /** What caused it (an object id, or any text a script passed; '' when none). */
  readonly source: string;
  readonly stepIndex: number;
}
```

<a id="script-type-patrol-event-record"></a>
## `PatrolEventRecord`

```ts
/** A patroller turned around (at a wall, a ledge, the end of its waypoints, or by a script). */
export interface PatrolEventRecord {
  readonly type: 'turned';
  readonly entity: string;
  readonly reason: 'wall' | 'ledge' | 'end' | 'script';
  /** The direction it walks in now (a unit vector). */
  readonly direction: readonly [number, number, number];
  readonly stepIndex: number;
}
```

<a id="script-type-collect-event-record"></a>
## `CollectEventRecord`

```ts
/** A collectible was collected (by the character) or came back. */
export interface CollectEventRecord {
  readonly type: 'collected' | 'restored';
  readonly entity: string;
  readonly counter: string;
  /** collected: what it added (restored: 0). */
  readonly amount: number;
  /** collected: the object that collected it ('' on restored). */
  readonly by: string;
  readonly stepIndex: number;
}
```

<a id="script-type-behavior-random-stream"></a>
## `BehaviorRandomStream`

```ts
/**
 * One seeded random number stream (`ctx.random`, `ctx.random.stream(name)`).
 * Replay-safe: the numbers come from the project's `random_seed` setting mixed with the
 * script id, the object's id and the stream name, and advance only when drawn — a replay,
 * the simulation worker and the page all draw the same numbers. Each new run starts over.
 */
export interface BehaviorRandomStream {
  /**
   * A number in [0, 1) (a multiple of 2^-32).
   * @graphNode Seeded random
   */
  next(): number;
  /**
   * A number in [min, max).
   * @graphNode Seeded random range
   * @graphDefault max 1
   */
  range(min: number, max: number): number;
  /**
   * A whole number from `min` to `max`, both included (the bounds are rounded inward).
   * @graphNode Seeded random integer
   * @graphDefault max 6
   */
  int(min: number, max: number): number;
  /**
   * True with probability `p` (0: never, 1: always).
   * @graphNode Seeded chance
   * @graphDefault p 0.5
   */
  chance(p: number): boolean;
  /**
   * One item of `list` chosen evenly, or `undefined` when it is empty.
   * @graphNode skip a list's random item is Seeded random integer with the list's Get item
   */
  pick<T>(list: readonly T[]): T | undefined;
}
```

<a id="script-type-character-walk-options"></a>
## `CharacterWalkOptions`

```ts
/** `ctx.character.walkTo`'s options. */
export interface CharacterWalkOptions {
  /** At the run speed. */
  run?: boolean;
  /** How near the mark counts as arrived (m, 0.01–100; absent: 0.1). */
  arrive?: number;
  /** Degrees about +Y to face once arrived (absent: as it walked in). */
  facing?: number;
  /** The player controller's object (absent: the first). */
  entityId?: string;
}
```

<a id="script-type-behavior-look-value"></a>
## `BehaviorLookValue`

```ts
/**
 * A look override (`ctx.look.set`): an emissive glow and a tint
 * multiplied into the object's own colour, on every mesh under the object.
 */
export interface BehaviorLookValue {
  /** The glow colour ('#rrggbb'). */
  emissive?: string;
  /** How strongly it glows (0–4; absent with a glow colour: 1). */
  emissiveIntensity?: number;
  /** A colour ('#rrggbb') multiplied into the object's own colour. */
  tint?: string;
}
```

<a id="script-type-audio-play-options"></a>
## `AudioPlayOptions`

```ts
/** Options of `ctx.audio.play`. */
export interface AudioPlayOptions {
  /** 0–1 (1). */
  volume?: number;
  /** Loop until stopped (false). */
  loop?: boolean;
  /** Playback rate, 0.25–4 (1: as recorded; 2: an octave up and twice as fast). */
  pitch?: number;
  /** The bus (sfx). */
  bus?: 'sfx' | 'music' | 'voice' | 'ui';
  /** Seconds to fade in from silence (0). */
  fadeIn?: number;
  /** Positional: follow this entity (`position` is then an offset from it). */
  entityId?: string;
  /** Positional: world position in metres (or the offset from `entityId`). */
  position?: readonly number[];
  /** Positional: linear, inverse or exponential (linear). */
  distanceModel?: 'linear' | 'inverse' | 'exponential';
  /** Positional: full volume within this distance, m (2). */
  refDistance?: number;
  /** Positional: silent (linear) or no more fading (others) beyond this distance, m (30). */
  maxDistance?: number;
  /** Positional: how fast it fades (1). */
  rolloff?: number;
  /**
   * How late it may still start, in ms (500): a sound whose file is not
   * ready when it is played starts when it is, unless that is later than
   * this; then it is dropped (the audio observation says which happened).
   * 0: now or never. The simulation's timing never waits for it.
   */
  maxLateMs?: number;
  /**
   * What the sound belongs to (`object`): it stops when the script's object
   * leaves the game (its scene unloads or reloads, a spawned copy is
   * destroyed); `scene`: when the object's scene unloads or reloads (a
   * spawned copy's: with the copy); `none`: it plays until stopped.
   */
  owner?: 'object' | 'scene' | 'none';
  /** Seconds it fades out over when its owner stops it (0). */
  fadeOut?: number;
}
```

<a id="script-type-audio-finished-event"></a>
## `AudioFinishedEvent`

```ts
/** A script sound's end (`ctx.audio.events()`), seen in the step after it happened. */
export interface AudioFinishedEvent {
  readonly kind: 'finished';
  readonly handle: number;
  readonly assetId: string;
  /** `ended`: it played to its end; `stopped`: a script stopped it (after its fade). */
  readonly reason: 'ended' | 'stopped';
}
```

<a id="script-type-audio-music-options"></a>
## `AudioMusicOptions`

```ts
/** Options of `ctx.audio.music`. */
export interface AudioMusicOptions {
  /** What the track belongs to (`object`; see `AudioPlayOptions.owner`): when it goes, the music is released over the track's fade. */
  owner?: 'object' | 'scene' | 'none';
}
```

<a id="script-type-audio-stinger-options"></a>
## `AudioStingerOptions`

```ts
/** Options of `ctx.audio.stinger`. */
export interface AudioStingerOptions {
  /** 0–1 (1). */
  volume?: number;
  /** The music's level under it, 0–1 (0.3). */
  duck?: number;
  /** Seconds to duck and to come back (0.25). */
  fade?: number;
  /** How late it may still start, in ms (500; see `AudioPlayOptions.maxLateMs`). */
  maxLateMs?: number;
  /** What it belongs to (`object`; see `AudioPlayOptions.owner`). */
  owner?: 'object' | 'scene' | 'none';
  /** Seconds it fades out over when its owner stops it (0). */
  fadeOut?: number;
}
```

<a id="script-type-audio-music-state"></a>
## `AudioMusicState`

```ts
/** A script's view of the music (`ctx.audio.musicState()`). */
export interface AudioMusicState {
  /** Who picks the track: the scripts (after `music`), or the host (`flow`: the engine has no level flow, so nothing plays then). */
  readonly owner: 'script' | 'flow';
  /** The scripts' track (null: silence, or the host owns it). */
  readonly track: string | null;
  /** The music duck now (1 = not ducked). */
  readonly duck: number;
}
```

<a id="script-type-debug-command-options"></a>
## `DebugCommandOptions`

```ts
/** How a script declares a debug command (`ctx.debug.command(name, options)`). */
export interface DebugCommandOptions {
  /** One line the console and tools show (at most 120 characters). */
  readonly description?: string;
  /** The arguments in order (at most 8; the console also takes them by position). */
  readonly args?: readonly DebugCommandArgSpec[];
}
```

<a id="script-type-debug-command-args"></a>
## `DebugCommandArgs`

```ts
/** The arguments of one debug command call. */
export type DebugCommandArgs = Readonly<Record<string, DebugCommandArg>>;
```

<a id="script-type-grid-cell"></a>
## `GridCell`

```ts
/** A cell as scripts read it: its block (null: a metadata-only cell), rotation, variant and effective metadata. */
export interface GridCell {
  readonly block: string | null;
  /** Degrees about +Y the block is shown at: 0, 90, 180 or 270 (a connected block: the turn its neighbours resolve). */
  readonly rot: number;
  /** The variant shown (an unset variant resolved from the weights and the position, or a connected block's piece). */
  readonly variant: number;
  /** A connected block's piece (single, end, straight, corner, t, cross, base, cap); absent: not connected or no rule for it. */
  readonly piece?: string;
  /** The block a kit draws in its place (`setKit`; rot, variant and piece are that block's); absent: no kit swaps it. `block` stays the cell's own. */
  readonly kitBlock?: string;
  /** The effective metadata (schema defaults, then the block's defaults, then the cell's own values). */
  readonly meta: Readonly<Record<string, number | string | boolean>>;
  /** For a cell covered by a larger block's footprint: that block's anchor cell (absent otherwise). */
  readonly anchor?: GridVec3;
  /**
   * A sloped top: the heights of its corners (−x−z, +x−z, +x+z, −x+z) in cell heights above its bottom, 0-4 (absent: a flat full top, all 1).
   * @graphType list
   */
  readonly corners?: readonly number[];
}
```

<a id="script-type-grid-cell-input"></a>
## `GridCellInput`

```ts
/** What `ctx.grid.set` writes: a block (with rotation and variant) and/or metadata overrides. */
export interface GridCellInput {
  /** A block type id (absent: a metadata-only cell). */
  block?: string;
  /** Degrees about +Y: 0, 90, 180 or 270. */
  rot?: number;
  /** A variant index (absent: picked from the weights by position). */
  variant?: number;
  /**
   * A sloped top (a single-cell full block): the heights of its corners −x−z, +x−z, +x+z, −x+z in cell heights above its bottom, 0-4 in steps of 1/64 (absent: flat).
   * @graphType list
   */
  corners?: readonly number[];
  /**
   * Metadata overrides (field key → value).
   * @graphType map
   */
  meta?: Record<string, number | string | boolean>;
}
```

<a id="script-type-grid-surface"></a>
## `GridSurface`

```ts
/** The ground of a layer at a point (`ctx.grid.surface`, `columnSurface`). */
export interface GridSurface {
  readonly layer: string;
  /** The cell whose top it is. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The world height of the surface there (metres). */
  readonly height: number;
  /** The surface point in world space. */
  readonly point: GridVec3;
  /** The surface's unit normal. */
  readonly normal: GridVec3;
  /** Degrees from level. */
  readonly slope: number;
  /** Whether the slope is at most the layer's maxSlope (absent: the project's steepest walkable slope). */
  readonly walkable: boolean;
}
```

<a id="script-type-grid-vec3"></a>
## `GridVec3`

```ts
/** A position or direction in world space (metres). */
export interface GridVec3 {
  x: number;
  y: number;
  z: number;
}
```

<a id="script-type-grid-pick"></a>
## `GridPick`

```ts
/** A ray pick's result. */
export interface GridPick {
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The face the ray entered through (a unit axis vector). */
  readonly normal: GridVec3;
  /** Metres along the ray. */
  readonly distance: number;
  readonly point: GridVec3;
}
```

<a id="script-type-grid-walk-options"></a>
## `GridWalkOptions`

```ts
/** Options of the walk queries; absent fields take the layer's `walk`, then the engine's defaults. */
export interface GridWalkOptions {
  /** How far a step may rise (m). */
  maxStep?: number;
  /** How far a step may drop (m). */
  maxDrop?: number;
  /** The free height a place needs above it (m). */
  headroom?: number;
  /** The steepest top that can be stood on (degrees; absent: the layer's maxSlope, else the project's). */
  maxSlope?: number;
  /** Steps across cell corners too (both ways round the corner walkable). */
  diagonal?: boolean;
  /** A boolean cell field: only tops whose cell has it true are walked (absent: the layer's walk field, else every top). */
  field?: string;
  /** A number cell field: entering a place costs its cell's value per metre (absent: 1 per metre); 0 or less: it cannot be entered. */
  costField?: string;
  /**
   * Cells that cannot be entered (places other units stand on), as [x, y, z] each; a start is never avoided.
   * @graphType list
   */
  avoid?: readonly (readonly number[])[];
}
```

<a id="script-type-grid-walk-place"></a>
## `GridWalkPlace`

```ts
/** A place on a walk: the cell whose top it is, the point on that top at the cell's centre, and the cost to it (m, times any cost field). */
export interface GridWalkPlace {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly point: { readonly x: number; readonly y: number; readonly z: number };
  readonly cost: number;
}
```

<a id="script-type-grid-walk-path-outcome"></a>
## `GridWalkPathOutcome`

```ts
/**
 * Why a walk path query answered as it did: `found`; `none`, no walk joins
 * the two places; `limit`, the search passed its place limit first (a path
 * may still exist: a null path alone cannot tell the two apart); `invalid`,
 * a layer, cell or option that does not fit, or no place at a cell.
 */
export type GridWalkPathOutcome = 'found' | 'none' | 'limit' | 'invalid';
```

<a id="script-type-grid-door-link"></a>
## `GridDoorLink`

```ts
/** A door of a building whose interior is a scene of its own, from one side (`ctx.grid.doorLinks`). */
export interface GridDoorLink extends GridDoorSide {
  /** `<building>/<door>`: the same on both sides. */
  readonly id: string;
  readonly building: string;
  readonly door: string;
  /** The object this side is drawn on, and its scene (null: none known). */
  readonly entity: string;
  readonly scene: string | null;
  readonly side: 'outside' | 'inside';
  /** The other side: the scene it is in, its door and where one arriving through it stands. */
  readonly to: GridDoorSide & { readonly scene: string };
}
```

<a id="script-type-grid-edge"></a>
## `GridEdge`

```ts
/** An edge piece as scripts read it (`ctx.grid.edge`): a wall, door or fence on a cell's side. */
export interface GridEdge {
  readonly block: string;
  /** 0, or 180: it faces the other way (a connected piece: the way its ends resolve). */
  readonly rot: number;
  /** The look shown (an unset one resolved from the weights and the place, or a connected piece). */
  readonly variant: number;
  /** A connected piece's piece (single, end, straight, corner, base, cap); absent: not connected or no rule for it. */
  readonly piece?: string;
  /** The edge piece a kit draws in its place (rot, variant, piece and blocked are that piece's); absent: no kit swaps it. */
  readonly kitBlock?: string;
  /** Open (a door). */
  readonly open: boolean;
  /** Whether it blocks passage across the edge now (its type blocks, and it is not open). */
  readonly blocked: boolean;
}
```

<a id="script-type-grid-edge-input"></a>
## `GridEdgeInput`

```ts
/** What `ctx.grid.setEdge` writes. */
export interface GridEdgeInput {
  /** An edge block type id. */
  block: string;
  /** 0, or 180: it faces the other way. */
  rot?: number;
  /** A variant index (absent: picked from the weights by place). */
  variant?: number;
  /** Open (a door: no passage blocked, no collider). */
  open?: boolean;
}
```

<a id="script-type-grid-change"></a>
## `GridChange`

```ts
/** One cell written by a script (`ctx.grid.changes()`). */
export interface GridChange {
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The block before and after (null: none). */
  readonly before: string | null;
  readonly after: string | null;
  readonly stepIndex: number;
  /** An edge piece written: the side of the cell it stands on (absent: the cell itself). */
  readonly side?: '-x' | '-z';
}
```

<a id="script-type-grid-diff"></a>
## `GridDiff`

```ts
/** The cells scripts changed, as plain data (store it in a save, give it back with `applyDiff`). */
export interface GridDiff {
  readonly version: 1;
  readonly layers: readonly {
    readonly layer: string;
    readonly cells: readonly (readonly [number, number, number, BlockCell | null])[];
    /** Edge pieces changed: [x, y, z, axis (0: the cell's −x side, 1: its −z side), edge | null]; absent: none. */
    readonly edges?: readonly (readonly [number, number, number, number, BlockEdge | null])[];
  }[];
  /** The block types' material swaps (block id → slot → material over the type's own mapping); absent: none. */
  readonly types?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The kits scripts set (`setKit`): [layer, region (null: the whole layer), kit (null: none)]; absent: none. */
  readonly kits?: readonly (readonly [string, string | null, string | null])[];
  /** The architecture presets scripts swapped (`setArchitecturePreset`): [preset, the one shown in its place]; absent: none. */
  readonly architecturePresets?: readonly (readonly [string, string])[];
}
```

<a id="script-type-scatter-copy-info"></a>
## `ScatterCopyInfo`

```ts
/** A copy as scripts see it. */
export interface ScatterCopyInfo {
  /** Its address (what `get`, `hide`, `show` and `remove` take, and what a ray hit names). */
  readonly address: string;
  /** The terrain or block layer it stands on. */
  readonly source: string;
  readonly rule: string;
  /** Its candidate cell [ix, iz] (the rule's grid). */
  readonly cell: readonly [number, number];
  /** Where it stands (world), its turn (quaternion [x, y, z, w]) and its size (the model's times this). */
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  /** A script hid it (it is not drawn and does not collide). */
  readonly hidden: boolean;
}
```

<a id="script-type-spline-pose"></a>
## `SplinePose`

```ts
/** A place on a spline and its cross-section (world metres, unit vectors). */
export interface SplinePose {
  /** Metres along the curve from its start (wrapped on a closed curve, clamped on an open one). */
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** Along the curve. */
  readonly tangent: readonly [number, number, number];
  /** Across to the right, turned by the roll. */
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  /** Metres across, and degrees of roll. */
  readonly width: number;
  readonly roll: number;
}
```

<a id="script-type-spline-nearest-info"></a>
## `SplineNearestInfo`

```ts
/** The nearest place on a spline to a point. */
export interface SplineNearestInfo {
  /** Metres along the curve. */
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** Metres from the point to the curve. */
  readonly offset: number;
}
```

<a id="script-type-surface-info"></a>
## `SurfaceInfo`

```ts
/** The ground at a point as scripts see it. */
export interface SurfaceInfo {
  /** What answered: `'blocks'` (a block layer) or `'terrain'`, and that object's id. */
  readonly source: 'blocks' | 'terrain';
  readonly object: string;
  /** World height of the ground (metres), and the point on it. */
  readonly height: number;
  readonly point: readonly [number, number, number];
  /** Unit normal. */
  readonly normal: readonly [number, number, number];
  /** Degrees from level. */
  readonly slope: number;
  /** The material layers showing there, strongest first, and their weights (0–1, summing to 1). */
  readonly layers: readonly number[];
  readonly weights: readonly number[];
  /** Painted wetness 0–1 (block paint; 0 on terrain). */
  readonly wetness: number;
  /** On a block layer: the cell whose top it is (`ctx.grid.get`/`meta` read it) and its block type. */
  readonly cell?: readonly [number, number, number];
  readonly block?: string;
}
```

<a id="script-type-control-move-intent"></a>
## `ControlMoveIntent`

```ts
/**
 * `−1 ≤ value ≤ 1`, quantized at commit.
 * @graphNode Control move
 * @graphPhase intent
 */
export interface ControlMoveIntent {
  kind: 'control_move';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  value: number;
  /**
   * The move vector's second axis (forward, like a stick pushed up;
   * −1..1) — a 3D character walks along (value, y) as along the move input,
   * relative to the camera. Absent: 0.
   * @graphNode skip the node sets the move along one axis (scripts may pass y)
   */
  y?: number;
}
```

<a id="script-type-control-jump-intent"></a>
## `ControlJumpIntent`

```ts
/**
 * One `JumpPhase` value.
 * @graphNode Control jump
 * @graphPhase intent
 */
export interface ControlJumpIntent {
  kind: 'control_jump';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  value: JumpPhase;
}
```

<a id="script-type-transform-intent"></a>
## `TransformIntent`

```ts
/**
 * A position write on ONE owned entity axis set.
 * It may also set the rotation, as a `quaternion` or a `facing`
 * direction (fields in the order kind, entityId, position, quaternion, facing, up).
 * @graphNode Move object
 * @graphPhase transform
 */
export interface TransformIntent {
  kind: 'transform';
  entityId: string;
  position: { x?: number; y?: number; z?: number };
  /**
   * The rotation as a quaternion [x, y, z, w] (normalized when applied; not all zero).
   * One rotation form per intent.
   * @graphNode skip a quaternion is set by scripts; the node takes angles
   */
  quaternion?: readonly [number, number, number, number];
  /**
   * Turn the entity so its forward axis (+Z, the glTF forward) points along
   * this direction [x, y, z] (not all zero), its top towards `up`. One rotation form per intent.
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  facing?: readonly [number, number, number];
  /**
   * With `facing`, the direction the entity's top (+Y) leans towards
   * (default [0, 1, 0]; must not be parallel to `facing`).
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  up?: readonly [number, number, number];
}
```

<a id="script-type-pose-intent"></a>
## `PoseIntent`

```ts
/**
 * An owned entity's rotation (degrees: yaw about +Y,
 * pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are
 * 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual
 * (colliders keep their shape). Fields in the order kind, entityId,
 * rotation, scale; at least one of rotation and scale.
 * The rotation may instead be a `quaternion` or a `facing`
 * direction (order kind, entityId, rotation, quaternion, facing, up, scale;
 * exactly one of rotation, quaternion and facing when turning).
 * @graphNode Pose object
 * @graphPhase transform
 */
export interface PoseIntent {
  kind: 'pose';
  entityId: string;
  rotation?: { yaw?: number; pitch?: number; roll?: number };
  /**
   * The rotation as a quaternion [x, y, z, w] (normalized when applied; not all zero).
   * One rotation form per intent.
   * @graphNode skip a quaternion is set by scripts; the node takes angles
   */
  quaternion?: readonly [number, number, number, number];
  /**
   * Turn the entity so its forward axis (+Z, the glTF forward) points along
   * this direction [x, y, z] (not all zero), its top towards `up`. One rotation form per intent.
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  facing?: readonly [number, number, number];
  /**
   * With `facing`, the direction the entity's top (+Y) leans towards
   * (default [0, 1, 0]; must not be parallel to `facing`).
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  up?: readonly [number, number, number];
  scale?: number | [number, number, number];
}
```

<a id="script-type-respawn-intent"></a>
## `RespawnIntent`

```ts
/**
 * Kill the player (intent phase; ignored unless the run is playing).
 * @graphNode Respawn player
 * @graphPhase intent
 */
export interface RespawnIntent {
  kind: 'respawn';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
}
```

<a id="script-type-character-move-intent"></a>
## `CharacterMoveIntent`

```ts
/**
 * Walk the player character this step along a
 * world direction on the ground (x, z; a length above 1 counts as 1 — its
 * length scales the walk speed), replacing the move input; `run` uses the run
 * speed. Intent phase.
 * @graphNode Walk character
 * @graphPhase intent
 */
export interface CharacterMoveIntent {
  kind: 'character_move';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  x: number;
  z: number;
  run?: boolean;
}
```

<a id="script-type-character-place-intent"></a>
## `CharacterPlaceIntent`

```ts
/**
 * Teleport the player character (its origin) to a point,
 * stopping its motion; it falls from there. Intent phase; it takes effect
 * before the controller runs in the same step, with the placement of scene
 * arrivals and respawns (from rest: velocity and jump reset); a character
 * on a plane is placed on it.
 * @graphNode Place character
 * @graphPhase intent
 */
export interface CharacterPlaceIntent {
  kind: 'character_place';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  /** Where its origin goes, [x, y, z] (m; on a plane, its coordinate along the plane's normal is the plane's). */
  position: readonly [number, number, number];
  /**
   * The way it faces once placed, in degrees about +Y (0 faces
   * +Z) — what `ctx.physics.characterState().facing` reads, so a saved facing
   * restores. Absent: it keeps facing as it was.
   */
  facing?: number;
}
```

<a id="script-type-character-enable-intent"></a>
## `CharacterEnableIntent`

```ts
/**
 * Switch the character controller off (the
 * character stays where it is: no input, no gravity — a cutscene or a
 * dialogue) or back on. Lasts until changed or
 * the run restarts. Intent phase.
 * @graphNode Enable character
 * @graphPhase intent
 */
export interface CharacterEnableIntent {
  kind: 'character_enable';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  enabled: boolean;
}
```

<a id="script-type-camera-blend-options"></a>
## `CameraBlendOptions`

```ts
/** A blend a script names for the camera change it makes (absent: the camera's own). */
export interface CameraBlendOptions {
  /** `cut`, `linear` or `eased`. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds (0–30). */
  time?: number;
}
```

<a id="script-type-behavior-camera-state"></a>
## `BehaviorCameraState`

```ts
/** A virtual camera's live rig values (`ctx.camera.get`). */
export interface BehaviorCameraState {
  readonly rig: 'follow' | 'orbitPoint' | 'topDown' | 'fixed' | 'rail';
  readonly enabled: boolean;
  readonly priority: number;
  /** It is the live camera. */
  readonly live: boolean;
  /** The target entity ('' for none). */
  readonly target: string;
  readonly distance: number;
  /** Degrees (a snapped rig: the step it turns to). */
  readonly yaw: number;
  readonly pitch: number;
  /** A rail camera's place along its path (0–1). */
  readonly progress: number;
  readonly railSpeed: number;
  readonly fovY: number;
  readonly letterbox: number;
}
```

<a id="script-type-save-meta"></a>
## `SaveMeta`

```ts
/** What a save shows in the slot list (`ctx.saves.save(slot, meta)`). */
export interface SaveMeta {
  /** A title for the slot (up to 128 characters). */
  title?: string;
  /** The chapter (up to 128 characters). */
  chapter?: string;
  /** The location (up to 128 characters). */
  location?: string;
  /** Keep a small picture of the view with the slot. */
  thumbnail?: boolean;
  /** The game's own fields for the slot card (at most 8 names → texts of up to 128 characters), returned by `slots()`. */
  meta?: Readonly<Record<string, string>>;
}
```

<a id="script-type-save-slot-info"></a>
## `SaveSlotInfo`

```ts
/** One used slot as the slot list shows it (`ctx.saves.slots()`). */
export interface SaveSlotInfo {
  /** The slot number (1 – the project's slot count). */
  readonly slot: number;
  /** The texts the game gave when it saved (empty when none). */
  readonly title: string;
  readonly chapter: string;
  readonly location: string;
  /** Play time in seconds when it was saved. */
  readonly playSeconds: number;
  /** When it was saved (ISO 8601, the player's clock). */
  readonly savedAt: string;
  /** The save document's schema version. */
  readonly version: number;
  /** The size of the stored document (bytes of JSON). */
  readonly bytes: number;
  /** Whether the slot has a picture of the view. */
  readonly thumbnail: boolean;
  /** The game's own fields the save gave (`meta`: names → texts within `SAVE_LIMITS.metaBytes`; {} when none). */
  readonly meta: Readonly<Record<string, string>>;
  /** Set when the stored slot cannot be read (it is never loaded). */
  readonly damaged?: string;
}
```

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

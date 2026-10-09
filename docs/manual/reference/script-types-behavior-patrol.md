# Script API types (from `BehaviorPatrol`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-behavior-patrol"></a>
## `BehaviorPatrol`

```ts
/** `ctx.patrol` — objects with a Patrol component. */
export interface BehaviorPatrol {
  /**
   * The way a patroller walks now (a unit vector) and whether it walks at all; null for an object without a patrol.
   * @graphPure
   * @graphNode Patrol state
   * @graphLabel entityId object
   */
  get(entityId: string): { direction: readonly [number, number, number]; active: boolean } | null;
  /**
   * Stop a patroller where it is, or let it walk on. False for an object without a patrol.
   * @graphNode Set patrol active
   * @graphLabel entityId object
   * @graphDefault active true
   */
  setActive(entityId: string, active: boolean): boolean;
  /**
   * Turn a patroller around now (a `turned` event). False for an object without a patrol, or a waypoint loop (it only goes forward).
   * @graphNode Turn patroller
   * @graphLabel entityId object
   */
  turn(entityId: string): boolean;
}
```

<a id="script-type-behavior-hitbox"></a>
## `BehaviorHitbox`

```ts
/** `ctx.hitbox` — objects with a Hitbox component. */
export interface BehaviorHitbox {
  /**
   * Switch a hitbox off (it touches nothing: its contacts end) or on again. False for an object without a hitbox.
   * @graphNode Set hitbox active
   * @graphLabel entityId object
   * @graphDefault active true
   */
  setActive(entityId: string, active: boolean): boolean;
  /**
   * The objects a hitbox (or the character) touches now, sorted by id.
   * @graphPure
   * @graphNode Touching
   * @graphLabel entityId object
   */
  touching(entityId: string): readonly string[];
}
```

<a id="script-type-behavior-collectible"></a>
## `BehaviorCollectible`

```ts
/** `ctx.collectible` — objects with a Collectible component. */
export interface BehaviorCollectible {
  /**
   * Whether a collectible has been collected (and not come back yet).
   * @graphPure
   * @graphNode Is collected
   * @graphLabel entityId object
   */
  collected(entityId: string): boolean;
  /**
   * Bring a collected collectible back now (shown, collectable again; a `restored` event). False when it is not collected.
   * @graphNode Restore collectible
   * @graphLabel entityId object
   */
  restore(entityId: string): boolean;
}
```

<a id="script-type-behavior-character"></a>
## `BehaviorCharacter`

```ts
/** `ctx.character` — the player characters (the objects with a Character controller; several in local co-op). */
export interface BehaviorCharacter {
  /**
   * Add `velocity` [x, y, z] (m/s, each at most 100 either way) to a player character's velocity at its next move (`entityId`, absent: the first player controller) — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without that character or for a bad vector.
   * @graphNode Character impulse
   * @graphLabel velocity velocity
   * @graphLabel entityId player
   */
  impulse(velocity: readonly [number, number, number], entityId?: string): boolean;
}
```

<a id="script-type-behavior-look"></a>
## `BehaviorLook`

```ts
/** `ctx.look` — per-object look overrides the renderer applies (both renderers). */
export interface BehaviorLook {
  /**
   * Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value.
   * @graphNode Set look
   * @graphLabel entityId object
   */
  set(entityId: string, look: BehaviorLookValue): boolean;
  /**
   * Give an object its own look back. False when it had no override.
   * @graphNode Clear look
   * @graphLabel entityId object
   */
  clear(entityId: string): boolean;
  /**
   * The object's look override now, or null when it has none.
   * @graphPure
   * @graphNode Look of
   * @graphLabel entityId object
   */
  get(entityId: string): BehaviorLookValue | null;
}
```

<a id="script-type-behavior-audio"></a>
## `BehaviorAudio`

```ts
/**
 * `ctx.audio`. Playback handles, music control and
 * positional sound — what scripts ask for is simulation state (handles,
 * volumes, fades, finished events replay identically); the page's audio
 * engine plays it.
 */
export interface BehaviorAudio {
  /**
   * Play an audio asset of any length (volume 0–1). Returns its handle (0 when refused: a bad id, more than 32 plays in one step or 64 sounds alive). The sound belongs to the script's object: it stops (fading out over `fadeOut` seconds, 0) when the object leaves the game — its scene unloads or reloads; `owner: 'scene'` ties it to the object's scene instead, `owner: 'none'` to nothing. Options: `loop`, `pitch` (playback rate 0.25–4), `bus` (sfx, music, voice, ui), `fadeIn` seconds; positional with `entityId` (it follows the entity) and/or `position` (world metres, or the offset from the entity), fading by `distanceModel` (linear, inverse, exponential), `refDistance` (2 m), `maxDistance` (30 m) and `rolloff` (1); `maxLateMs` (500): a sound whose file is not ready yet starts when it is, or is dropped once it would start later than this.
   * @graphNode Play sound
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   * @graphDefault volume 1
   */
  play(assetId: string, options?: AudioPlayOptions): number;
  /**
   * Stop a sound, fading out over `fadeSeconds` (0: now). Its finished event (reason "stopped") arrives in the step after the fade ends.
   * @graphNode Stop sound
   * @graphDefault fadeSeconds 0
   */
  stop(handle: number, fadeSeconds?: number): void;
  /**
   * Fade a sound's volume to `to` (0–1) over `seconds` (linear, whole steps).
   * @graphNode Fade sound
   * @graphDefault to 0
   * @graphDefault seconds 1
   */
  fade(handle: number, to: number, seconds: number): void;
  /**
   * Set a sound's volume (0–1) now.
   * @graphNode Set sound volume
   * @graphDefault volume 1
   */
  setVolume(handle: number, volume: number): void;
  /**
   * Set a sound's pitch — its playback rate, 0.25–4 (1: as recorded; it plays faster or slower too).
   * @graphNode Set sound pitch
   * @graphDefault pitch 1
   */
  setPitch(handle: number, pitch: number): void;
  /**
   * Loop a sound or let it end at the end of its clip.
   * @graphNode Set sound loop
   */
  setLoop(handle: number, loop: boolean): void;
  /**
   * Whether a sound is still playing (its finished event has not happened).
   * @graphNode Sound playing
   * @graphPure
   */
  playing(handle: number): boolean;
  /**
   * A sound's volume now (its fade included; 0 when it is not playing).
   * @graphNode Sound volume
   * @graphPure
   */
  volumeOf(handle: number): number;
  /**
   * True in the step after a sound finished (it ended or was stopped).
   * @graphNode Sound finished
   * @graphPure
   */
  finished(handle: number): boolean;
  /**
   * The sounds that finished in the previous step (handle, asset, reason "ended" or "stopped").
   * @graphNode skip a list of records; the Sound finished node checks one handle
   */
  events(): readonly AudioFinishedEvent[];
  /**
   * Play an audio asset as the music track (looped), crossfading over `fadeSeconds` (1); null fades to silence. The scripts then own the music until `releaseMusic`. The track belongs to the script's object (`options.owner`: `scene`, `none`): when that goes, the music is released over the same fade.
   * @graphNode Set music
   * @graphLabel assetId track
   * @graphAsset assetId audio
   * @graphDefault fadeSeconds 1
   */
  music(assetId: string | null, fadeSeconds?: number, options?: AudioMusicOptions): void;
  /**
   * Give the music back to the host (silence: the engine has no level-flow music), crossfading over `fadeSeconds` (1).
   * @graphNode Release music
   * @graphDefault fadeSeconds 1
   */
  releaseMusic(fadeSeconds?: number): void;
  /**
   * Play a stinger (a short musical phrase) once over the music: the track ducks to `duck` (0.3) while it plays and comes back after it, both over `fade` seconds (0.25). Returns its handle.
   * @graphNode Play stinger
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   */
  stinger(assetId: string, options?: AudioStingerOptions): number;
  /**
   * Duck the music to `level` (0–1; 0.3) over `seconds` (0.25) until `unduck`. The deepest duck alive wins (a stinger's, dialogue voice's).
   * @graphNode Duck music
   * @graphDefault level 0.3
   * @graphDefault seconds 0.25
   */
  duck(level: number, seconds?: number): void;
  /**
   * End the script's music duck over `seconds` (0.25).
   * @graphNode Unduck music
   * @graphDefault seconds 0.25
   */
  unduck(seconds?: number): void;
  /**
   * Who picks the music (the scripts or the host), the scripts' track and the duck now.
   * @graphNode Music state
   * @graphPure
   */
  musicState(): AudioMusicState;
  /**
   * Mix a bus (sfx, music, voice, ui) to `volume` (0–1) over `seconds` (0), on top of the player's volume setting.
   * @graphNode Set bus volume
   * @graphDefault volume 1
   * @graphDefault seconds 0
   */
  setBusVolume(bus: 'sfx' | 'music' | 'voice' | 'ui', volume: number, seconds?: number): void;
  /**
   * The scripts' mix of a bus now (1 unless set).
   * @graphNode Bus volume
   * @graphPure
   */
  busVolume(bus: 'sfx' | 'music' | 'voice' | 'ui'): number;
  /**
   * Stop every sound on `bus` (sfx, music, voice, ui; every bus when absent) over `fadeSeconds` (0), whoever started it; on the music bus (or every bus) the scripts' music track is released too. Returns how many sounds it stopped.
   * @graphNode Stop all sounds
   * @graphDefault fadeSeconds 0
   */
  stopAll(bus?: 'sfx' | 'music' | 'voice' | 'ui', fadeSeconds?: number): number;
}
```

<a id="script-type-behavior-effects"></a>
## `BehaviorEffects`

```ts
/** `ctx.effects` — play visual effects (presentation only, never part of the simulation). */
export interface BehaviorEffects {
  /**
   * Play a project effect (particles) once: on `entityId` (it follows the object; `position` is then an offset from it) or, without one, at `position` in world metres. `params` override its public parameters. Returns a handle for `stop`, or 0 when refused (a bad id, more than 32 plays in one step).
   * @graphNode Play effect
   * @graphLabel effectId effect
   */
  play(effectId: string, options?: { position?: readonly number[]; entityId?: string; params?: Readonly<Record<string, number | readonly number[] | string>> }): number;
  /**
   * Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lifetimes.
   * @graphNode Stop effect
   */
  stop(target: number | string): void;
}
```

<a id="script-type-behavior-save"></a>
## `BehaviorSave`

```ts
/** `ctx.save` — values a script keeps in the player's save (≤ 64 keys, ≤ 4 KB each as JSON). */
export interface BehaviorSave {
  /**
   * The value kept under `key` (undefined when there is none).
   * @graphPure
   * @graphNode Saved value
   */
  get(key: string): unknown;
  /**
   * Keep a value under `key`; `false` when it does not fit (a bad key, 64 keys, 4 KB).
   * @graphNode Save value
   */
  set(key: string, value: unknown): boolean;
  /**
   * Forget the value under `key`.
   * @graphNode Remove saved value
   */
  remove(key: string): void;
  /**
   * The keys of the kept values.
   * @graphPure
   * @graphNode Saved keys
   */
  keys(): string[];
}
```

<a id="script-type-behavior-debug"></a>
## `BehaviorDebug`

```ts
/**
 * `ctx.debug` — project debug commands (a test or debug tool, the
 * in-game console and `tl_game_control` run them). A command runs inside the
 * simulation step as part of the step's input, so a recording replays it.
 */
export interface BehaviorDebug {
  /**
   * Declare the debug command `name` (the first declaration fixes its
   * arguments; calling it again every step is how a script listens) and get
   * the calls made to it in this step — in the `intent` phase; the other
   * phases see none. With `handler`, it also runs once per call, right here.
   * Every script instance that declares the command receives each call.
   * Engine limits: 32 commands per game; a second declaration with other
   * arguments throws.
   * @graphNode skip a debug command is declared in code (typed arguments, an optional handler)
   */
  command(name: string, options?: DebugCommandOptions, handler?: (args: DebugCommandArgs) => void): readonly DebugCommandArgs[];
}
```

<a id="script-type-behavior-grid"></a>
## `BehaviorGrid`

```ts
/**
 * `ctx.grid` — the block layers of the loaded scenes. Coordinates are cell
 * indices of a layer (x, y, z); a layer is named by its entity id. Writes
 * change cells, queries, rendering and (in a 3D project) collision within the
 * same step; they are refused (`false`) when a value does not fit (unknown
 * block type or field, a rotation the block does not allow, outside the
 * layer's bounds, a larger block's footprint over other cells) or at the
 * engine limit of 4,096 writes per step.
 */
export interface BehaviorGrid {
  /**
   * The block layers of the loaded scenes (their entity ids, in load order).
   * @graphPure
   * @graphNode Block layers
   */
  layers(): readonly string[];
  /**
   * The cell at [x, y, z] of a layer, or null when it is empty (or no such layer).
   * @graphPure
   * @graphNode Get cell
   */
  get(layer: string, x: number, y: number, z: number): GridCell | null;
  /**
   * Write a cell: a block and/or metadata overrides. False when refused.
   * @graphNode Set cell
   */
  set(layer: string, x: number, y: number, z: number, cell: GridCellInput): boolean;
  /**
   * Empty a cell (its block and metadata). False when refused or already empty.
   * @graphNode Clear cell
   */
  clear(layer: string, x: number, y: number, z: number): boolean;
  /**
   * The highest cell of a column holding a block (its y), or null.
   * @graphPure
   * @graphNode Column top
   */
  columnTop(layer: string, x: number, z: number): number | null;
  /**
   * The ground straight down from a world position: the top of the layer's blocks at or below it (sloped tops, ramps and half blocks included; inside the blocks: the top of the blocks there), with its height, normal, slope and whether it is walkable; null when the column holds no block.
   * @graphPure
   * @graphNode Surface below
   */
  surface(layer: string, position: readonly [number, number, number]): GridSurface | null;
  /**
   * The top surface of a column at its centre (cell x, z): the highest block's top, its height, normal, slope and whether it is walkable; null when the column holds no block.
   * @graphPure
   * @graphNode Column surface
   */
  columnSurface(layer: string, x: number, z: number): GridSurface | null;
  /**
   * The cell holding a world position (it may lie outside the layer's bounds), or null for no such layer.
   * @graphPure
   * @graphNode World to cell
   */
  worldToCell(layer: string, position: readonly [number, number, number]): GridVec3 | null;
  /**
   * The world position of a cell's centre, or null for no such layer.
   * @graphPure
   * @graphNode Cell to world
   */
  cellToWorld(layer: string, x: number, y: number, z: number): GridVec3 | null;
  /**
   * One effective metadata value of a cell (defaults included), or null for an unknown field or layer.
   * @graphPure
   * @graphNode Cell metadata
   */
  meta(layer: string, x: number, y: number, z: number, key: string): number | string | boolean | null;
  /**
   * Set one metadata value of a cell (null removes the override; an empty cell becomes a metadata-only cell). False when refused.
   * @graphNode Set cell metadata
   */
  setMeta(layer: string, x: number, y: number, z: number, key: string, value: number | string | boolean | null): boolean;
  /**
   * The first block cell a ray enters (every layer, or one), with the face it entered through; null when none within maxDistance (default 100 m).
   * @graphPure
   * @graphNode Pick cell
   * @graphDefault direction [0, -1, 0]
   */
  pick(origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance?: number, layer?: string): GridPick | null;
  /**
   * The cells next to [x, y, z] inside the layer's bounds: the 6 face neighbours, or all 26 with diagonal.
   * @graphPure
   * @graphNode Neighbour cells
   */
  neighbours(layer: string, x: number, y: number, z: number, diagonal?: boolean): readonly GridVec3[];
  /**
   * The places one step away from the place a cell names (the top it is, or the top a walker in that cell stands on): to the four neighbouring columns (eight with diagonal), within the step, drop and headroom limits, not across a wall or closed door; each with its cost (metres, times any cost field).
   * @graphPure
   * @graphNode Walk neighbours
   * @graphType cell list
   */
  walkNeighbours(layer: string, cell: readonly number[], options?: GridWalkOptions): readonly GridWalkPlace[];
  /**
   * The cheapest walk between the places two cells name ([x, y, z] each), start and end included, each with the cost so far; null when there is none (or the search passes 65,536 places: `pathOutcome` tells which).
   * @graphPure
   * @graphNode Walk path
   * @graphType from list
   * @graphType to list
   */
  path(layer: string, from: readonly number[], to: readonly number[], options?: GridWalkOptions): readonly GridWalkPlace[] | null;
  /**
   * Why the last `path` call answered as it did: "found"; "none" (no walk joins the two places); "limit" (the search passed 65,536 places first: a path may still exist, e.g. ask for a nearer cell); "invalid" (a layer, cell or option that does not fit, or no place at a cell). Null before the first call.
   * @graphPure
   * @graphNode Walk path outcome
   */
  pathOutcome(): GridWalkPathOutcome | null;
  /**
   * The places reachable from the place a cell names within a cost (metres, times any cost field), cheapest first, the start included (at most 65,536).
   * @graphPure
   * @graphNode Walk reach
   * @graphType from list
   */
  reachable(layer: string, from: readonly number[], maxCost: number, options?: GridWalkOptions): readonly GridWalkPlace[];
  /**
   * The region ids of a layer (each room drawn on it is one too: its outline's id, and "-s1", "-s2"… for its upper storeys).
   * @graphPure
   * @graphNode Regions
   */
  regions(layer: string): readonly string[];
  /**
   * The cells of a named region (at most 65,536), or null when the layer has no such region.
   * @graphPure
   * @graphNode Region cells
   */
  region(layer: string, regionId: string): readonly GridVec3[] | null;
  /**
   * Whether a cell lies in a named region.
   * @graphPure
   * @graphNode In region
   */
  inRegion(layer: string, regionId: string, x: number, y: number, z: number): boolean;
  /**
   * Swap the materials a block type wears in every layer (`{slot: materialId}`, a slot of its look or "*"; `null` puts a slot back to the type's own). It is part of the simulation at once; the cells show it once the material has loaded. False when refused (an unknown block type or a material this game does not ship).
   * @graphNode skip a slot map is written by scripts and timelines
   */
  setTypeMaterials(blockId: string, materials: Readonly<Record<string, string | null>>): boolean;
  /**
   * The materials a block type wears now (its own mapping with the swaps over it), or null (an unknown type, or no project materials).
   * @graphNode skip a slot map is read by scripts
   */
  typeMaterials(blockId: string): Readonly<Record<string, string>> | null;
  /**
   * Force a cut-away zone of a layer hidden (true) or shown (false) whatever the subject does, or give it back to the subject (null). A zone is a region the layer's cutaway lists, or "#<row>" for one of its height planes. Drawing only (it fades like any cut-away). False when refused (an unknown layer or zone).
   * @graphNode Set cut-away
   */
  setCutaway(layer: string, zone: string, cut: boolean | null): boolean;
  /**
   * The object whose position decides the layers' cut-aways (what is cut while it stands under or inside it), or null for the camera's target (the default). False when the id is not a string.
   * @graphNode Set cut-away subject
   * @graphLabel targetId target
   */
  setCutawaySubject(targetId: string | null): boolean;
  /**
   * A world point [x, y, z] that decides the layers' cut-aways in place of an object. False when it is not three finite numbers.
   * @graphNode Set cut-away point
   */
  setCutawayPoint(point: readonly number[]): boolean;
  /**
   * Show a kit over a layer (no region) or one of its regions: its block types are drawn, collide and spawn as each type's swap under the kit, without changing the cells (a dungeon burnt in place). Null shows no kit there (the authored one included); the layer re-meshes in the background, the old look drawn until the new is ready. False when refused (an unknown layer, kit or region). Saved with the grid.
   */
  setKit(layer: string, kit: string | null, region?: string): boolean;
  /**
   * The kit a layer (no region) or one of its regions shows now (null: none).
   * @graphPure
   */
  kit(layer: string, region?: string): string | null;
  /**
   * Restyle generated architecture: every outline styled by preset `from` is made by preset `to` instead (its style, values and trim sheet), in every loaded and later loaded scene, without touching the outlines; null puts `from` back. The page makes the changed chunks in the background, the old ones drawn until the new are in, and the colliders follow. False when refused (not preset ids, `to` not a preset of the game). Saved with the grid.
   * @graphNode Set architecture preset
   */
  setArchitecturePreset(from: string, to: string | null): boolean;
  /**
   * The preset shown in place of `from` now (null: `from` itself).
   * @graphPure
   * @graphNode Architecture preset
   */
  architecturePreset(from: string): string | null;
  /**
   * The doors of the loaded buildings whose interiors are scenes of their own, from each side that is loaded: the door's place, where one arriving through it stands and the way out there (degrees, as `character_place`'s facing), and the same of the other side with its scene. Using a door is the game's: e.g. `ctx.scenes.load(link.to.scene, { unload: [link.scene] })`, then placing its player at `link.to.spawn` once that scene is loaded.
   * @graphPure
   * @graphNode skip a list of objects; scripts walk it, graphs use Door link near
   */
  doorLinks(): readonly GridDoorLink[];
  /**
   * The linked door nearest a world point within `reach` metres (absent: 2) on the ground, or null.
   * @graphPure
   * @graphNode Door link near
   * @graphDefault reach 2
   */
  doorLink(point: readonly number[], reach?: number): GridDoorLink | null;
  /**
   * The edge piece on a side of a cell (a wall, door or fence between it and its neighbour), or null when none stands there.
   * @graphPure
   * @graphNode Get edge
   */
  edge(layer: string, x: number, y: number, z: number, side: '-x' | '+x' | '-z' | '+z'): GridEdge | null;
  /**
   * Whether an edge piece blocks moving from a cell across one of its sides (a wall or a closed door does; an open door, a non-blocking piece or no piece does not). Where no piece stands, a room's wall drawn on the layer blocks (its doorways and windows do not).
   * @graphPure
   * @graphNode Edge blocked
   */
  blocked(layer: string, x: number, y: number, z: number, side: '-x' | '+x' | '-z' | '+z'): boolean;
  /**
   * Put an edge piece on a side of a cell. False when refused (not an edge block type, outside the bounds, a rotation other than 0 or 180).
   * @graphNode Set edge
   */
  setEdge(layer: string, x: number, y: number, z: number, side: '-x' | '+x' | '-z' | '+z', edge: GridEdgeInput): boolean;
  /**
   * Remove the edge piece on a side of a cell. False when refused or none stands there.
   * @graphNode Clear edge
   */
  clearEdge(layer: string, x: number, y: number, z: number, side: '-x' | '+x' | '-z' | '+z'): boolean;
  /**
   * Open or close the edge piece on a side of a cell (a door): open, it blocks no passage and has no collider. False when none stands there or it already is.
   * @graphNode Open edge
   */
  setEdgeOpen(layer: string, x: number, y: number, z: number, side: '-x' | '+x' | '-z' | '+z', open: boolean): boolean;
  /**
   * The id of the object a live edge piece spawns (its prefab's root), or null when the edge shows no live piece.
   * @graphPure
   * @graphNode Edge object
   */
  edgeEntity(layer: string, x: number, y: number, z: number, side: '-x' | '+x' | '-z' | '+z'): string | null;
  /**
   * The id of the object a live block's cell spawns (its prefab's root; a cell a larger block covers names the block's), or null when the cell shows no live block. The id is the cell's from the write on; the object is in the game from the end of the step that wrote the cell.
   * @graphPure
   * @graphNode Cell object
   */
  entity(layer: string, x: number, y: number, z: number): string | null;
  /**
   * The cell a live block's object belongs to (its root or any of its children; the block's anchor cell; for a live edge piece the cell whose side it stands on, with that side), or null for any other object.
   * @graphPure
   * @graphNode Object cell
   */
  cellOf(entityId: string): (GridVec3 & { readonly layer: string; readonly side?: '-x' | '-z' }) | null;
  /**
   * The cells scripts wrote in the previous step, in write order.
   * @graphNode skip scripts read the list with a loop
   */
  changes(): readonly GridChange[];
  /**
   * The cells changed since the run started, as plain data for a save.
   * @graphNode skip saves store it as data
   */
  diff(): GridDiff;
  /**
   * Re-apply a saved diff (after loading a save). False when it does not fit the loaded layers.
   * @graphNode skip saves store it as data
   */
  applyDiff(diff: GridDiff): boolean;
}
```

<a id="script-type-behavior-scatter"></a>
## `BehaviorScatter`

```ts
/**
 * Rule scatter's stored copies — trees, rocks, anything the terrains' and
 * block layers' scatter rules placed — found by place and named by address
 * (a copy's object, rule and cell: `"<object>#scatter:<rule>:<ix>,<iz>"`,
 * the same through every bake that keeps it). A hidden copy is not drawn and
 * does not collide until shown again; a removed one is gone for the run. A
 * new run brings every copy back; a save keeps what `changed()` lists and
 * puts it back with `hide` and `remove`.
 */
export interface BehaviorScatter {
  /**
   * The copies standing within `radius` metres of a world position (measured across the ground, x and z), nearest first: of one rule or object only, hidden ones too (`hidden: true`), at most `limit` (default 64, at most 1,024).
   * @graphPure
   * @graphNode Scatter copies near
   * @graphDefault radius 10
   */
  near(position: readonly [number, number, number], radius: number, options?: { rule?: string; source?: string; hidden?: boolean; limit?: number }): readonly ScatterCopyInfo[];
  /**
   * The copy at an address (hidden ones too), or null when there is none or it was removed.
   * @graphPure
   * @graphNode Scatter copy
   */
  get(address: string): ScatterCopyInfo | null;
  /**
   * Hide a copy: it is not drawn and does not collide until shown again. False when there is no such copy or it is hidden already.
   * @graphNode Hide scatter copy
   */
  hide(address: string): boolean;
  /**
   * Show a hidden copy again. False when it is not hidden.
   * @graphNode Show scatter copy
   */
  show(address: string): boolean;
  /**
   * Remove a copy for the rest of the run (not drawn, no collider). False when there is no such copy (or it is gone already).
   * @graphNode Remove scatter copy
   */
  remove(address: string): boolean;
  /**
   * The copies scripts hid or removed this run (for a save: put them back with `hide` and `remove`).
   * @graphNode skip saves store it as data
   */
  changed(): readonly { readonly address: string; readonly state: 'hidden' | 'removed' }[];
}
```

<a id="script-type-behavior-splines"></a>
## `BehaviorSplines`

```ts
/**
 * The splines of the loaded scenes (objects carrying `spline`), in the world
 * as their objects were placed.
 */
export interface BehaviorSplines {
  /**
   * Metres along an object's spline (null when the object carries none or is not loaded).
   * @graphPure
   * @graphNode Spline length
   */
  length(entityId: string): number | null;
  /**
   * The place and cross-section `distance` metres along an object's spline (clamped to its ends; a closed one wraps), or null without one.
   * @graphPure
   * @graphNode Spline point at
   */
  at(entityId: string, distance: number): SplinePose | null;
  /**
   * The nearest place on an object's spline to a world position (`level`: measured across the ground, x and z only), or null without one.
   * @graphPure
   * @graphNode Nearest on spline
   */
  nearest(entityId: string, position: readonly [number, number, number], options?: { level?: boolean }): SplineNearestInfo | null;
}
```

<a id="script-type-behavior-surface"></a>
## `BehaviorSurface`

```ts
/**
 * The ground of the loaded scenes' block layers and terrains, whichever is
 * there (the highest ground at or below the point; a block layer on a tie).
 */
export interface BehaviorSurface {
  /**
   * The ground at or below a world position (a point inside blocks gives their top), or null where no block layer or loaded terrain tile has ground (a hole, off the level).
   * @graphPure
   * @graphNode Surface at
   */
  at(position: readonly [number, number, number]): SurfaceInfo | null;
  /**
   * The highest ground at world x, z, or null where there is none.
   * @graphPure
   * @graphNode Top surface
   */
  top(x: number, z: number): SurfaceInfo | null;
}
```

<a id="script-type-behavior-intent"></a>
## `BehaviorIntent`

```ts
export type BehaviorIntent = ControlMoveIntent | ControlJumpIntent | TransformIntent | PoseIntent | RespawnIntent | CharacterMoveIntent | CharacterPlaceIntent | CharacterEnableIntent;
```

<a id="script-type-behavior-log-level"></a>
## `BehaviorLogLevel`

```ts
/** The `ctx.log` levels. */
export type BehaviorLogLevel = 'info' | 'warn' | 'error';
```

<a id="script-type-behavior-camera"></a>
## `BehaviorCamera`

```ts
/**
 * `ctx.camera` — the virtual cameras (the `virtualCamera`
 * component): which is live, their rig values, shake and screen↔world
 * projection. Changes take effect at the end of the step (the camera brain
 * resolves the live camera after every script has run); reads and the
 * projection use the camera as resolved at the end of the previous step.
 * The projection uses normalized screen coordinates — x 0 (left) to 1
 * (right), y 0 (top) to 1 (bottom) — and the viewport aspect the host
 * reports.
 */
export interface BehaviorCamera {
  /**
   * Enable a virtual camera and bring it in front of the cameras of its priority (it goes live unless a higher priority is enabled). `false` when there is no such camera.
   * @graphNode Activate camera
   * @graphLabel cameraId camera
   */
  activate(cameraId: string, options?: CameraBlendOptions): boolean;
  /**
   * Disable a virtual camera (the view blends to the next one, or to the default pose when none is left).
   * @graphNode Deactivate camera
   * @graphLabel cameraId camera
   */
  deactivate(cameraId: string, options?: CameraBlendOptions): boolean;
  /**
   * Set a camera's priority (−1000–1000; the enabled camera with the highest is live).
   * @graphNode Set camera priority
   * @graphLabel cameraId camera
   */
  setPriority(cameraId: string, priority: number): boolean;
  /**
   * Point a camera at another target entity ('' for none).
   * @graphNode Set camera target
   * @graphLabel cameraId camera
   * @graphLabel entityId target
   */
  setTarget(cameraId: string, entityId: string): boolean;
  /**
   * Set a camera's rig values (each optional): distance, yaw, pitch (kept within its pitch limits), progress and railSpeed of a rail camera, field of view, letterbox, the orbit point, the target offset.
   * @graphNode Set camera rig
   * @graphLabel cameraId camera
   */
  set(
    cameraId: string,
    params: {
      distance?: number;
      yaw?: number;
      pitch?: number;
      progress?: number;
      railSpeed?: number;
      fovY?: number;
      letterbox?: number;
      point?: readonly number[];
      targetOffset?: readonly number[];
    },
  ): boolean;
  /**
   * Turn a camera by whole steps (an orbit-a-point camera: its turn step; positive turns left).
   * @graphNode Turn camera
   * @graphLabel cameraId camera
   * @graphDefault steps 1
   */
  turn(cameraId: string, steps: number): boolean;
  /**
   * Shake the view: up to `amplitude` metres (and `rotation` degrees), `frequency` times a second (default 8), fading out over `seconds`. Seeded: the same run shakes the same way (`seed` picks another pattern).
   * @graphNode Shake camera
   * @graphDefault amplitude 0.2
   * @graphDefault seconds 0.5
   * @graphDefault frequency 8
   * @graphDefault rotation 0
   * @graphDefault seed 0
   */
  shake(amplitude: number, seconds: number, frequency?: number, rotation?: number, seed?: number): void;
  /**
   * The live virtual camera, or null while none is (the view holds the default pose).
   * @graphPure
   * @graphNode Live camera
   */
  live(): string | null;
  /**
   * A blend between two cameras is in progress.
   * @graphPure
   * @graphNode Camera blending
   */
  blending(): boolean;
  /**
   * A virtual camera's live rig values, or null when there is no such camera.
   * @graphPure
   * @graphNode Camera state
   * @graphLabel cameraId camera
   */
  get(cameraId: string): BehaviorCameraState | null;
  /**
   * Where a world point appears on screen (x, y 0–1 from the top left), how far in front of the camera it is, and whether it is in view.
   * @graphPure
   * @graphNode World to screen
   */
  worldToScreen(position: readonly number[]): { x: number; y: number; depth: number; onScreen: boolean };
  /**
   * The ray from the camera through a screen point (x, y 0–1 from the top left): its origin and unit direction.
   * @graphPure
   * @graphNode Screen to ray
   * @graphDefault x 0.5
   * @graphDefault y 0.5
   */
  screenToRay(x: number, y: number): { origin: readonly [number, number, number]; direction: readonly [number, number, number] };
}
```

<a id="script-type-behavior-sockets"></a>
## `BehaviorSockets`

```ts
/**
 * `ctx.sockets` — objects riding on named nodes (bones or any
 * node) of other objects' models. The simulation places an attached object
 * at the end of every step, after the animators, so it follows the target's
 * animation in Play, the worker and the export alike.
 */
export interface BehaviorSockets {
  /**
   * Attach an object to a node of the target's model, with an optional offset in the node's space (position [x, y, z], rotation quaternion [x, y, z, w], scale [x, y, z]). Without a target the object's own Socket component is used. False (and a warning in the play log) when refused: an unknown object, target or node, a loop, or a physics body.
   * @graphNode Attach to socket
   * @graphLabel entityId object
   * @graphLabel targetId target
   * @graphLabel node node
   */
  attach(entityId: string, targetId?: string, node?: string, position?: readonly number[], rotation?: readonly number[], scale?: readonly number[]): boolean;
  /**
   * Detach an object from its socket: it stays where the node left it (keepWorld, the default) or snaps back to its transform from before the attach. False when it was not attached.
   * @graphNode Detach from socket
   * @graphLabel entityId object
   * @graphDefault keepWorld true
   */
  detach(entityId: string, keepWorld?: boolean): boolean;
  /**
   * The socket an object rides on (the target object and the node's name), or null.
   * @graphPure
   * @graphNode Socket of
   * @graphLabel entityId object
   */
  attachedTo(entityId: string): { readonly target: string; readonly nodeName: string } | null;
  /**
   * A node's world position and rotation now (the target's model posed by its animator), or null when the target, its model or the node is missing — e.g. where a muzzle or a hand is.
   * @graphPure
   * @graphNode Node pose
   * @graphLabel targetId target
   * @graphLabel node node
   */
  nodePose(targetId: string, node: string): { readonly position: readonly [number, number, number]; readonly rotation: readonly [number, number, number, number] } | null;
}
```

<a id="script-type-behavior-materials"></a>
## `BehaviorMaterials`

```ts
/**
 * `ctx.materials` — graph-material parameters per object while the game runs.
 * `param` is a parameter key of the object's graph materials (public ones
 * only); `materialId` limits a call to one of its materials. Writes are
 * refused (`false`) for an object that wears no graph material with that
 * parameter, a value that does not fit the parameter (type, range, a texture
 * outside the game), or at the engine limit of 4,096 writes per step.
 */
export interface BehaviorMaterials {
  /**
   * Set a parameter on one object: a number (float), 2–4 numbers (vec2–4), "#rrggbb" (colour) or a texture asset id of the game ("" for none). Other objects wearing the material keep their values. False when refused.
   * @graphNode Set material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  set(entityId: string, param: string, value: unknown, materialId?: string): boolean;
  /**
   * A parameter's value on an object now: what a script set, else the object's authored override, else the material's default (null: no such parameter, or a data parameter).
   * @graphPure
   * @graphNode Material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  get(entityId: string, param: string, materialId?: string): unknown;
  /**
   * Put a parameter (or, without one, every parameter scripts set) of an object back to its authored value; a data parameter back to its starting cells.
   * @graphNode Reset material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  reset(entityId: string, param?: string, materialId?: string): boolean;
  /**
   * Write a rectangle of cells of a data parameter: x, y, width, height in cells (cell [0, 0] sits at UV (0, 0)); bytes = RGBA 0–255 per cell, row by row from y (width × height × 4 numbers). False when refused (outside the grid, wrong length).
   * @graphNode Write material data
   * @graphLabel param parameter
   * @graphLabel materialId material
   * @graphDefault w 1
   * @graphDefault h 1
   * @graphType bytes list
   */
  setData(entityId: string, param: string, x: number, y: number, w: number, h: number, bytes: readonly number[], materialId?: string): boolean;
  /**
   * One cell of a data parameter on an object as [r, g, b, a] (0–255), or null (no such parameter or cell).
   * @graphPure
   * @graphNode Material data cell
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  getData(entityId: string, param: string, x: number, y: number, materialId?: string): number[] | null;
}
```

<a id="script-type-behavior-saves"></a>
## `BehaviorSaves`

```ts
/**
 * `ctx.saves` — the project's save document and its slots, and the project
 * settings document. Requires a save schema in the project (Project → Saves);
 * without one every call answers false / empty.
 */
export interface BehaviorSaves {
  /**
   * The save document's schema version (0: the project declares no save schema).
   * @graphPure
   * @graphNode Save version
   */
  readonly version: number;
  /**
   * How many slots the game offers.
   * @graphPure
   * @graphNode Save slot count
   */
  readonly slotCount: number;
  /**
   * Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.
   * @graphNode Write save document
   */
  write(doc: unknown): boolean;
  /**
   * The project's save document (a copy; null before one is written or loaded).
   * @graphPure
   * @graphNode Save document
   */
  read(): unknown;
  /**
   * Save to a slot at the end of this step (the document and the engine sections of the schema);
   * the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (names → texts; the record at most 4 KiB as JSON).
   * False for a slot the game does not have or a meta that does not fit.
   * @graphNode Save to slot
   */
  save(slot: number, meta?: SaveMeta): boolean;
  /**
   * Load a slot: when storage answers, the document is migrated and restored at the end of that step
   * (the outcome in `results()`).
   * @graphNode Load slot
   */
  load(slot: number): boolean;
  /**
   * Delete a slot (the outcome in `results()`).
   * @graphNode Delete slot
   */
  delete(slot: number): boolean;
  /**
   * The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).
   * @graphPure
   * @graphNode Save slots
   */
  slots(): readonly SaveSlotInfo[];
  /**
   * Whether the slot list has arrived from storage (it is empty before).
   * @graphPure
   * @graphNode Save slots ready
   */
  ready(): boolean;
  /**
   * The outcomes that arrived this step (saves, loads and deletes).
   * @graphPure
   * @graphNode Save results
   */
  results(): readonly SaveResult[];
  /**
   * The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for
   * at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.
   * @graphPure
   * @graphNode Save storage
   */
  storage(): SaveStorageInfo;
  /**
   * Play time in seconds (restored with a loaded save).
   * @graphPure
   * @graphNode Play time
   */
  playSeconds(): number;
  /**
   * Register the migration a save schema names: `migrate(doc, fromVersion)` returns the document one
   * version later. Call it every step (or once at the start); the last registration counts.
   * @graphNode skip a migration is a function (code)
   */
  migration(name: string, migrate: (doc: unknown, fromVersion: number) => unknown): boolean;
  /**
   * A value of the project settings document (its default until the player changes it).
   * @graphPure
   * @graphNode Setting
   */
  setting(key: string): boolean | number | string | null;
  /**
   * The whole project settings document (a copy).
   * @graphPure
   * @graphNode Settings document
   */
  settings(): Record<string, boolean | number | string>;
  /**
   * Change a value of the project settings document (kept in the player's browser; an engine setting
   * it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.
   * @graphNode Set setting
   */
  setSetting(key: string, value: boolean | number | string): boolean;
}
```

<a id="script-type-behavior-assets"></a>
## `BehaviorAssets`

```ts
/**
 * `ctx.assets` — load assets by id, address or label and let them go.
 * A load answers at once with a handle; the assets arrive while the game
 * plays (the simulation never waits) and the handle's state says when they
 * are ready. Release every handle you load: what it holds stays in memory
 * until then.
 */
export interface BehaviorAssets {
  /**
   * Start loading the asset or resource with this id or address, or every one with this label.
   * Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading'
   * until the assets are ready, a later step.
   * @graphNode Load assets
   * @graphLabel key id, address or label
   */
  load(key: string): number;
  /**
   * Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
   * @graphNode Release assets
   */
  release(handle: number): boolean;
  /**
   * A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
   * @graphPure
   * @graphNode Assets state
   */
  state(handle: number): AssetHandleState | null;
  /**
   * True once a handle's assets are loaded.
   * @graphPure
   * @graphNode Assets ready
   */
  ready(handle: number): boolean;
  /**
   * The ids a ready handle loaded (the assets and resources its key named, in id order); empty otherwise.
   * @graphNode skip a list of ids; read a known id with Assets ready
   */
  ids(handle: number): readonly string[];
  /**
   * Why a failed handle failed ('' otherwise).
   * @graphPure
   * @graphNode Assets error
   */
  error(handle: number): string;
}
```

<a id="script-type-behavior-ui"></a>
## `BehaviorUi`

```ts
export interface BehaviorUi {
  /**
   * Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
   * @graphNode Set UI value
   */
  set(path: string, value: unknown): boolean;
  /**
   * The published value at a path (null when there is none).
   * @graphPure
   * @graphNode UI value
   */
  get(path: string): unknown;
  /**
   * Remove a path from the view model (`false` when it was not there).
   * @graphNode Clear UI value
   */
  clear(path: string): boolean;
  /**
   * Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
   * @graphNode Show UI
   * @graphLabel docId document
   */
  show(docId: string, options?: { layer?: number; modal?: boolean }): boolean;
  /**
   * Hide a shown UI document (`false` when it was not shown).
   * @graphNode Hide UI
   * @graphLabel docId document
   */
  hide(docId: string): boolean;
  /**
   * The document is shown.
   * @graphPure
   * @graphNode UI shown
   * @graphLabel docId document
   */
  isShown(docId: string): boolean;
  /**
   * Play a tween of a document (on a widget, or the whole document). Presentation only.
   * @graphNode Play UI tween
   * @graphLabel docId document
   */
  play(docId: string, tween: string, widgetId?: string): boolean;
  /**
   * Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.
   * @graphNode Focus UI widget
   * @graphLabel docId document
   * @graphLabel widgetId widget
   * @graphLabel index list item
   */
  focus(docId: string, widgetId: string, index?: number): boolean;
  /**
   * The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.
   * @graphPure
   * @graphNode UI view
   */
  view(): BehaviorUiView;
  /**
   * The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
   * @graphPure
   * @graphNode UI events
   */
  events(): readonly BehaviorUiEvent[];
  /**
   * The first UI event of this step with this name (a button's or an input's event), or null.
   * @graphPure
   * @graphNode UI event
   */
  event(name: string): BehaviorUiEvent | null;
}
```

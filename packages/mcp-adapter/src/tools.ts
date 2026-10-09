/**
 * The MCP tool surface (charter). Six categories,
 * exposed as MCP tools and routed into the backend's `/api/v1` command/query/
 * play services via `BackendClient` (never a second mutation engine).
 *
 * - bounded project/entity inspection → `tl_inspect`
 * - command submission                → `tl_command`
 * - session listing                   → `tl_sessions`
 * - play start/stop                   → `tl_play_start`, `tl_play_stop`
 * - bounded diagnostics               → `tl_diagnostics`
 * - screenshot (selected browser)     → `tl_screenshot`
 *
 * Responses carry the relevant revision/session IDs, surface the backend's
 * structured errors (code + message + fields such as `currentRevision`), and
 * are bounded by the backend's own payload limits (queries paged/counts-only,
 * screenshot ≤ 1 MiB, diagnostics ≤ 16 KiB). No general eval/shell tool.
 *
 * Pure Node (no `node:` imports): arg validation is manual; the input schemas
 * are plain JSON Schema objects advertised via `tools/list`.
 */

import { BackendClient, makeRequestId } from './backend-client';
import { playtestBackend, runPlaytest, type PlaytestSpec } from './playtest';
import {
  CONTENT_ASSETS_LIMIT_DEFAULT,
  CONTENT_ASSETS_LIMIT_MAX,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  GAME_CONTROL_COMMANDS,
  GAME_OBSERVATION_MAX_BYTES,
  GAME_OBSERVE_TIMEOUT_MAX_MS,
  GAME_OBSERVE_TIMEOUT_MIN_MS,
  INPUT_RELAY_MAX_BODY_BYTES,
  INPUT_RELAY_MAX_FRAMES,
  INPUT_RELAY_MAX_STEPS,
  INSTANCE_BUFFER_INLINE_MAX,
  PLAY_START_VARIABLES_MAX,
  PLAY_START_VARIABLE_MAX_CHARS,
  RELAY_GAMEPAD_AXES,
  RELAY_GAMEPAD_BUTTONS,
  RELAY_MAX_UI_EDGES,
  RELAY_UI_EDGES,
  SCREENSHOT_DATA_URL_MAX,
  SCREENSHOT_MAX_WIDTH_MAX,
  SCREENSHOT_MAX_WIDTH_MIN,
  SIGNAL_DEBUG_COMMAND_NAME,
  parseRelayGamepad,
  parseRelayUiEdges,
  relayFrameEnd,
  V3_MUTATION_OPS,
  RESOURCE_CREATING_OPS,
} from '@thirdlight/protocol';
import {
  AMBIENT_OCCLUSION_KINDS,
  AUDIO_VOICE_CAP,
  AUDIO_VOICES_DEFAULT,
  EROSION_MAX_SAMPLES,
  INSTANCE_DENSITY_END_DEFAULT,
  INSTANCE_DENSITY_MIN_DEFAULT,
  INSTANCE_DENSITY_MIN_NEW,
  INSTANCE_DENSITY_START_DEFAULT,
  LOD_BIAS_DEFAULT,
  LOD_BIAS_MAX,
  LOD_BIAS_MIN,
  LOD_HYSTERESIS_DEFAULT,
  LOD_HYSTERESIS_MAX,
  LOD_SCREEN_SIZES_DEFAULT,
  MESH_LOD_RATIOS_DEFAULT,
  MSAA_SAMPLE_COUNTS,
  PIXEL_RATIO_CAP_MAX,
  PIXEL_RATIO_CAP_MIN,
  RENDER_SCALE_MAX,
  RENDER_SCALE_MIN,
  SHADOW_MAP_SIZES,
  SKY_ROTATION_MAX,
  BEHAVIOR_GRAPH_LIMITS,
  EFFECT_LIMITS,
  GRAPH_LIMITS,
  INSTANCE_FLOATS,
  MATERIAL_DATA_MAX,
  INSTANCES_LOCAL_LIGHTS_DEFAULT,
  LIGHT_IMPORTANCES,
  LIGHT_LAYER_COUNT,
  LIGHT_LAYERS_ALL,
  LOCAL_LIGHT_MODES,
  MAX_COLLISION_LAYERS,
  MAX_LIGHT_LAYER_NAME,
  MAX_LOCAL_LIGHTS,
  MAX_MATERIAL_INSTANCE_DEPTH,
  MAX_TAGS,
  MODE_LIMITS,
  PAINT_BRUSH_LIMITS,
  SAVE_LIMITS,
  SCRIPT_LIBRARY_LIMITS,
  SCULPT_LIMITS,
  INSTANCE_BRUSH_LIMITS,
  TERRAIN_BRUSH_LIMITS,
  INSTANCE_BRUSH_REACH,
  TEXTURE_BUDGET_DEFAULT_MB,
  STREAMING_BUDGET_DEFAULT_MB,
  STREAMING_BUDGET_MAX_MB,
  STREAMING_BUDGET_MIN_MB,
  TEXTURE_BUDGET_MAX_MB,
  TEXTURE_BUDGET_MIN_MB,
  TIMELINE_LIMITS,
  UI_LIMITS,
} from '@thirdlight/project-model/limits';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpContext {
  readonly client: BackendClient;
  readonly projectId: string;
  /** The `origin.clientId` recorded on MCP-submitted commands. */
  readonly clientId: string;
}

export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The core scene command ops. */
const M1_MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'] as const;
/** The content/property/prefab mutation ops. */
const M2_MUTATION_OPS = [
  'publishAsset',
  'publishBehavior',
  'setBehaviorProperties',
  'setComponent',
  'setSettings',
  'acknowledgeBehaviorTrust',
  'createPrefab',
  'instantiatePrefab',
] as const;
/** The v3 game/presentation mutation ops. */
// The v3 op list is the protocol's (one list; a new op reaches MCP with it).
const M3_MUTATION_OPS = V3_MUTATION_OPS;
const MUTATION_OPS = [...M1_MUTATION_OPS, ...M2_MUTATION_OPS, ...M3_MUTATION_OPS] as const;
const QUERY_OPS = ['queryProject', 'queryEntity', 'queryEntities', 'queryAssets', 'queryPrefabs', 'queryBehaviors'] as const;
/**
 * The tool's commands: the relay's closed set plus `signal`, which the tool
 * sends as the engine's `signal` debug command (input of the next step, so a
 * recording replays it).
 */
const TOOL_CONTROL_COMMANDS = [...GAME_CONTROL_COMMANDS, SIGNAL_DEBUG_COMMAND_NAME] as const;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The advertised tools (plain JSON Schema input schemas — no zod). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'tl_inspect',
    description:
      'Bounded, read-only inspection of the project. target="project" returns counts and IDs only; ' +
      'target="entity" returns one entity (plus subtree only if includeSubtree=true); ' +
      'target="entities" returns a paged list (limit ≤ 1024, default 100; sceneId limits it to one scene, and ' +
      'each page names every entity\'s scene in entitySceneIds); ' +
      'target="selection" returns the entities selected in the connected editor. ' +
      'target="engine" returns the engine the backend runs: version, commit and lockfileDigest (as it started), build (dist/build-info.json at start: builtAt, commit, dirty), ' +
      'startedAt, dist {build (now), newerThanProcess, reason} - newerThanProcess true: dist/ was rebuilt after the backend started, so the pages load the newer bundles while the backend still runs the old one until restarted - and checkoutCommit when the checkout moved on. A project has one or more scenes ' +
      '(one file each; target="project" lists scenes and startScenes, with environments=true each scene\'s look; target="entity" names its sceneId). Never mutates.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['project', 'entity', 'entities', 'selection', 'engine'] },
        entityId: { type: 'string' },
        includeSubtree: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1024 },
        offset: { type: 'integer', minimum: 0 },
        sceneId: { type: 'string', description: 'target="entities": only this scene' },
        environments: { type: 'boolean', description: 'target="project": each scene row carries its look (sky, fog, post, wind) when it has one' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_command',
    description:
      'Submit one undoable editing command to the project, with optimistic concurrency ' +
      '(expectedRevision). Scene ops: createEntity (kind group|box|model|folder), setTransform, ' +
      'updateEntity (rename/reparent/flags/tags: {entityId, name?, parentId?, active?, visible?, locked?, static?, tags?: [tag names]}; visible false: the game starts the object hidden (drawn once a script\'s setVisible / entity().set or a timeline activation key shows it; it still simulates, unlike active false; not on folders); a reparent keeps ' +
      'the world position), moveEntities (file entities with their subtrees, keeping world positions: ' +
      '{entityIds, parentId|null, beforeId?, sceneId? (into another scene: ids and references kept, one undo)}), deleteEntity, undo, redo. A folder has no transform and sits at the ' +
      'root or in another folder; folders pass active/locked/static and their tags down to their subtree. ' +
      `Tags: setTags {tags: [{bit?, name}]} replaces the project tag registry (up to ${MAX_TAGS}; a rename keeps the bit, a new ` +
      'name gets the lowest free bit, a tag still carried by an entity cannot be removed); the registry is in ' +
      'tl_inspect target="project" (tags) and each entity shows its own and effective tag names. Content ops: publishAsset, publishBehavior, ' +
      'setBehaviorProperties, setComponent {entityId, component, value} (a partial value: each top-level field present replaces that ' +
      'field, null removes an optional one; on an object without the component a complete value adds it; value null removes the ' +
      'component — every owned component, box/camera/model included; model {piece: name|null} changes the piece), setSettings, acknowledgeBehaviorTrust, createPrefab, ' +
      'instantiatePrefab. Script properties: publishBehavior {behaviorId, displayName, mode: declaration-create|declaration-update, declaration: {properties: [{key, label, ' +
      'type: number|boolean|string|enum|vec3|entityRef|assetRef, default, min?, max?, step?, maxLength?, values? (enum), bounds? (vec3), visibility?: public|private (default public), ' +
      'group?, header?, tooltip?}]}}; public properties are shown in the Inspector of every object with the script and set per object with setBehaviorProperties ' +
      '{entityId, behaviorId, values}; private ones are not shown and not settable (property_private): the script always reads the default. A script may declare ' +
      'its properties in its src/index.ts instead (export const properties = {speed: property.number(3, {min: 0, group: "Movement"}), secret: property.private.number(1)}): ' +
      'the compiler derives the declaration from the code, which wins over a JSON declaration sent with the source. ' +
      'Visual scripts: publishBehavior {mode: "declaration-create", ..., graph: {nodes, edges}} creates a behavior whose logic is a node graph (graph kind "behavior"; ' +
      'its catalogue is in tl_content_query target="game" includeDescriptors (graphKinds.behavior)); edit it with graphEdit {owner: {kind: "behavior", id: behaviorId}, ops} ' +
      '(below). Exec ports (type exec) carry the flow from events along one wire per exec output (flow.sequence has several outputs). Events (field phase: intent, or ' +
      'transform for scripts that move objects): event.start (first step of every run), event.step, event.signal {signal}, event.trigger {when: enter|exit, trigger?} (triggers ' +
      'the script owns), event.overlap / event.raycast (a query around this object every step: enter|exit|each), event.input {action, when: pressed|released|held}, ' +
      'event.animator {event?, entity?}, event.timer {timer}, event.message {message, type} (sent with api.messages.send); callback events (intent phase, before the others): event.enable, event.disable, event.destroy (the object switched on, off, gone), event.contact {when: contact|separate, entity?} (hitboxes the script owns), event.ui {name?, type} (the step\'s UI events). Flow: flow.branch, sequence, for, foreach, while ' +
      `(loops: at most ${BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep} iterations per step in all, more is a script error with the node id), gate (enter/open/close/toggle), doonce (in/reset), delay {seconds} ` +
      '(step-counted, a timer "vs.delay.<n>"), switch {on: text|int, cases: "a, b, c" (comma separated, up to 32; outputs case1..caseN)} (+ default), select. Data ports: number, boolean, string, vector [x,y,z], list and map ' +
      `(bounded: ${BEHAVIOR_GRAPH_LIMITS.listItems} items, ${BEHAVIOR_GRAPH_LIMITS.mapEntries} entries; list/map nodes return new values) with conversions number→string, boolean→string, boolean→number, number→vector, vector→string; ` +
      'constants, maths, logic, text, vectors, random.* (a per-object deterministic sequence restarting each run). API nodes api.<ctx path> are generated from the runtime ' +
      'typings (every ctx call: game, signals, messages, timers, physics, tags, world, scenes, input, animator, audio, save, spawn/destroy, api.emit.* intents — Move/Pose ' +
      'object only in the transform phase, entity empty = this object, which makes the script own "@self"); an empty entity argument means this object; an unwired data ' +
      'input uses the node field of the same key; no cycles. Variables are var.number|boolean|string|vector|entity|enum|list|map nodes {name, default, visibility: ' +
      'public|private|local, …}: public/private ones of the property kinds are the behavior\'s properties (public ones set per object with setBehaviorProperties; a script may ' +
      'have none), local ones live for one event run; var.get / var.set {variable, value?} take the variable\'s type. Functions: graphEdit {owner: {kind: "behavior", id: ' +
      '"<behaviorId>#<functionId>"}} edits a script function (kind behavior-function: fn.entry, fn.input/fn.output {name, type} = the ports of fn.call {function}; created by ' +
      'the first edit that adds nodes, removed with its last node); shared functions are setGraph {kind: "behavior-library"} called with fn.library {function}. Publishing compiles the ' +
      'graph to TypeScript (the same compiler, limits and trust per digest) through the editor\'s Publish (HTTP POST content/behaviors/source {graph: true, ...}); ' +
      'the published source record has kind "graph". A script error in a graph behavior names its node (nodeId in tl_diagnostics errors). ' +
      'Prefabs: ' +
      'instantiatePrefab (a prefab keeps the source\'s components that may sit on a prefab (the descriptors\' prefab flag: collider, surface, materials, animator, mover, trigger, switch, ' +
      'audioSource, faceMovement, health, collectible, patrol, hitbox…); a collider on any of its objects; never the player controller or scene wiring). ' +
      'Component fields, defaults, the GameObject menu\'s create entries (label, size, value) and icons: tl_content_query target="game" includeDescriptors. ' +
      'Generic primitives (both physics dimensions; fields in queryGameConfig {descriptors}): collectible {counter, amount?, size?, onCollect?, respawn?}, ' +
      'health {max, start?} on any object (scripts: ctx.health.get/damage/heal, damaged/healed/died events), patrol {mode: waypoints|edges, speed, ...}, ' +
      'hitbox {shape?, size|radius, damage?} (contact/separate events with the other object and the normal). ' +
      'climbVolume {size: [w, h] or [w, h, d]} (the character climbs in it — up/down along the object\'s +Y, sideways across, at its controller climbSpeed, no gravity; jump or moving out leaves), gravity {scale? 0-10, size?} (an object that is not a character — e.g. an edge patrol — falls under the project gravity onto colliders below; not with mover, collider or a waypoint patrol); an edges patrol direction on the 2D plane may have a y part (it walks up/down, no ledge probe). ' +
      'trigger.sceneTransition {scene, spawn? (a playerSpawn in that scene or the trigger\'s), unload? [sceneIds]} loads the scene and moves the character there on entry; ' +
      'switch.action (interact mode; default interact); faceMovement {mode: "velocity", yawOffset?, turnSeconds?} faces the motion in any direction; playerSpawn.yaw (degrees, 0 = +Z); ' +
      'virtualCamera rig "track" {target, trackOffset?, deadZone? [w,h,d], damping?, boundsMin?, boundsMax?, lookAhead? [x,y,z] s (a vertical look-ahead: [0,t,0]), lookAheadMax? m (3), lookAheadSmoothing? s (0.2)}; cameraRegion {size [w,h] or [w,h,d] (world axes, centred; no d: every depth), camera? (a track camera; absent: all), priority?, deadZone?, boundsMin?/boundsMax? (offsets from the region), distance? (along the camera offset), blendTime? (0.5)} - while a track camera\'s target is inside, those replace the camera\'s own, blended on enter/leave (tl_game_observe camera.region); setEventCues {cues: [{on: signal|event, name, entity?, assetId (audio), volume?, bus?, maxLateMs? (500: how late a sound whose file is not ready may still start, else dropped)}]} plays sounds for signals and ctx.events types; ' +
      `scripts: ctx.character.impulse([x,y,z]), ctx.look.set(id, {emissive?, emissiveIntensity?, tint?}) / clear(id) / get(id). Surface presets: applySurfacePreset {entityId, preset: matte-ground|signal-red|emissive-accent}. setSettings also takes the engine settings fixed_step_hz 60|120|240 (120), audio_voices 1-${AUDIO_VOICE_CAP} (${AUDIO_VOICES_DEFAULT}), music_fade_s 0-10 (1), animation_crossfade_s 0-2 (0.2), render_backend 1|2|3 (1: auto = WebGPU else WebGL 2, the default; 2: WebGPU; 3: WebGL 2; an old 0 means auto; a page URL flag ?renderer=auto|webgpu|webgl2 overrides it), sim_thread 1|2 (1: the simulation runs in a worker, the default; 2: on the main thread of the page; ?threads=off|on overrides it), physics_dimension 2|3 (2: the 2D plane, the default; 3: 3D physics — every box collider then needs hz, its half depth, colliders may rotate on any axis and scale, polygons are 2D-only; 3D collider shapes: sphere {radius}, capsule {radius, height}, convex {points [[x,y,z]...] 4-64}, mesh {vertices [[x,y,z]...] <=1024, triangles [[a,b,c]...] <=2048; static}; triggers: box size [w,h,d], sphere {radius}, capsule {radius, height}; switches are 2D-only), random_seed 0-4294967295 (0: the seed of ctx.random in scripts; the same seed gives the same numbers in every run and replay), audio_spatial 0|1|2 (0: automatic = 2D by X distance to the player, 3D panned; 1: by distance; 2: panned, the listener on the active camera), instance_chunk_m 1-4096 (32: instance sets are culled in chunks of this size; each chunk draws one level of detail for its copies unless the set has lodPerCopy), texture_budget_mb ${TEXTURE_BUDGET_MIN_MB}-${TEXTURE_BUDGET_MAX_MB} (${TEXTURE_BUDGET_DEFAULT_MB}: GPU memory for textures in Play and the export; streamed textures load the mips their size on screen needs inside it, the least-needed dropped first), streaming_budget_mb ${STREAMING_BUDGET_MIN_MB}-${STREAMING_BUDGET_MAX_MB} (${STREAMING_BUDGET_DEFAULT_MB}: memory streamed terrain tiles, block chunks and scatter groups may take in Play and the export; what is kept past a ring goes first, rings that need more are reported, never cut), architecture_ship_meshes 0|1 (0: exports ship generated architecture's parameters and the game generates it at load; 1: they ship the generated meshes too), import_extract_textures 0|1 (0: new models extract their images, older imports keep theirs until re-imported; 1: every model, older imports extracted where their GLB file is), block_chunk_storage 0|1 (0: block chunk files as JSON text; 1: compressed binary, what new projects use; a change rewrites every chunk file), stats_overlay 0|1|2 (0: none; 1: the built-in stats overlay shown, F3 hides it; 2: hidden until F3 — Play and the export; scripts read ctx.stats, UI documents $flow.stats), frame_rate_cap 0|30|60|120 (0: none, the display's rate; the most frames per second Play and the export draw, game time unchanged; scripts ctx.display.frameRateCap / setFrameRateCap(fps|null), a saves settings field with engine frameRateCap, the UI action setSetting frameRateCap). Scenes: createScene {name, sceneId?, environmentFrom? (a scene whose look the new one copies; absent: the engine defaults)}, ` +
      'renameScene {sceneId, name}, deleteScene {sceneId} (only an empty scene), setStartScenes {sceneIds} (the ' +
      `scenes the game starts with; the character is in a start scene (Play refuses two; keepLoaded: true on an object keeps it, its children and scripts across scene loads, unloads and reloads — createEntity/updateEntity/ctx.spawn take it); cameras are virtualCamera shots in any scene (the engine owns the view: none live → a default pose and a Play warning; their lens defaults are the camera_fov_deg/camera_near_m/camera_far_m settings); lights belong to any scene: the most recently loaded scene's directional, ambient and hemisphere light is on, point/spot lights of all loaded scenes share a budget of ${MAX_LOCAL_LIGHTS}; a spot light may carry cookie: a texture assetId projected through its cone). ` +
      'createEntity/instantiatePrefab/pasteEntities/createEntities need sceneId (no default scene) or a parentId (the parent\'s scene); ' +
      `Where new things go: ${RESOURCE_CREATING_OPS.join(', ')} take folder: "assets/levels" (a folder of the game folder, the upload folder\'s rules; made when missing): ` +
      'a scene it creates is written as <folder>/<sceneId>.scene.json, a resource as <folder>/<id>.<kind>.json; a record the op only changes stays where its file is. ' +
      'Without folder a scene goes to scenes/ in the project folder and a resource to assets/<kind>/. Scenes and resources are found by their id wherever they are. ' +
      'one command edits one scene and entity ids are unique across scenes. An instance set is ' +
      'setComponent "instances" {asset:{assetId, piece?}, buffer:<sha256 of a staged buffer>, count}. ' +
      'paintInstances {entityId, mode: paint|erase, dabs: [[x, y, z] world points of the stroke, ' + `1-${INSTANCE_BRUSH_LIMITS.dabs}], ` +
      'brush: {radius (m), density (copies per m2), spacing (m, the least distance between copies across the ground), scale: [min, max], yaw (random turn 0-yaw degrees), ' +
      'align (0 upright - 1 along the surface normal), seed (whole number)}, surface?} is the editor\'s instance brush: one stroke, one command, one undo. ' +
      'Places come from the seed (a jittered grid of 1/density m2 cells in world XZ, the points inside any dab), so the same stroke gives the same copies and painting it again adds none; ' +
      `each drops straight down onto the surface within ${INSTANCE_BRUSH_REACH} radii above and below its dab: without surface onto the scene's block layers (other places get no copy); ` +
      `surface (the editor sends it: per candidate in that order [y, nx, nz] or null, up to ${INSTANCE_BRUSH_LIMITS.samples}) names the surface itself. ` +
      `erase removes the copies within the radius across and ${INSTANCE_BRUSH_REACH} radii up and down of any dab (a set keeps one copy). ` +
      'The copies stay in the set\'s chunks. ' +
      'A terrain is setComponent "terrain" {tileSamples: 17|33|65|129|257|513|1025 (2^n+1 samples a tile side), spacing (m between samples), heightRange: [low, high] (m above the object; 16-bit steps), ' +
      'tiles: [{x, z, data?}], lodDistance? m, collision?, macroDistance? m (past it, tiles are drawn from a baked top-down albedo and normal per tile: two texture reads instead of the material\'s), rules? (see bake), streaming? {render m, collision? m, scatter? m, hysteresis? m} (Play and the export keep only the tiles within these rings of the camera and its characters, the rest drawn from an overview the build makes; a blockLayer takes the same plus live? m for its chunks and live blocks; absent: everything loaded)} (the object\'s position is the min corner of tile [0, 0]; a tile without data is flat at 0 m; data digests are written by editTerrain). ' +
      `editTerrain {entityId, kind, ...} is one edit, one undo: kind raise|lower|smooth|flatten|noise with dabs [[x, z] world points, 1-${TERRAIN_BRUSH_LIMITS.dabs}], radius (m), strength (raise/lower/noise: m at the centre; smooth/flatten: blend 0-1], ` +
      'falloff? smooth|linear|constant, flatten height (world y), noise scale? (m) and seed?; kind ramp {from, to: [x, y, z] world, radius (half width m), strength 0-1, falloff?}; ' +
      'kind paint {dabs, radius, strength 0-1, layer 0-255, erase? (true: back to the baked layers)} paints hand paint over the rule-baked layer weights (each sample blends its strongest four layers); ' +
      'kind holes {dabs, radius, erase?} cuts cells out (erase fills them); kind import {stageId (tl_content_upload), format png16|raw16, size? [w, h] (raw16; absent: square), byteOrder? little|big, ' +
      'at? [tileX, tileZ], range? [low, high] m its 0 and 65535 stand for (absent: the terrain\'s)} lays a 16-bit heightmap one pixel per sample (rows go +z) and adds the tiles it reaches; ' +
      'kind fromBlocks {source: a block layer object} turns the layer\'s corner-height surface into tiles (cells over no column become holes, painted layers 0-3 come as hand paint). ' +
      'Material rules (terrain and block layers alike): [{layer, strength? 0-1, face? top|wall, height? (world m), slope? (degrees), cavity? (m the ground radius? m around lies above: + hollows), noise? {scale m, seed?}, weight? {layer} (its share 0-1 left by the rules before), ' +
      'blocks? [block type ids] and meta? {field: value} (block layers only)}], each condition a range {min?, max?, fade?} fading over fade past its ends; in order, each takes its share of every layer so far; where none applies, layer 0. ' +
      'kind bake {rules?, scatter?} sets a terrain\'s rules (absent: its own again — unless only scatter is given; []: none) and bakes them into every tile; a sculpt, ramp, import or conversion bakes them again where it moves the ground; hand paint stays over them (a setComponent of rules alone does not bake). ' +
      'Scatter rules (terrain and block layers alike) place models where conditions hold, their copies baked per terrain tile (tiles[].scatter, a blob) or block chunk: [{id (1-32 of A-Z a-z 0-9 _ -), asset: {assetId, piece?}, density (candidates per m² where every condition holds fully), spacing? m (no two copies closer), scale? [min, max], yaw? degrees (default 360), align? 0-1 (lean to the normal), sink? m, seed?, ' +
      'height?, slope?, cavity?, noise? (as material rules), layers? [{layer, min?, max?, fade?}] (the share 0-1 the ground shows of a material layer), blocks?/meta? (block layers), exclude? [block-layer region names kept clear], castShadow?, chunkSize? m (default 256), densityStart?/densityEnd?/densityMin? (as an instance set), lodPerCopy? (default true), collide? (each copy carries its model\'s _COL colliders)}]. ' +
      'editTerrain bake {scatter} sets and bakes them (an edit of the ground or the paint bakes them again around itself, the same copies as a whole bake); kind scatter {rule, dabs, radius, erase?} is the scatter brush: the rule\'s candidate places under it get a copy whatever the conditions (erase: none), kept over every later bake. ' +
      'Edit layers: terrain.layers [{id, kind: stamps|erosion|splines|blocks, name?, enabled? (false: off), strength? 0-1}] apply in order over the hand-made ground (tiles[].base) into the drawn tiles (the splines on top when none is listed); a setComponent of layers combines the ground again where the change reaches (one undo). ' +
      'A stamps layer has stamps [{asset (texture: its first channel is the shape), at [x, z] world centre, size m (a side), rotation? deg, height m (white), mode? add|max|min, y? (max/min: world height of the shape\'s 0), falloff? 0-0.5}]. ' +
      'A blocks layer {blockLayers? [block layer object ids] (absent: every one), mode? cut|flatten (default cut), blend? m (8), paint? (false: the blocks\' paint stays theirs)} makes the ground meet block layers: on their border it is their ground (the top of each column\'s lowest run of blocks), round it it fades back to its own over blend m, under them it is cut away (holes, a cell in from the border) or flattened 2 cm below them, their paint carries across; a block edit re-bakes the terrain round the columns it changed (a follow of the same command), and the terrain\'s uvOrigin is set to the first block layer\'s origin so textures line up. Its stored and ground-cover scatter keep off the blocks. ' +
      'editTerrain kind erode {rect [x0, z0, x1, z1] world, layerId? (default erosion; made when missing), hydraulic? {droplets?, erosion?, deposition?, capacity?, evaporation?, inertia?, lifetime?, radius?}, thermal? {iterations?, talus? deg, amount?}, seed?} erodes the ground below its layer there and keeps the result as that layer (deterministic; at most ' + `${Math.round(Math.sqrt(EROSION_MAX_SAMPLES))}² samples a run); only the combined heights ship. ` +
      'The result names the tiles it wrote in terrain {tiles, added, changed, clamped?, scatter? (tiles whose scatter changed)}; tl_content_query target="terrain" reads heights back. ' +
      'Generated architecture is setComponent "architecture" {elements, profiles? {name: {points [[across m (right of travel), up m]], slots [trim row per segment, "" open], closed?, smooth?, chamfer?}}, overrides? [{element, segment|corner, reach?, model {assetId, piece?}, stretch?}], chunkSize? m (16), seed?, ao? {strength? (0.6), radius? m (0.5)}, lodDistance? m (40), castShadow?, receiveShadow?}: '
      + 'elements are sweeps {id, kind: "sweep", path, profile, openings? [{id, at m along, width, bottom, top, reveal? slot, frame? profile, frameSides? outer|inner|both, model?}], material?, detail?, collide?}, repeats {id, kind: "repeat", path, spacing m, start?, end?, corners?, align?, offset? [across, up], yaw?, jitter? {yaw?, along?}, piece {elements [sweeps/fills made once and stamped]} | {model {assetId}}} and fills {id, kind: "fill", path (closed), shape: flat|coffered|barrel|groin|gable|hip|mansard (vaults and roofs need a rectangle), slot, trimSlot?, height?, rise?, face? up|down, axis? long|short, cell?, depth?, overhang?, breakRise?, inset?}; '
      + 'a path is {points [[x, y, z] m from the object], closed?, bulges? [per segment: tan(angle/4), + right], curve?, step?, offset? m right, chamfer? m}. Faces look right of a profile segment\'s direction. The object\'s materials {"architecture": trim material} give the row tables (any slot may name its own); only parameters are stored and the meshes are generated at load on workers (setting architecture_ship_meshes 1 ships them in exports too). '
      + 'Styled outlines: architecture.outlines [{id (≤48 chars), path, preset, openings?}] are made by the preset\'s style graph; masks? {name: {points [[x, z, radius m, weight 0-1]]}} are painted masks presets read. A style is a graph (setGraph kind "architecture-style": outline, parameter {name, default, min, max}, constant/add/multiply/mix, offset/raise/chamfer/square paths, wall/band/cove/shaft/frame profiles, sweep/repeat/fill, one output; every number field has an input port of its key); '
      + 'a preset is a graph (kind "architecture-preset": one preset node {style, base (a preset it derives from), sheet (a trim material)}, value nodes {parameter, value}, mask nodes {parameter, to, source noise|height|painted, mask, scale, seed, low, high}); the engine\'s starters (starter-room, starter-room-tall, starter-hall, starter-rail, starter-fence, starter-pipe and their -style graphs) are in every project. Restyle by changing outlines\' presets; scripts: ctx.grid.setArchitecturePreset(from, to|null). '
      + 'Rooms and paths: architecture.layer names the block layer they are drawn on (closed outlines = rooms, inside right of travel; open = rails, fences, pipes); outlines take outside? (a preset for the outer faces), storeys?, storeyHeight?, holes? [{storey?, path}], stairs? [{id, from [x,y,z], to [x,y,z], width, steps?}], openings with storey? and pane?. Rooms sharing a straight wall make it once (the first listed); a sweep\'s wall flag marks the room wall; walls on cell lines block the layer\'s ctx.grid walks (doorways pass), rooms are its regions, its wall paint shows on them. '
      + 'Buildings: architecture.buildings [{outline fields, roof? {shape flat|gable|hip|mansard, slot?, rise?, overhang?}, interior? {scene, offset?}, program?, furnishing?, layoutSeed?, pins? [{id, model {assetId, piece?}, position, facing deg, size? [w, d]}]}]: program names a graph of kind "room-program" (one program node {grid, minSide, doorWidth, doorHeight, entrance, filler}, room nodes {type, area share, count, storeys ground|upper|every, stairs, preset}; a wire between two room nodes asks for a door) that splits the footprint (sides along x and z) into rooms at load, seeded by layoutSeed; furnishing names a "furnishing-set" graph (furnishing node {doorClearance, pathWidth, wallGap, lights}, prop nodes {room type, model, piece, place wall|corner|centre, width, depth, height, count, spacing}, light nodes {room type, color, intensity, range, height}) placing kit copies by room type and one point light per room (within the scene\'s light budget); pins stay where they are; outlines with building and roomType are a locked plan\'s rooms (the program no longer runs). Room programs and furnishing sets are the game\'s data. ' +
      'A spline is setComponent "spline" {points: [{at: [x, y, z] (m from the object\'s position; rotation and scale unused), tangent?, width?, roll? (deg, right side up)}] (2+), closed?, width? (default 4), ' +
      'terrain? {shape?: flatten|carve|raise|none, falloff? m (4), depth? m (a channel), offset? m (below the points), paint? {layer, strength?, width?, falloff?}, order?}, scatter? {margin? m (1), rules?} (stored and ground-cover scatter kept clear of the band), mesh? {kind?: surface|water, profile? [[across in half widths, up m]], offset?, tiling?, step?, collision?, flow?, foam?}, pieces? [{asset, spacing, start?, offset? [across, up], yaw?, upright?, collide?}]}: ' +
      'the same command shapes every terrain it crosses (heights, paint, scatter re-baked round the curve before and after; the change\'s follows name the terrains written; one undo; block layers are never changed: the carve stops at their cells); tiles[].base keeps the hand-made ground, so sculpting under a road keeps it and moving the road gives the ground back. Scripts read splines with ctx.splines.at/nearest/length. Models: createEntity kind "model" ' +
      'takes model {asset:{assetId}, piece?} — piece names one piece of a multi-piece GLB (the base name of its <piece>_LOD0..n / ' +
      '<piece>_COL nodes, or a top-level node); LOD nodes switch by screen size and _COL nodes are never drawn. A folder create ' +
      'may carry children: [createEntity args without parentId] (up to 256, one undo). createEntity also takes active, visible, locked, static (booleans) ' +
      'and tags ([tag names]). createEntities {entities: [createEntity args + ref?], sceneId?} creates up to 1024 in one revision and one undo ' +
      '(a later item\'s parentId may name an earlier item\'s ref; the change lists the created entities in order). deleteAsset {assetId} and ' +
      'deletePrefab {prefabId} remove a record; refused (reference_in_use, the uses in details) while any object, prefab, asset, material, document ' +
      'or a script\'s string literal still names it; deleteAsset also deletes the asset\'s file and its .tlasset sidecar from the game folder ' +
      '(one undo restores all of it). setAssetOptions {assetId, vertexColors: ' +
      '"data"|"tint"}: COLOR_0 is shader data by default, "tint" multiplies it into the base colour; setAssetOptions {assetId, sourcePath} ' +
      'moves the asset\'s file (with its sidecar) to that path of the game folder, or records a move already made there; the id and ' +
      'every reference stay. Audio is one kind, any length: Ogg Vorbis/Opus, MP3, WAV (PCM or float, any rate, channels, bits) or FLAC; ' +
      'setAssetOptions {assetId, loadType?: "decode-on-load"|"decode-while-playing"|"stream"|null, preload?: bool} sets how the game holds it ' +
      '(null: the default by length — under 5 s decoded on load, over 60 s streamed, else decoded while playing) and whether it is read with its ' +
      'scene (true) or only when played; a format one browser does not play (Ogg in Safari older than 18.4) is imported and reported in Problems. ' +
      'setAssetOptions {assetId (a texture), streaming: bool|null} streams its mips in Play and the export: the mip tail (levels up to 128 px) is read first and larger levels as its size on screen needs them, inside the texture budget (setting texture_budget_mb); ' +
      `null: the default, on for a KTX2 texture over 1024 px; only a KTX2 mip chain streams (import a PNG/JPEG/WebP with ktx2 to stream it); queryAssets shows streaming {on, set, possible}. setAssetOptions {assetId (a model), lod: {screenSizes?: [n...], cullSize?: n}|null} sets its LOD group: the screen sizes (fraction of the screen height LOD0 covers, decreasing, in (0, 1]) where _LOD1, _LOD2, … take over (absent: ${LOD_SCREEN_SIZES_DEFAULT.join(', ')}) and the size below which it is not drawn (absent: never; block layers never cull; parts outside the _LOD groups are culled with it); null: the defaults; settings lod_bias ${LOD_BIAS_MIN}-${LOD_BIAS_MAX} (${LOD_BIAS_DEFAULT}; 2 keeps every level twice as far) and lod_hysteresis 0-${LOD_HYSTERESIS_MAX} (${LOD_HYSTERESIS_DEFAULT}; a level switches back that much closer) apply to every model; an instance set draws one level per chunk (picked at its centre; instances lodPerCopy true: each copy picks its own, a draw per level in a chunk that spans a switch point) and thins copies out where they are small when densityMin is under 1 (instances densityStart/densityEnd screen sizes, densityMin share kept; absent: ${INSTANCE_DENSITY_START_DEFAULT}, ${INSTANCE_DENSITY_END_DEFAULT}, ${INSTANCE_DENSITY_MIN_DEFAULT} = no thinning; the editor's scatter makes new sets with densityMin ${INSTANCE_DENSITY_MIN_NEW}). Every imported file is kept in the game folder next to its .tlasset sidecar; uploaded bytes land in assets/, or in ` +
      'the folder publishAsset names with folder: "assets/props" (relative to the game folder; never a hidden folder or the project\'s own files). ' +
      'Extract textures (a model import setting, on for a new model unless publishAsset says extractTextures: false; a reimport keeps the model\'s setting or takes extractTextures: true|false; setting import_extract_textures 1 extracts every model, older imports where their GLB file is, and Problems (models_hold_images) lists models still holding images): ' +
      'the GLB\'s images become texture assets in <model folder>/<model>_textures/ (a PNG, JPEG or WebP encoded to KTX2 with mips — colour, normal map or data by what its materials sample it as — from a lossless PNG of the image\'s name and size beside the model (or in its textures/ folder) when the image is lossy; a KTX2 as it is; ' +
      'an image some texture asset already holds is that asset), the model names them in textures {image index: assetId}, and they count and stream like any texture; ' +
      'the result\'s textureExtraction lists each image. ' +
      `Generate LODs (a model import setting, off unless asked; publishAsset or importAssets generateLods: true; a reimport keeps a model's levels): a GLB without _LOD<n> levels gets _LOD1… at ${MESH_LOD_RATIOS_DEFAULT.join(', ')} of its triangles from the mesh simplifier, stored in the converted model (convertedFrom.lods); textureExtraction.lods reports the triangles per level and the nodes skipped. ` +
      'importAssets {folder, labels?: [label], ktx2?: "color"|"normal"|"data", extractTextures?: bool, generateLods?: bool} imports every supported file of a game-folder folder, subfolders ' +
      'included, in one command and one undo: each becomes an asset named after its file (assets/audio/voice/line-001.ogg → "line-001"; the id is the ' +
      'name made id-safe, -2, -3 … when taken; a file whose sidecar names an unused id keeps it), with the labels on every one (a label: a letter or ' +
      'digit, then letters, digits, _ - . /). Files already imported are skipped, and the result\'s ' +
      'folderImport lists them (skipped), files no importer takes (unsupported) and files an importer refused (rejected); undo forgets the assets, the files stay. ' +
      'Asset records and tl_content_query assets carry their labels. Addresses and labels are the names scripts load by: ' +
      'setLabels {items: [{kind, id}], add?: [label], remove?: [label]} labels any number of assets (kind "asset" or the asset kind) and resources ' +
      '(kind prefab, material, behavior, animator, graph, effect, library, ui, uitheme, dialogue, timeline, envpreset) in one command and one undo; ' +
      'setAddress {kind, id, address: string|null} gives one item its address (unique project-wide; refused when another asset or resource has it). ' +
      'The project window\'s file operations, each one command and one undo however many files: moveResources {items?: [{kind, id}] (kind asset or its kind, a resource kind, or scene), ' +
      'folders?: ["assets/old"], to: "assets/props" ("" the top of the game folder)} moves the files (an asset with its .tlasset sidecar, a resource file, a scene file) and whole folders ' +
      '(with every file in them) into to; renameFolder {folder, name} renames one folder in place; createFolder {folder} makes one. Ids never change, so no reference and no built ' +
      'content changes; a taken target, a folder moved into itself or an asset whose bytes are stored (no file) is refused; undo moves everything back. ' +
      'Anything with an address or a label is loadable: Play and export ship it even when no scene references it, and the runtime catalog lists it; ' +
      'scripts load it with ctx.assets.load(key) (key: an address, else an asset or resource id, else a label: every entry carrying it) → a handle at once (0: no such name), ' +
      'then ctx.assets.state(h) loading|ready|failed, ready(h), ids(h), error(h) — the simulation never waits, the answer arrives on a later step and replays with the recording — ' +
      'and ctx.assets.release(h) lets it go (what a handle holds stays in memory until then; tl_game_observe resources.open lists open handles); visual scripts: Load assets, Release assets, Assets state/ready/error. ' +
      'a script that names an asset by id in a string literal while that asset is not loadable is reported in Problems. pasteEntities {entities: [full entity ' +
      'values as tl_inspect returns them, parents with their children], parentId?: id|null, offset?: [x,y,z], sceneId?} copies them with ' +
      'new ids in one undo (references inside the copy are remapped; use it to duplicate or to copy between scenes). Materials: ' +
      'setMaterial {material: {materialId, name, shader: standard|foliage|kit|unlit|water, params: {...overrides}, textures: {slot: ' +
      'textureAssetId}}} creates or replaces one (on a model it starts from the file\'s own material and changes only what it sets); ' +
      'deleteMaterial {materialId}; objects use them with setComponent "materials" {<source material name or "*">: materialId}, a ' +
      'model asset for every placement with setAssetOptions {assetId, materials: {...}|null}, a block type with setBlockType {block: {…, materials}}. ' +
      `A material instance is a material with instanceOf: <parent materialId> (a material or another instance, chains up to ${MAX_MATERIAL_INSTANCE_DEPTH}): it draws as its parent with ` +
      'the values it sets — params/textures over a shader material\'s, values: {<parameter key>: value} over a graph material\'s parameter defaults; its shader is ' +
      'its parent\'s, it has no graph or parameters of its own; any mapping, override, effect or timeline may name it, and a used instance ships resolved. A graph material adds graph: {nodes, edges, groups?, comments?} (graph kind ' +
      '"material": the graph replaces shader/params/textures at render time: it compiles to a node material in the Scene view, Play and exports; the file\'s own material is not used) and ' +
      `parameters: [{key (identifier), type: float|vec2|vec3|vec4|color|texture|data, default, min?, max?, size? (data: [w, h] cells 1-${MATERIAL_DATA_MAX}; default = the RGBA bytes every cell starts with; texture: an asset id, or per-layer slots — a list of plain texture ids, one per array layer ("" = the first filled slot\'s), assembled into one array for the views, Play and exports; an instance may change slots, an object override takes one texture), visibility?: public|private, label?, group?, tooltip?, extraLayers? (vec4 per-layer settings, e.g. the layered template's layerTiling: the values of texture-array layers 4, 5, … — a terrain reads each layer's own; absent or past its end: layer L takes component L % 4)}] ` +
      '(read by Parameter nodes {key}); its graph is then edited with graphEdit {owner: {kind: "material", id: materialId}, ops}; objects override public parameters ' +
      'with setComponent "materialParams" {<materialId>: {<key>: value}} (private ones are refused; data parameters are written by scripts: ctx.materials.setData, read by Sample data nodes). Material functions (reusable sub-graphs) are standalone graphs of kind ' +
      '"material-function" (setGraph; Function input {name, type, default} / Function output {name, type} nodes are the ports of every Function call {function: graphId} node; ' +
      'calls may not form a cycle; a function whose ports are wired in a material cannot drop them). Each scene has its own look: setEnvironment {sceneId, environment: {wind?: ' +
      `{direction: [x, z], strength, gust, gustFrequency, turbulence}, sky?: {mode: procedural|gradient|texture|color, ..., rotation? (texture skies: degrees about +Y, -${SKY_ROTATION_MAX}-${SKY_ROTATION_MAX}; turns background and sky lighting together)}, fog?: {mode: none|linear|exp2, color, near?, far?, density?}, ` +
      'post?: {toneMapping?, exposure?, bloom?, grading?: {brightness?, contrast?, saturation?, tint?, lut?, lift? -0.5..0.5, gamma? 0.2..5, gain? 0..4}, vignette?, ssao?, dof?, antialias?}, wetness? (0-1: rain; materials with a Scene wetness node, the height-blended layers template, darken, shine and pool water; presets blend it), heightFog? {density (per m at its base, 0-1), color, height? (world m of the base, 0), falloff? (per m: thins with height, 0.05), start? (m from the camera with none, 0), inscatterColor? (a glow towards the sun), inscatterExponent? (1-64, 8)} (exponential height fog over the distance fog; it fogs the sky towards the horizon too; presets blend it)}} replaces that scene\'s look ({} = the engine defaults; with several scenes loaded the active scene\'s applies; tl_inspect target=project environments=true lists the looks); ' +
      `setEnvironment {environment: {quality?, qualityLevels?: [{id, name?, post?: {bloom?, ssao?, dof? (fields over the look\'s where the look has the effect on; enabled: false turns it off; never turns one on), antialias?}, renderScale? ${RENDER_SCALE_MIN}-${RENDER_SCALE_MAX}, pixelRatio? ${PIXEL_RATIO_CAP_MIN}-${PIXEL_RATIO_CAP_MAX}, msaa? ${MSAA_SAMPLE_COUNTS.join('|')}, shadowMapSize? ${SHADOW_MAP_SIZES.join('|')} (largest shadow map), localLights? 0-${MAX_LOCAL_LIGHTS}, shadowedLights? 0-${MAX_LOCAL_LIGHTS} (point/spot lights drawing a shadow at once: largest on screen first, spot before point, fading by 40 m, maps redrawn only when something in reach changed; absent: every one), ambientOcclusion? ${AMBIENT_OCCLUSION_KINDS.join('|')}, lodBias? ${LOD_BIAS_MIN}-${LOD_BIAS_MAX}, dynamicResolution?}] (lowest first; absent: low/medium/high; each unset setting is the project\'s), presets?: [{presetId, name, sky?, fog?, post?, lights?: [{entity|tag|type, color?, intensity?, direction?, groundColor?}], lightmap?: {intensity?, tint?}, wetness? 0-1}]}} (no sceneId; replaces the project\'s part whole) sets the project\'s quality levels, the level a game starts at and the presets (named looks laid over the active scene\'s, scripts switch/blend to them with ctx.environment.set(id, {blend, easing, override}) / blend(a, b, t); tl_game_observe reports environment {target, progress, weights}) ` +
      '(the foliage shader bends by COLOR_0.r); a fogVolume component {size, density, color, falloff?, heightFalloff? per m (density fades above the box bottom)}. Cameras: a virtualCamera component {rig: follow|orbitPoint|topDown|fixed|rail, priority?, enabled?, target? (entity), targetOffset?, distance?, yaw?, pitch?, pitchMin/Max?, yawAction?/pitchAction?/zoomAction?/turnLeftAction?/turnRightAction? (input action names), yawStep?, turnTime?, point?, collision?, damping?, path? (rail: the entity with a cameraPath {points: [[x,y,z]...], closed?, smooth?}), progress?, railSpeed?, railMode?, fovY?, near?, far?, blend?: cut|linear|eased, blendTime?, letterbox?, shakeAmplitude?/Frequency?/Rotation?} — the enabled one with the highest priority is live (scripts: ctx.camera); tl_game_observe reports the resolved camera. Sockets: a socketAttach component {target (an entity with a model), node (a node/bone name of its model), position?, rotation?, scale? (offset in the node space), attached? (default true)} — the object rides on that node every step (scripts: ctx.sockets.attach/detach, ctx.animator(id).setSpeed); tl_game_observe reports sockets [{entityId, target, node, position}]. setLighting {sceneId, ' +
      'lighting: null} clears a scene\'s baked lightmaps and probes (bakes are made in the editor\'s Lighting window; probes there with "Bake probes", WebGPU only); a probeVolume component {size [w,h,d] m, spacing? m} sets where the probe bake puts probes (none: over the static objects). Animation: setAnimator {controller: ' +
      '{controllerId, name, parameters: [{name, type: float|int|bool|trigger, default?}], states: [{id, name, motion: {kind: "clip", clip: ' +
      '{assetId, clip, duration}} | {kind: "blend1d", parameter, children: [{threshold, clip, speed? (the ground speed in m/s it was authored for; with one on every child the tree reads the parameter as a ground speed and matches it)}]}, speed, speedParameter?, loop}], transitions: ' +
      '[{from: stateId|"*", to, conditions: [{parameter, op: greater|less|equals|notEquals|true|false|trigger, value?}], duration, exitTime?, ' +
      'interruption?: none|source}], entry, events: [{assetId, clip, time, name}], layers?: [{name, mask: [bone names] (empty = every ' +
      'bone), weight 0-1, weightParameter? (a float param it is multiplied by), states (motion may also be {kind: "empty"}: the layers ' +
      'under show through), transitions, entry}] (up to 3 override layers over the base layer, e.g. an upper-body attack while running; ' +
      'state ids are unique across layers), morphs?: [{target (a morph target name), parameter (a float param: its 0-1 value is the weight)}]}}; deleteAnimator {controllerId}; a model entity plays one ' +
      'with setComponent "animator" {controller, parameters?, startTime? (normalized 0-1), randomStart? (a start drawn from the random_seed and the object id), lookAt? {head: {bone, yaw, pitch (limits each way, degrees)}, neck?, chest?, target? (entity id) | point? [x,y,z], weight? 0-1, weightParameter? (float param), turnSpeed? deg/s (360)} (turns the head chain toward the target after the clips; scripts setLookTarget(id|null)/setLookPoint([x,y,z])/setLookWeight(w))}. An animation-only GLB (clips, no mesh needed) is marked with ' +
      'setAssetOptions {assetId, clipsFor: rigModelAssetId | null}; its clips then play on that model (matched by bone names) and ' +
      'controllers may name them. The old modelAnimation idle/run/airborne component becomes an animator controller when the project ' +
      'is opened. The player\'s animators get speed, grounded, velocityY and a landed trigger ' +
      'automatically; scripts use ctx.animator(entityId)?.set/trigger/state(layer?)/play(state, fade?, layer?, normalizedTime?). Input: setInput {input: {actions: [{name, type: ' +
      'button|axis1d|axis2d, map: gameplay|ui, bindings: [{kind: "key", code: KeyboardEvent.code} | {kind: "gamepadButton", button} | ' +
      '{kind: "gamepadAxis", axis} | {kind: "keys1d", negative, positive} | {kind: "keys2d", up, down, left, right} | {kind: ' +
      '"gamepadButtons1d", negative, positive} | {kind: "gamepadStick", x, y} | {kind: "pointerButton", button: left|right|middle} | ' +
      '{kind: "pointerPosition"} (axis2d: x, y 0-1 from the top left) | {kind: "pointerDelta"} (axis2d, up positive) | {kind: "pointerAxis", ' +
      'axis: x|y|wheel} (axis1d)], deadZone?, invert?, scale?}], cursor?: {gameplay?: free|locked, ui?: free|locked}} | null} (null = defaults: ' +
      'move, jump, attack, interact, pause, submit, cancel, navigate); scripts read ctx.input.value/pressed/released/held(name), ' +
      'ctx.input.pointer() / pointerPressed/Released/Held(button) and ctx.input.setCursor(free|locked|auto); the cursor hides while a gamepad drives. ' +
      '3D queries (physics_dimension 3): ctx.physics.raycast3d/overlapSphere/overlapBox3d/overlapCapsule/pickAt/pickAtPointer with a filter ' +
      `{tags?, layers?, exclude?}; setCollisionLayers {layers: [name...]} names up to ${MAX_COLLISION_LAYERS} collision layers ("default" is implicit) that ` +
      'collider {layers: [...]} lists. ' +
      `Light layers (${LIGHT_LAYER_COUNT}; masks are integers, bit n = layer n+1, ${LIGHT_LAYERS_ALL} = all, absent = all): box, model, instances and blockLayer take lightLayers (1-${LIGHT_LAYERS_ALL}: the layers it is in); ` +
      `a light takes lightMask (0-${LIGHT_LAYERS_ALL}: it lights only objects in one of these layers) and, directional/point/spot, shadowCasterMask (0-${LIGHT_LAYERS_ALL}: only objects in one of these cast its shadow); ` +
      `scripts set them with ctx.entity(id).set("light", {lightMask, shadowCasterMask}); setLightLayers {layers: [name...]} names up to ${LIGHT_LAYER_COUNT} layers by number (index 0 = layer 1, "" unnamed, up to ${MAX_LIGHT_LAYER_NAME} chars; editor labels only). ` +
      `Local lights per vertex: box, model and instances take localLights ${LOCAL_LIGHT_MODES.join('|')} (how point, spot and effect lights reach it: per pixel, per vertex — diffuse only, no shadows or highlights, cheap on dense meshes — or none; absent: its material's localLights param, else ${INSTANCES_LOCAL_LIGHTS_DEFAULT} for instance sets and pixel for the rest); ` +
      `a point/spot light takes importance ${LIGHT_IMPORTANCES.join('|')} (auto follows each object's mode). The sun, ambient light and probes are always per pixel. ` +
      'Collider shapes: every primitive takes center? [x,y,z] m and rotation? [x,y,z,w] (its place in the object\'s frame; a 2D plane turns about Z only); ' +
      '{type: "compound", shapes: [primitives]} puts several on one body; {type: "model"} is every convex part (each mesh) of the object\'s own model\'s <piece>_COL node, read when the game is built (Play/export warn collider_model when a model has none). ' +
      'A collider may sit on a child object: it follows its parents (kinematic once one of them is moved by a script, a timeline or a mover; a mesh collider stays static). ' +
      'colliderFromModel {entityId, kind: box|convex|mesh|polygon|compound} makes the object\'s collider from its model file, as the editor\'s button does (box around the render geometry, centred; convex/mesh from the _COL node, else the geometry, 3D; polygon on the 2D plane; compound: one hull per _COL part) — one undo. ' +
      `Project saves (v4): setSaveSchema {schema: {version (1+), slots (1-${SAVE_LIMITS.slots}), migrations?: [{from, name}], sections?: [grid|materials|spawned|storage|dialogue], ` +
      `thumbnail?: {width, height (16-${SAVE_LIMITS.thumbnailSide} px), format: jpeg|webp, quality?}, settings?: [{key, type: bool|number|string|enum, default, label?, min?, max?, values?, ` +
      'engine?: music|sfx|ui|quality}]} | null}; scripts use ctx.saves.write(doc)/read()/save(slot, {title?, chapter?, location?, thumbnail?})/load(slot)/' +
      `delete(slot)/slots()/results()/migration(name, fn)/setting(key)/setSetting(key, value) (${SAVE_LIMITS.documentBytes / 1_048_576} MiB per slot; saves live in the browser). ` +
      'Gameplay blocks (v4; setComponent or createEntity components): mover {waypoints: [[dx, dy, dz]...] offsets, speed, mode: ' +
      'loop|pingpong|once, wait?, easing?: linear|smooth|gravity (gravity: from rest at each point, constant acceleration), startOn?: signal, stopOn?: signal (holds it), toggleOn?: signal (moves a held one, holds a moving one), reverseOn?: signal (back the way it came), active?: false (held), maxPush? 1-1000 m/s (60: how hard it shoves a player out of its way)} (with a box collider it is a moving platform that carries ' +
      'the player; startOn makes a door); trigger {size: [w, h] (box) | shape: "circle", radius m (instead of size), signal, once?, exitSignal? (sent on leaving), mode?: enter|stay (stay: the signal every step while the player is inside)}; switch {mode: interact|stand, signal, size, once?}; ' +
      'health {max, start?} (any object); collectible, patrol and hitbox (above); collider {oneWay: true} (jump up through, Down+Jump drops), a box shape\'s hz? m (half depth; required when physics_dimension is 3); controller {capsule: {radius 0.05-5 m, height 0.1-20 m (total, >= 2 x radius), offset? [x, y] or [x, y, z] m from the entity origin (z: 3D projects)} | null} is the player\'s collision capsule (absent = radius 0.3, height 1.8, centred; every system uses it: physics, spawn clearance, triggers, collectibles, hitboxes), plus the optional movement tuning acceleration (40 m/s²), deceleration (60), coyoteTime (0.05 s), jumpBuffer (0.0667 s), jumpRelease (0.5), groundSnap (0.1 m), skin (0.01 m), autostep (false), autostepHeight (0.25 m), climbSpeed (2 m/s), climbAction? (an axis; absent: the move action\'s y), wallSlide (false), wallSlideSpeed (2 m/s), wallJump (false), wallJumpAway? (absent: run speed), wallJumpUp? (absent: jump speed), wallJumpLock? s (absent: no steering until the top of the jump) (null resets one); playerSpawn {yaw?} (v4; degrees about +Y, 0 = +Z; the character\'s face-movement models turn to it on arrival; null = none); audioSource ' +
      '{assetId (an audio asset), volume 0-1, range m, distanceModel?: linear|inverse|exponential, refDistance? m (range/4), rolloff? (1)} loops louder as the player comes near (along X), or, with setting audio_spatial 2 (or 0 in a 3D project), through a panner with the listener on the active camera (range = its max distance). ' +
      'Scripts use ctx.signals.emit/on(name), ctx.game.counter/add/health()/setVisible(id, bool), ctx.physics.raycast/overlapBox(center, half)/overlapCircle(center, r) (1,024 queries/step, 2D and 3D together), ctx.emit({kind: "pose", entityId, rotation?: {yaw?, pitch?, roll?} degrees, scale?: n | [x, y, z]}) in the transform phase for an owned entity and ctx.audio.play(audioAssetId, {volume?, loop?, pitch?, bus?: sfx|music|voice|ui, fadeIn?, entityId?, position?, distanceModel?, refDistance?, maxDistance?, rolloff?, owner?: object|scene|none, fadeOut?}) -> handle (a sound belongs to the script\'s object by default and stops, over fadeOut, when it leaves the game: its scene unloads or reloads; owner scene: with the object\'s scene, none: never) (then stop(h, fade?), fade(h, to, s), setVolume/setPitch/setLoop, playing(h), finished(h) the step after it ended; music(id|null, fade?, {owner?})/releaseMusic (scripts win over the flow\'s music until released), stinger(id, {duck?, fade?, owner?}), duck(level, s)/unduck, setBusVolume(bus, v, s), stopAll(bus?, fade?) every sound on a bus or all, returns how many), ctx.save.get/set/remove/keys (kept in the player\'s save), ctx.spawn(prefabId, {position: [x, y] | [x, y, z], rotation?: [x, y, z, w], scale?: n | [x, y, z]}) ' +
      '-> "spawn-<n>" root id or null (a copy of a project prefab in the running game only — its colliders, components and scripts work; it appears at the next step; ' +
      'at most 64 spawns per step and 16,384 spawned entities alive; a new run removes them all; saves never keep them) and ctx.destroy(spawnedId) (removes it and its children; ' +
      'an authored entity throws: hide it with setVisible); a script whose source container lists "@self" in ownedTransforms may move its own entity (each carrier, spawned copies included) with transform/pose intents in the transform phase. ' +
      'ctx.timers.after(name, seconds)/every(name, seconds) (step-counted; calling it again with the same length changes nothing, another length restarts it; ' +
      'at most 64 per script instance; a new run clears them), ctx.timers.fired(name) (true in the step it fires), ctx.timers.cancel(name); ' +
      'ctx.events also holds {type: "enter"|"exit", trigger: entityId, stepIndex} (seen the step after) for the triggers the script owns: on its own entity, below it, ' +
      'or named by one of its entityRef properties. ' +
      'Graphs (node graphs; one op set for every graph kind): setGraph {graph: {graphId, kind, name, graph: {nodes: [], edges: []}}} ' +
      'creates or renames a standalone graph (kind "test" is the framework\'s test kind; the kinds\' node catalogues, port types and conversions are in ' +
      'tl_content_query target="game" includeDescriptors (graphKinds); the graphs themselves in target="game" (graphs)); deleteGraph {graphId}; graphEdit {owner: {kind: "graph", id: graphId}, ' +
      `ops: [...]} applies up to ${GRAPH_LIMITS.ops} ops atomically as ONE undo step: addNodes {nodes: [{id, type, position: [x, y], collapsed?: true, data?: {field: value}}]}, ` +
      'removeNodes {ids} (also removes their edges), moveNodes {moves: [{id, position}]} (nodes, comments or groups), setNodeData {id, data} (replaces the node\'s data; {} = defaults), ' +
      'setCollapsed {ids, collapsed}, connect {edges: [{id, from: {node, port (an output)}, to: {node, port (an input)}, reroutes?: [[x, y]]}]}, disconnect {ids}, ' +
      'setReroutes {id, reroutes}, setGroups {groups: [{id, title, color: #rrggbb, rect: [x, y, w, h]}]} (add or replace), removeGroups {ids}, setComments {comments: [{id, text, ' +
      'position, size?}]}, removeComments {ids}. You choose the ids (1-64 of A-Z a-z 0-9 _ -, unique across the graph\'s nodes, edges, groups and comments). ' +
      'The result must follow the kind: known node types and fields, output → input between compatible port types (same type, "any", or a listed ' +
      'implicit conversion), one edge into an input unless it is multi, one edge out of a single output, fixed nodes kept, no cycles unless the kind allows them, the node budget. ' +
      'Animator controllers are graphs too (owner kind "animator"; the controllers are in tl_content_query target="game" (animators)): owner id "<controllerId>" = the base layer ' +
      '(kind animator), "<controllerId>@<n>" = override layer n (kind animator-layer), "<controllerId>#<stateId>" = a blend tree state\'s clips (kind animator-blend). ' +
      'A layer graph has the fixed nodes ENTRY (its one wire → the entry state) and ANY (Any State), one node per state (id = state id, lower case; type state {clip, asset, ' +
      'duration, name, speed, loop, speedParameter} | blend {parameter, name, speed, loop, speedParameter} | empty (override layers)) and one wire per state pair with ' +
      'transitions (connect adds one transition: exit time 1, crossfade 0.1 s; disconnect removes the pair\'s transitions; conditions and several transitions per pair ' +
      'are edited with setAnimator). A blend tree graph has the fixed OUT node and one clip node {threshold, clip, asset, duration} per child. Such an edit records the ' +
      'same setAnimators change as setAnimator (one undo step). ' +
      'A visual script is owner kind "behavior" (owner id = behaviorId, kind behavior; "<behaviorId>#<functionId>" = one of its functions, kind behavior-function; the change is graphEdit with the ops, one undo step). ' +
      'Visual effects (visual only, never part of the game simulation): setEffect {effect: {effectId, name, duration 0.01-3600 s (one cycle), loop, seed 0-4294967295, ' +
      'bounds: {center: [x, y, z], size: [x, y, z]} (culling box around the origin), parameters?: [{key, type: float|vec3|color, default, min?, max?, visibility?: public|private, label?, group?, tooltip?}], ' +
      `systems: [{systemId, name, maxParticles 1-${EFFECT_LIMITS.maxParticles}, space: local|world, graph}] (up to ${EFFECT_LIMITS.systems}, evaluation order)}} creates or replaces one (adding/removing a system = setEffect); ` +
      'deleteEffect {effectId} (refused while an effect component names it); renameEffect {effectId, name}. A system graph (kind "effect", catalogue in graphKinds) has the fixed ' +
      'context nodes spawn, initialize, update and output (a new system: those four nodes with ids = their types, no edges); each context runs a chain: connect the context\'s "then" ' +
      'output to a block\'s "in", that block\'s "then" to the next block (spawn.rate|burst|distance|event; init.position.point|sphere|box|circle|cone|line|mesh, init.velocity, ' +
      'init.velocity.direction, init.lifetime, init.size, init.color, init.color.gradient, init.rotation, init.mass; update.gravity|drag|wind|vortex|turbulence|attractor, ' +
      'update.collide.plane|depth, update.size.curve, update.color.gradient, update.velocity.curve, update.kill.plane|sphere|box|speed; output.billboard|mesh|ribbon|light); ' +
      'number/vector/colour fields of a block are also inputs of the same id fed by value nodes (value.float|vec3|color|parameter {key}|random|randomVec3|curve|gradient|attribute|time, ' +
      'math.*). Curve fields are [t0, v0, t1, v1, …] (t 0-1 ascending), gradient fields [t, r, g, b, a, …] (0-1). Edit a system graph with graphEdit {owner: {kind: "effect", ' +
      'id: "<effectId>/<systemId>"}, ops}. Objects play one with setComponent "effect" {effectId, playOnStart? (default true), params?: {<public key>: value}, signal? (restarts it), ' +
      'stopSignal? (stops spawning)}. Components may name an effect too (their descriptors\' effect fields); scripts call ctx.effects.play(effectId, {position?, entityId?, params?}) → handle and ctx.effects.stop(handle | entityId). ' +
      'Play and exports draw them (WebGPU compute on WebGPU, the CPU executor on WebGL 2 with lower caps; see tl_diagnostics renderer.effects). The effects are in ' +
      'tl_content_query target="game" (effects). ' +
      'Script libraries (shared TypeScript/JSON modules any script imports as @lib/<libraryId>, e.g. import { rules } from "@lib/combat"): setScriptLibrary {libraryId, name? (required for a new one), ' +
      'files?: [{path, text|null}]} creates a library or patches one (listed files are added or replaced, text null removes one, other files are kept; src/index.ts is what an import names; ' +
      `paths end in .ts or .json; up to ${SCRIPT_LIBRARY_LIMITS.files} files, ${SCRIPT_LIBRARY_LIMITS.fileBytes / 1024} KiB each); a changed library recompiles every published script that imports it in the same command (refused with the compile error ` +
      'naming the script if one no longer compiles, or behavior_trust_unacknowledged {sourceDigest} until acknowledgeBehaviorTrust acknowledges the library\'s new digest); ' +
      'deleteScriptLibrary {libraryId} (refused while a published script imports it). A script may also import .json files of its own source (import data from "./data.json"). ' +
      'Edits larger than one request (the 64 KiB cap) or across several libraries are staged: op stageScriptLibrary {stageId?, libraryId, name?, files?} (no expectedRevision; ' +
      'the setScriptLibrary patch shape, and a file larger than one request comes in pieces: {path, text, append: true} adds to the staged file; without stageId it opens a stage and answers its stageId, the libraries staged and their digests; {stageId, discard: true} drops it) adds ' +
      'one patch at a time without changing the project, then commitScriptLibraryStage {stageId} commits every staged library in one revision and one undo step, recompiling each ' +
      'published script that imports a changed library once (the answer\'s libraryStage.compiled); acknowledge the staged digests first as for setScriptLibrary. ' +
      'Each library is its own shared module in Play and exports (compiled once, minified and tree-shaken; scripts import it instead of carrying a copy). ' +
      'The libraries are in tl_content_query target="game" (scriptLibraries). ' +
      'Block layers (grid levels built from blocks): setBlockType {block: {blockId, name, variants: [{model: {assetId, piece?}} | {prefab} | {color: "#rrggbb"}, weight?, uv?], ' +
      'shape: full|half|ramp|stairs|custom|none (collision; ramps/stairs rise toward +Z), boxes? (custom: [x0,y0,z0,x1,y1,z1] in 0-1), solid?, footprint? [x,y,z] cells, ' +
      'rotations? [0,90,180,270], metadata? {field: value}, materials?, uv? model|world (world: texture coordinates from the layer position in metres, box-mapped per face, so a texture runs across cells; a variant may set its own; absent: the model\'s own), live? (each prefab look spawns its prefab per cell in the game), ' +
      'placement? cell|edge (edge: an edge piece standing on the edge between two cells — wall, door, window, fence; drawn at the edge\'s bottom centre with its +X along the edge and +Z facing across it; shape full|half (a slab across the edge) |custom|none; no footprint; rotations 0|180), blocking? (edge pieces: false lets passage through; an open edge never blocks and has no collider), kits? {kitName: {block, variant?, variants?: [look per own look]}} (what it shows under a kit: another block type of the same placement and footprint; a kit is every type\'s entry under one name)}} / deleteBlockType {blockId}; setCellFields {fields: [{key, type: bool|enum|int|float|string, default?, values? (enum), min?, max?, color?, label?}]} ' +
      '(the cell metadata schema); an entity gets setComponent "blockLayer" {cellSize: [x,y,z] m (x = z: cells are square from above), bounds: {min: [x,y,z], max: [x,y,z]} cells (max exclusive), metadataOnly?, collision?, ' +
      'maxSlope? (degrees: characters do not walk up steeper parts of the layer; surface queries call them not walkable), ' +
      'smoothAngle? (degrees 0-180, the crease angle of the tops: tops meeting at the same height at less than it are shaded smooth across cells and chunk edges, sharper edges stay hard; 0 or absent: flat-shaded), ' +
      'topSubdivision? 1|2 (2: sloped tops drawn cut 2×2 with the inner heights blended from the corners; collision keeps the corners\' two triangles), wallPaint? (true: walls have paint of their own, see editBlocks paint target walls; absent: walls show the top paint above them), ' +
      'cutaway? {regions?: [{region, when?}], planes?: [row], fade? seconds (default 0.25)} (drawing only: a listed region\'s cells are hidden, with a fade, while the camera\'s target stands under it — within its columns, below its lowest row — or, with when, while the target is inside that other region; a plane hides every cell from its row up while the target is below it; scripts force zones with ctx.grid.setCutaway(layer, region or "#row", true|false|null) and name the subject with ctx.grid.setCutawaySubject/setCutawayPoint; collision, queries and shadows are unchanged), ' +
      'kits? [{kit, region?}] (one for the whole layer, one per region at most: its blocks are drawn, collide and spawn as their types\' kit swaps without changing the cells — a dungeon and its burnt state share one layout; a region\'s kit wins where it swaps; scripts change them with ctx.grid.setKit(layer, kit | null, region?), saved with the grid), ' +
      'walk? {from? region, maxStep? m, maxDrop? m, headroom? m, field? (a bool cell field: only tops where it is true are walked), diagonal?} (the defaults of ctx.grid.walkNeighbours/path/reachable — places to stand are block tops with headroom on a walkable slope, steps rise or drop at most maxStep/maxDrop where two tops meet and never cross an edge piece that blocks; absent: half a cell height up and down, one cell height of headroom — and from: the region the Problems check walks from, listing places that cannot be walked to), ' +
      'vertexAO? 0-1 (corner shading: per-vertex ambient occlusion where neighbouring blocks close a corner in, taken from the indirect light; 0 or absent: none), ' +
      'rules? [material rules, layers 0-3, see editTerrain] (painted at every vertex when chunks are meshed, walls and tops by their own slope; the paint\'s unpainted share — a top\'s layer 0, a wall point\'s layer 1 — shows them, hand paint stays over them), ' +
      'scatter? [scatter rules, layers 0-3, see editTerrain] (copies on the highest tops, baked into each chunk\'s scatter by the layer\'s edits; editBlocks {kind: "bakeScatter"} bakes every chunk after the rules changed; {kind: "scatter", rule, at: [x, z, …] columns, radius cells, erase?} is the scatter brush)} ' +
      '(its position is the min corner of cell 0; a root at identity rotation and unit scale). A prop may carry setComponent "blockFootprint" {layer?: layer entity id, size?: [x,z] cells, set: {field: value}} ' +
      '(the metadata the cells beneath it take: any command that places, moves, turns or deletes the prop, or sets this component, writes it into the cells it now stands on and clears it from the cells it left, in the same undo step; ' +
      'its result change lists footprints: [{entityId, chunks, regions}] for the layers written). editBlocks {entityId, edits: [...]} edits one layer as one undo step ' +
      '(its change: chunks, regions, cells changed, and rebased: the columns whose top row moved, when it had surface or sculpt edits) (cells are {block?, rot? 90|180|270, variant?, ' +
      'corners? [h, h, h, h] (a sloped top of a single-cell full block: the corner heights −x−z, +x−z, +x+z, −x+z in cell heights 0-4, steps of 1/64; above 1 reaches into the empty cells above), meta?}; ' +
      'boxes are [x0,y0,z0,x1,y1,z1] max exclusive): {kind:"fill", box, cell|null, mode?: set|keep|replace}, {kind:"cells", at: [x,y,z,...], cell|null}, ' +
      '{kind:"array", origin, size: [w,h,d], palette: [cell|null,...], data: [count, index, ...] run-length, x fastest then z then y, index -1 leaves a cell}, ' +
      '{kind:"replace", match: {block: id|null, rot?, variant?}, cell|null, box?}, {kind:"meta", set: {field: value|null}, box?|at?, occupiedOnly?} (paint metadata; empty cells become metadata-only cells), ' +
      '{kind:"flood", at, cell|null, connectivity?: xz|xyz}, {kind:"column", at: [x,z,...], delta: ±n, cell?} (raise/lower), {kind:"stamp", stampId, at, rot?, mirror?: x|z, mode?}, ' +
      '{kind:"copy", box, to, rot?, mirror?, move?, mode?} (copy/move/mirror a selection), {kind:"region", regionId, op: set|add|remove|delete|rename, boxes?, to?} (named regions), ' +
      '{kind:"heightmap", png: base64 greyscale PNG, origin: [x,z], y, scale (cells for white), cell, keepAbove?, colors?: {png, map: [{color, cell}]}} (import a heightmap; the colour map picks each column\'s cell), ' +
      '{kind:"surface", columns: [x, z, h, h, h, h, ...] (column top corner heights −x−z, +x−z, +x+z, −x+z in rows: 3.25 = a quarter cell over row 3\'s bottom), cell?} (sloped terrain: each column grows or shrinks to its corners), ' +
      `{kind:"sculpt", op: raise|lower|smooth|flatten, at: [x, z] (columns; vertices at whole numbers), radius (${SCULPT_LIMITS.radiusMin}-${SCULPT_LIMITS.radiusMax} cells), strength (raise/lower: cells at the centre; smooth/flatten: blend 0-1), height? (flatten: rows), cell? (grows empty columns)} (a terrain brush dab; the editor sends a stroke as its dabs). ` +
      `{kind:"paint", at: [x, z] (columns), radius (${PAINT_BRUSH_LIMITS.radiusMin}-${PAINT_BRUSH_LIMITS.radiusMax} cells), strength (0-1 per dab at the centre), channel (0-3: a material layer, its weight grows and the others give way; 4: wetness), falloff?: smooth|linear|constant, erase?, target?: tops|walls|both (absent: tops), y? (rows; the brush centre's height, needed for walls)} ` +
      '(the layer\'s surface paint, stored per chunk; a painted layer\'s chunk meshes carry it as COLOR_0 = the four layer weights and COLOR_1.r = wetness, which a graph material reads — e.g. the height-blended layers template on a block type mapped {"*": materialId}; ' +
      'walls: points about 0.5 m apart on exposed wall faces within the radius by 3D distance, drawn when the blockLayer has wallPaint: true — unpainted walls show layer 2, the top\'s paint wraps over the lip and fades one point down). ' +
      '{kind:"edges", at: [x, y, z, axis, ...] (axis 0: the x line x = X, the −x side of cell (x, y, z); 1: the z line, its −z side; one past the bounds along the axis is the far border) | box (every edge on its outline or inside it), edge: {block (an edge piece type), rot? 0|180 (faces −x/−z), variant?, open? (a door: no passage blocked, no collider)} | null, mode?: set|keep} (edge pieces; ctx.grid.edge/blocked/setEdge/setEdgeOpen at run time; tl_content_query target="blocks" box lists them). ' +
      'The change names the chunks [cx,cz] (16×16 columns) and regions touched; read cells back with tl_content_query target="blocks". Keep each request under 64 KiB (use boxes and runs). ' +
      'setBlockStamp {stamp} or {stampId, name, entityId, box} (save a selection) / deleteBlockStamp {stampId}. ' +
      'Project UI (drawn by the game host over the view, in Play and exports): setUiDocument {document: {uiDocumentId, name, layer? (-100..100), modal?, focus? (takes keyboard/gamepad focus; default modal), ' +
      'actionMap? (gameplay|ui: the only input map active while it has focus), theme? (uiThemeId), scale? {reference: [w, h], mode: fit|width|height|cover (fills the view, the box larger than it)|expand (fits, the box grown to the view\'s shape)}, styles? {name: style}, icons? {name: {asset: texture, rect?: [x, y, w, h]}}, ' +
      'tweens? {name: {kind: fade|slide|scale|stamp, duration 0.01-10 s, delay?, easing?: linear|easeIn|easeOut|easeInOut|back, from?, to?, direction?: left|right|up|down, distance?}}, showTween?, hideTween?, initialFocus? (widget id), onCancel? (action), root: widget}} ' +
      `creates or replaces one (whole JSON, ≤ ${UI_LIMITS.documentBytes / 1024} KiB, ≤ ${UI_LIMITS.widgets} widgets, depth ≤ ${UI_LIMITS.depth}); deleteUiDocument {uiDocumentId}; setUiTheme {theme: {uiThemeId, name, styles, icons?}}; deleteUiTheme {uiThemeId}. ` +
      'A widget: {type: panel|stack|grid|text|image|bar|button|list|input, id?, anchor? [0-1, 0-1], pivot?, offset? [x|{bind}, y|{bind}] (px), opacity? 0-1|{bind} (with its children, over the style), rotation? degrees|{bind} (about the pivot; a flowed child its centre), size? [w|null|{bind}, h|null|{bind}] (a bound axis is the px number the view model holds), stretch?: x|y|both, margin? [l, t, r, b], grow?, style?: name|[names], css?: style, ' +
      'visible?/enabled?: bool|{bind}, focusable?, sounds? {click?, hover?, focus?: audio assets played on the ui bus; also on a style (base) and the document (the default)}, nav? {up, down, left, right, next, prev: widget ids}, worldAnchor? {entity: id|{bind} | point: [x, y, z], offset?, clamp?, margin?, indicator?: child id}, onFocus?, children? (panel anchors them; stack direction row|column, gap, align, justify, wrap; grid columns, cellSize), ' +
      'text (rich: [b] [i] [color=#hex] [size=N] [icon=name], {path} values, {action:name} the glyph of an input action), image {image: texture|{bind}, slice? [t, r, b, l], fit?, tint?}, bar {value, min?, max? (numbers or {bind}), direction?: right|left|up|down, shape?: linear|radial, fillColor?, fillStyle?, startAngle? (radial, degrees, 0 = up: a number or {bind})}, ' +
      'button {text?, children?, onClick}, list {items: {bind}, template: widget ($item.x, $index in its bindings), itemKey? (a field of each item: the item keeps its widgets and focus wherever it moves; absent: kept by index), direction?: row|column|grid}, input {value?, placeholder?, maxLength?, onSubmit}}. ' +
      'A style (never raw CSS): color, background, backgroundImage (texture) + slice, opacity, font (a font asset or sans|serif|mono|rounded), fontSize, bold, italic, align, lineHeight, letterSpacing, padding, radius, borderWidth, borderColor, textShadow, shadow, and hover|focus|pressed|disabled variants. ' +
      'An action: {do: "event", name, value?} (a UI event for scripts on the next input frame), {do: "engine", action: resume|pause|reloadScene|loadScene|unloadScene|continue|settings|load|save|back|setSetting|mute|unmute|rebind|cancelRebind|resetBindings|open|nextScene (restartLevel, newGame and quitToTitle are deprecated: they restart the whole run and write a Problems line; a game reloads, loads and unloads scenes and builds its own new game and title), screen? (open: title|pause|settings|controls|save|load), scene? (reloadScene: the scene to reload, absent: the active scene; loadScene/unloadScene: the scene, required), slot?, setting?, value?, step?, input? (rebind/resetBindings: the input action), device?, index?, part?, policy? swap|refuse|allow}, ' +
      '{do: "show"|"hide"|"toggle", doc}, {do: "play", tween, widget?}. Bindings read the scripts\' view model (ctx.ui.set(path, value)); $flow.* reads the host values (the shell screen, volumes, slots, counters, health, prompts). ' +
      'The game shell: setShell {shell: {screens?: {title|pause|settings|controls|save|load: uiDocumentId}, simulate?: {screen: pause (default: no steps) | scripts (the scripts outside behavior groups keep stepping, physics and grouped scripts held)}, hud?: [uiDocumentId], scenes?: [{scene, spawn?}], pause?, status?} | null} draws its menus and HUD with UI documents (save/load use the project saves); HUD bindings read $flow.counters.<name>, $flow.health.<objectId>.current|max, $flow.prompts (generated from the input actions) and $flow.shell (screen, scene, canContinue, saves.<n>.label, note); tl_game_observe reports shell {screen, scene, hud}. Scripts: ctx.ui.set/get/clear, show/hide/isShown, play, focus(doc, widget, index? (the list item)), view() {width, height, aspect, pixelRatio} (also $flow.view), events()/event(name). ' +
      'They are in tl_content_query target="game" (uiDocuments, uiThemes); tl_game_observe reports ui {shown, screen, focus, actionMap}. ' +
      'Text widgets may also take content: {bind} (rich text from the view model) and reveal: number|{bind} (a typewriter); an action {do: "dialogue", input: advance|choose|skip|auto|backlog, value?} is a dialogue input. ' +
      'Dialogue: setDialogue {dialogue: {dialogueId, name, graph?}} creates (graph absent: a Start node) or renames a conversation; its graph is owner kind "dialogue" (owner id = dialogueId, graph kind dialogue) edited with graphEdit: ' +
      'nodes start (fixed), entry {name}, line {speaker (speakerId|$binding|""), expression, text (rich text, {var}/{$binding} values, [pause=0.5]), voice (audio asset), auto: default|on|off}, choice (outputs options → option nodes, none), ' +
      'option {text, condition, effects, once}, branch {condition} (outputs true/false), set {effects}, signal {name, value, wait}, wait {seconds}, jump {dialogue, entry}, end; wires port "next". ' +
      'Conditions: variables, $bindings, numbers, "texts", true/false/null, ! not, * / %, + -, < <= > >=, == !=, && and, || or, seen("nodeId"); effects: "name = value; count += 1; x -= 2". ' +
      'deleteDialogue {dialogueId}; setSpeaker {speaker: {speakerId, name, color? #rrggbb, portraits? {expression: texture}, defaultExpression?, voiceProfile?, blip? (audio), blipEvery?, blipVolume?}}; deleteSpeaker {speakerId}; ' +
      'setDialogueSettings {settings: {textSpeed? (chars/s, 0 instant), autoAdvance?, autoDelay?, duck? (music/SFX level under a voice), backlog?, voiceMaxLateMs? (1000: how late the voice of a line whose file is not ready may still start, else the line plays silent), document? (uiDocumentId; absent: the engine document "tl-dialogue"), theme?} | null}. ' +
      'Scripts: ctx.dialogue.start(id, {entry?, node?, bindings?}), advance, choose, skip, setAuto, resume, stop, current, events, get/set variables, seen, history. ' +
      'Game modes: setModes {modes: [{modeId, name, inputMaps? (gameplay|ui|input.maps names; absent: every map — actions of other maps read as released), camera? (a virtualCamera object, live over priorities while the mode is), ' +
      'ui? (uiDocumentIds shown while active), groups? (behavior groups that tick; absent: all), ungrouped?: tick|pause, pause? (engine pause allowed, default true), pauseScreen? (uiDocumentId drawn while paused; absent: the engine panel), ' +
      `timeScale? (${MODE_LIMITS.timeScaleMin}-${MODE_LIMITS.timeScaleMax}), physics?: run|hold, enter? {blend?: cut|linear|eased, blendTime?, fade? (uiDocumentId shown for fadeTime s), fadeTime?}}]} replaces the whole list (the first is the start mode; ≤ ${MODE_LIMITS.modes}); ` +
      'setBehaviorGroups {groups: [names]}; an object joins a group with setComponent behaviorGroup {group}; setInput input.maps [names] adds project input maps. A UI action {do: "mode", mode} switches from a button. ' +
      'Scripts: ctx.modes.current/previous/is/switch(id, {blend?, blendTime?, fade?, fadeTime?})/events()/entered(id?)/exited(id?)/time() (a switch applies at the next step; enter/exit events in that step); ' +
      'ctx.lifecycle.respawn(spawnId?)/setSpawn/spawnPoint (restart() is deprecated: ctx.scenes.reload(sceneId) puts a scene back as authored - its copies gone, its scripts started over, its sounds stopped; kept objects, ctx.save and counters stay). tl_game_observe reports mode {current, previous, since, pending, pause, inputMaps, timeScale, physics, modes} and paused. ' +
      `Timelines (sequencer, played in the simulation step): setTimeline {timeline: {timelineId, name, duration (s, ≤ ${TIMELINE_LIMITS.duration}), slots? [{name, entity? (default binding)}], markers? [{name, time}], skipAction? (input action), playOnStart?, playOnSignal?, ` +
      `tracks: [{trackId, type, name?, muted?, target? (a slot: transform|animator|activation|material), keys: [{time, …}]}]}} creates or replaces one (≤ ${TIMELINE_LIMITS.bytes / 1024} KiB, ${TIMELINE_LIMITS.tracks} tracks, ${TIMELINE_LIMITS.keys} keys each); deleteTimeline {timelineId}. Track types and key fields: ` +
      'camera {camera: slot | release: true, blend: cut|linear|eased, blendTime, progress: [from, to] (rail), easing} (track end: release|keep, endBlend, endBlendTime); transform {position, rotation (quaternion), scale, easing}; ' +
      'animator {kind: set|trigger|play, name, value, fade, layer}; audio {kind: music|release|stinger|sfx, asset, fade, volume, loop, duration, at: slot} (track releaseMusic); dialogue {dialogue, node, wait}; effect {effect, duration, at, position, params}; ' +
      'activation {active}; signal {name, onSkip: fire|drop}; fade {value 0-1, color, easing}; letterbox {value 0-0.5, easing} (track hold); wait {action, timeout} (stops until the action is pressed); material {value} (track param, material); mode {mode, blend, blendTime} (switches the game mode like ctx.modes.switch; skip applies the last); environment {preset, blendTime}. ' +
      'Easing (linear|step|easeIn|easeOut|easeInOut) shapes the move from the previous key. Scripts: ctx.timeline.play(id, {slot: entityId}) → handle, pause/resume/stop/skip (every track\'s end state)/seek, state/time/isPlaying, events() (started, ended, marker; next step), ended(h), marker(name). ' +
      'They are in tl_content_query target="game" (timelines); tl_game_observe reports timeline {screen {fade, opacity, letterbox}, playing, events}. ' +
      'Returns the new revision on success, ' +
      'or a structured error (e.g. revision_conflict with currentRevision). Read-only queries use ' +
      'tl_inspect/tl_content_query, not this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...MUTATION_OPS, 'stageScriptLibrary'] },
        args: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'required for every op but stageScriptLibrary (which changes no revision)' },
        requestId: { type: 'string', pattern: '^req-[0-9a-f]{32}$' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_content_query',
    description:
      `Bounded, read-only content queries. target="assets" pages the asset catalog (limit ≤ ${CONTENT_ASSETS_LIMIT_MAX}, default ${CONTENT_ASSETS_LIMIT_DEFAULT}); ` +
      'target="asset" returns one record with assetId (includeVersions optional); target="prefabs" pages prefab ' +
      'summaries (includeEntities optional); target="behaviors" pages behavior summaries (includeDeclaration ' +
      'optional); target="integrity" returns the bounded content-integrity report (each asset\'s file in the game folder is ' +
      'ok / changed / missing); with check=true the backend first brings the catalog in step with the game folder, as the editor\'s ' +
      '"check files" does (a file moved together with its .tlasset sidecar keeps its asset, a changed file is imported again, the ' +
      'import cache is made whole; the changes are ordinary undoable commands) and returns what it did as `check`; it checks the resource and scene files too ' +
      '(check.resources: a file moved outside the editor is followed, one added or copied comes in — a copy gets a new id from its file name, a copied scene\'s objects new ids — ' +
      'a changed resource file is reloaded and a removed one leaves the project, all in one undoable importResources; a changed or removed scene file, a resource file that no longer ' +
      'reads or validates, or one removed while something uses it pauses the project on that file as an external change does); the report pages with limit and offset ' +
      '(total and nextCursor), and problems=true keeps only the entries that are not ok; target="game" returns the ' +
      'full normalized `content.game` block (the v3 `queryGameConfig`, or null; includeDescriptors adds the ' +
      'component and content descriptor registry: every field\'s type, unit, range, default, label, tooltip and ' +
      'Scene handle, ~120 KB); target="projectFiles" lists one ' +
      'folder of the game folder (dir relative to the folder holding thirdlight.json; subfolders and .glb/.fbx/.wav/.ogg/.opus/.mp3/.flac/.png/… ' +
      'files) for tl_content_upload projectPath; target="blocks" reads block layers: without entityId the layers ' +
      '(component, cell count, chunks, regions; sceneId optional), with entityId one layer — chunks [[cx,cz],…] in their stored ' +
      'form, box [x0,y0,z0,x1,y1,z1] its cells as [x,y,z,paletteIndex] with each value\'s effective metadata, or region (its ' +
      'boxes and cells). target="terrain" reads terrains: without entityId each terrain (tileSamples, spacing, heightRange, tiles, tilesWithData, ' +
      'storedBytes, memoryBytes = what its tiles take decoded in a game; sceneId optional), with entityId one terrain with tileRows [{x, z, data, storedBytes, memoryBytes}] and, ' +
      'with points [[x, z], …] (world, up to 1024), the surface there {height, normal, slope, layers, weights, hole} (height null: off the terrain or a hole), with scatter {box?} its stored scatter copies. target="surface" reads the ground at points [[x, z] (the top) or [x, y, z] (at or below), …] (sceneId optional: absent, every scene) from whichever block layer or terrain is there, ' +
      'as a game\'s ctx.surface reads it: {source: blocks|terrain, object, height, point, normal, slope, layers, weights (0-1, strongest first), wetness, cell?, block?} or null. target="materials" pages the materials {materialId, name, graph, problems: [{nodeId?, severity, message}]} - ' +
      'a graph material\'s compile problems as the editor\'s Problems tab shows them, checked by the backend when it loads the project and after every change ' +
      '(materialId: one; withProblems: only broken ones; total, withProblems counts). target="index" pages the project index: every asset, ' +
      'resource (prefab, material, behavior, library, graph, ui, uitheme, dialogue, timeline, effect, animator, envpreset — each its own file in the game folder) and scene ' +
      'as {kind, id, path, name, labels, address?, refs} (kind, id, label, address filter; loadable: true = only those with an address or a label; ' +
      'referencing: what names that id; text: a part of the name, id or file, any case; labels: [every one]; folder: "assets/props" the entries whose file is in that ' +
      'folder of the game folder ("" its top), recursive: true also in its subfolders; sort: name|kind|path, descending; folders: true adds folders: [{path, name, hasFolders}] ' +
      'the subfolders of folder). Never returns bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['assets', 'asset', 'prefabs', 'behaviors', 'integrity', 'game', 'projectFiles', 'blocks', 'materials', 'index', 'terrain', 'surface'] },
        kind: { type: 'string', description: 'target="index": one kind (an asset kind, a resource kind such as prefab or material, or scene)' },
        id: { type: 'string', description: 'target="index": one id' },
        label: { type: 'string', description: 'target="index": only entries with this label' },
        address: { type: 'string', description: 'target="index": the entry with this address' },
        loadable: { type: 'boolean', description: 'target="index": true = only entries with an address or a label (what scripts may load by name); false = only those without' },
        referencing: { type: 'string', description: 'target="index": only the entries that reference this id (what uses it)' },
        text: { type: 'string', description: 'target="index": only the entries whose name, id or file contains this text (any case)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'target="index": only entries with every one of these labels' },
        folder: { type: 'string', description: 'target="index": only entries whose file is in this folder of the game folder ("" its top)' },
        recursive: { type: 'boolean', description: 'target="index": with folder, its subfolders too' },
        folders: { type: 'boolean', description: 'target="index": also list the subfolders of folder (the folder tree)' },
        sort: { type: 'string', enum: ['name', 'kind', 'path'], description: 'target="index": the order (default kind:id)' },
        descending: { type: 'boolean', description: 'target="index": the other way' },
        materialId: { type: 'string', description: 'target="materials": one material' },
        check: { type: 'boolean', description: 'target="integrity": check the game folder first (moved files, changed files imported again)' },
        problems: { type: 'boolean', description: 'target="integrity": only the entries that are not ok (limit and offset page them; total counts them)' },
        withProblems: { type: 'boolean', description: 'target="materials": only materials whose graph has problems' },
        sceneId: { type: 'string', description: 'target="blocks" / "terrain": the scene whose layers or terrains are listed; target="surface": the scene asked (absent: every scene)' },
        entityId: { type: 'string', description: 'target="blocks": one block layer (the entity carrying blockLayer); target="terrain": one terrain' },
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'target="terrain": [[x, z], …] world points to read the surface at; target="surface": [[x, z] | [x, y, z], …]' },
        scatter: { type: 'object', description: 'target="terrain" with entityId: {box?: [x0, z0, x1, z1]} — its stored scatter per rule (copies, added, erased), and with a box the copies in it {rule, x, y, z, cell} (cell: the copy\'s address, kept through every bake)' },
        chunks: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, description: 'target="blocks": [[cx, cz], …] chunks to read' },
        box: { type: 'array', items: { type: 'integer' }, description: 'target="blocks": [x0, y0, z0, x1, y1, z1] cells to read' },
        region: { type: 'string', description: 'target="blocks": a region id of the layer' },
        dir: { type: 'string', description: 'target="projectFiles": a folder relative to the game folder ("" = the game folder)' },
        assetId: { type: 'string' },
        prefabId: { type: 'string' },
        behaviorId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: CONTENT_ASSETS_LIMIT_MAX },
        offset: { type: 'integer', minimum: 0 },
        includeVersions: { type: 'boolean' },
        includeEntities: { type: 'boolean' },
        includeDeclaration: { type: 'boolean' },
        includeDescriptors: { type: 'boolean', description: 'target="game": also return the descriptor registry' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_content_upload',
    description:
      'Stage and inspect a source file over the real backend content routes (no filesystem bypass): creates a ' +
      'bounded upload stage, uploads ≤ 1 MiB frames, and returns the bounded import proposal (or the structured ' +
      `import_rejected error carrying the ordered diagnostics). dataBase64 ≤ ${CONTENT_STAGE_MAX / 1_048_576} MiB decoded. The command that ` +
      'commits the content is submitted separately with tl_command (publishAsset), so dedup precedes any stage lookup. ' +
      'Every imported file is kept in the game folder next to a .tlasset sidecar (the asset\'s id, kind, import settings): uploaded bytes ' +
      'are written to assets/<name>.<ext> when publishAsset commits them (the change records the path). projectPath instead inspects a ' +
      'file already in the game folder where it is (nothing is copied): the result carries sourcePath, which the publishAsset args must ' +
      'include. Give exactly one of dataBase64 or projectPath. An FBX (either way) is converted to GLB by Blender on ' +
      'the server first: the result then carries convertedFrom (not sourcePath), which the publishAsset args must include; the GLB is kept ' +
      'in the import cache (git-ignored, made again from the FBX when missing). ' +
      'kind "texture" takes a PNG, JPEG, WebP or a Basis Universal KTX2 (ETC1S/UASTC with its mips; a 2D array is a texture array); ktx2 "color"|"normal"|"data" is an ' +
      'import setting of a PNG/JPEG/WebP: the image is the file, the KTX2 encoded from it is kept in the import cache. ' +
      'pack (instead of dataBase64/projectPath) makes a KTX2 texture from texture assets already in the project (PNG/JPEG/WebP/KTX2), channel by channel — ' +
      'several layers make a texture array (graph materials sample a layer: Sample texture / Normal map / Triplanar "layer"); layers that are each a whole UASTC KTX2 of one size and mip count are joined as stored (joined: true), ' +
      'otherwise a KTX2 is transcoded (or its lossless PNG read) and the layers encoded once, packedFrom.reencoded[i] true where layer i was encoded again from a lossy KTX2; the result carries packedFrom, which the publishAsset args (kind "texture") must include. ' +
      `kind "font" inspects a TrueType (.ttf), OpenType (.otf), WOFF2 or WOFF font (<= 4 MiB) for the project UI; publish it with kind "font". ` +
      'jobExport imports an asset tool\'s job export: a folder or a .zip holding a GLB and manifest.json {name, files: [{path, role, digest (sha256 hex)}], triangles?, lods?} ' +
      '(exactly one file with role "model", a .glb; every listed file is checked against its digest; other roles are checked, not imported). jobExport {path} names a folder or .zip in the game folder; ' +
      'jobExport {} with dataBase64 uploads a zip, whose listed files are written into a new assets/<name>/ folder. The result is the model\'s proposal (plus sourcePath: include it in the publishAsset args) and jobExport {name, files, triangles?, lods?, inspected {triangles}, warnings}; commit with publishAsset kind "model". ' +
      'writeTo "assets/voice/line-001.ogg" with dataBase64 writes the file into the game folder at that path instead of inspecting it (its folders are made; never over another file, ' +
      'never into a hidden folder or the project\'s own files): upload a folder file by file this way, then import it with tl_command importAssets {folder}.',
    inputSchema: {
      type: 'object',
      properties: {
        dataBase64: { type: 'string', description: `base64 of the source bytes (≤ ${CONTENT_STAGE_MAX / 1_048_576} MiB decoded)` },
        writeTo: { type: 'string', description: 'with dataBase64: write the file into the game folder at this path (relative, forward slashes), e.g. assets/voice/line-001.ogg; nothing is inspected or imported' },
        projectPath: {
          type: 'string',
          description: 'a .glb/.fbx/.wav/.ogg/.opus/.mp3/.flac/.png/.jpg/.webp/.ktx2/… file relative to the game folder (the folder holding thirdlight.json), forward slashes, e.g. assets/props/crate.glb',
        },
        displayName: { type: 'string' },
        kind: { type: 'string', enum: ['model', 'audio', 'texture', 'font'], description: 'audio: any Ogg Vorbis/Opus, MP3, WAV or FLAC file of any length' },
        ktx2: {
          type: 'string',
          enum: ['color', 'normal', 'data'],
          description:
            'kind "texture" only: encode a PNG/JPEG/WebP to KTX2 (Basis Universal, with mipmaps) on the server — "color" (ETC1S, sRGB: albedo, emissive), ' +
            '"normal" (UASTC, linear: normal maps) or "data" (UASTC, linear, channels kept apart: masks, heights, packed occlusion/roughness/metalness). The result carries convertedFrom (the original), which the publishAsset args must include.',
        },
        pack: {
          type: 'object',
          description:
            'Pack a KTX2 texture (a texture array with several layers) from texture assets of the project: layers = per layer its [R, G, B, A] sources, each ' +
            '{assetId, channel: "r"|"g"|"b"|"a"} (a PNG/JPEG texture asset, its current version) or {value: 0-255}; all sources one size; at most 12 Mpix across the layers ' +
            '(e.g. 4 layers of 1024²). encoding as ktx2. E.g. terrain: albedo RGB + height in A ("color"), normals ("normal"), occlusion/roughness/metalness ("data").',
          properties: {
            layers: { type: 'array', items: { type: 'array', items: { type: 'object' } } },
            encoding: { type: 'string', enum: ['color', 'normal', 'data'] },
          },
          required: ['layers', 'encoding'],
          additionalProperties: false,
        },
        jobExport: {
          type: 'object',
          description: 'an asset tool\'s job export: {path} a folder or .zip relative to the game folder, or {} with dataBase64 of a zip',
          properties: { path: { type: 'string' } },
          additionalProperties: false,
        },
        animation: {
          type: 'object',
          description: 'request the role-aware animated GLB profile (idle, run and airborne clips named by role)',
          properties: {
            entityId: { type: 'string' },
            roles: { type: 'object' },
          },
          required: ['roles'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_content_job',
    description:
      'Read one bounded content job by its jobId (a bounded uploaded/inspected job record). Unknown jobs are ' +
      'job_not_found (404); an expired/late job is job_expired (503) and its result is never applied.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', pattern: '^job-[0-9a-f]{32}$' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_input_exercise',
    description:
      'Run a bounded, step-indexed semantic action sequence against an explicitly presented play session in ' +
      'exclusive test-input mode (physical input is suppressed and cleared; it clears on completion/stop/disconnect). ' +
      `frames ≤ ${INPUT_RELAY_MAX_FRAMES} ascending by stepOffset, body ≤ ${INPUT_RELAY_MAX_BODY_BYTES / 1024} KiB; each frame {stepOffset, steps?, actions?, pointer?, gamepad?, ui?} (input frame version 2: ` +
      'no fixed move/jump channels). Gaps are neutral: a step no frame covers has no action, no pad and no new pointer sample. ' +
      `steps (run length, 1-${INPUT_RELAY_MAX_STEPS}): the frame holds for that many steps - its first step as written, the rest its continuation ` +
      '(pressed becomes held, released none; the pointer keeps its place and held buttons without movement, wheel or edges; ui only on the first step); ' +
      `frames must not overlap and the last frame ends by step ${INPUT_RELAY_MAX_STEPS} (60 s at 120 Hz). ` +
      'actions {<action name>: {v, x?, y?, p: none|pressed|held|released}} - the character ' +
      'controller reads its move and jump actions (default names move and jump: move {v: -1..1} walks along x, or {v, x, y} ' +
      'for a 2D move where a 3D character walks along (x, y) relative to the camera; jump {v: 0|1, p}), scripts read any action ' +
      'with ctx.input; an action absent from a frame is released. Optional pointer: {x, y (0-1 of the view, 0,0 top left), dx?, dy?, wheel?, buttons?, pressed?, released? ' +
      '(masks: 1 left, 2 right, 4 middle), over?, locked?} (a frame without one keeps the last position and held buttons; a button ' +
      'going down between frames is a click - ctx.input.pointerPressed, ctx.physics.pickAtPointer). The pointer goes through the UI hit test first: ' +
      'over a project UI element (a button, an input, a modal backdrop, the engine pause panel - tl_game_observe ui.elements lists their rectangles) ' +
      'the game reads ctx.input.pointer().overUi true and does not see that press; a left press and release on one button clicks it (its UI event rides the next frame). ' +
      'gamepad: a virtual standard gamepad {buttons: [0-1 by standard index: 0 A, 1 B, 9 start, 12-15 D-pad up/down/left/right; down at 0.5], axes: [left x, left y, right x, right y] -1..1} ' +
      'read through the project\'s input bindings like a real pad (its move/jump and every action bound to pad buttons or axes; its D-pad, A, B and start also drive menus); ' +
      `a frame without one: the pad at rest; explicit actions win over the pad's. ui: 1-${RELAY_MAX_UI_EDGES} of ${RELAY_UI_EDGES.join('|')} - ` +
      'menu edges on the frame\'s first step, as the keys: they move the focused UI document\'s focus, submit/cancel it, and pause (a game shell or a game mode). ' +
      'restart: true restarts the game first (the replay: start scenes, every object as authored) and the frames begin at the new run\'s first step - ' +
      'run the same frames with restart twice and compare tl_game_observe run.lastInput.digest (the run digest right after the last applied step) to check a run against its replay. ' +
      'hold: true holds the game right after the last step (run.lastInput.held) until the next exercise, which begins at exactly the next step - ' +
      'observe, decide and go on step-exactly whatever the time between calls (tl_game_control debugResume lets it go too). Returns the applied ' +
      'step range plus the pinned snapshotId/buildId, or the structured session_unavailable outcome when no browser is ' +
      'connected (never a simulated success). No DOM injection, no eval.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        frames: {
          type: 'array',
          minItems: 1,
          maxItems: INPUT_RELAY_MAX_FRAMES,
          items: {
            type: 'object',
            properties: {
              stepOffset: { type: 'integer', minimum: 0, maximum: INPUT_RELAY_MAX_STEPS - 1 },
              steps: { type: 'integer', minimum: 1, maximum: INPUT_RELAY_MAX_STEPS, description: 'the frame holds for this many steps (run length; absent 1)' },
              gamepad: {
                type: 'object',
                description: 'a virtual standard gamepad this frame (absent: at rest)',
                properties: {
                  buttons: { type: 'array', maxItems: RELAY_GAMEPAD_BUTTONS, items: { type: 'number', minimum: 0, maximum: 1 } },
                  axes: { type: 'array', maxItems: RELAY_GAMEPAD_AXES, items: { type: 'number', minimum: -1, maximum: 1 } },
                },
                additionalProperties: false,
              },
              ui: { type: 'array', minItems: 1, maxItems: RELAY_MAX_UI_EDGES, items: { type: 'string', enum: [...RELAY_UI_EDGES] }, description: 'menu edges on the frame\'s first step' },
              actions: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: { v: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, p: { type: 'string', enum: ['none', 'pressed', 'held', 'released'] } },
                  required: ['v', 'p'],
                  additionalProperties: false,
                },
              },
              pointer: {
                type: 'object',
                description: 'the pointer this step (a frame without one keeps the last position and held buttons)',
                properties: {
                  x: { type: 'number', minimum: 0, maximum: 1 },
                  y: { type: 'number', minimum: 0, maximum: 1 },
                  dx: { type: 'number', minimum: -10, maximum: 10 },
                  dy: { type: 'number', minimum: -10, maximum: 10 },
                  wheel: { type: 'number', minimum: -10, maximum: 10 },
                  buttons: { type: 'integer', minimum: 0, maximum: 7 },
                  pressed: { type: 'integer', minimum: 0, maximum: 7 },
                  released: { type: 'integer', minimum: 0, maximum: 7 },
                  over: { type: 'boolean' },
                  locked: { type: 'boolean' },
                },
                required: ['x', 'y'],
                additionalProperties: false,
              },
            },
            required: ['stepOffset'],
            additionalProperties: false,
          },
        },
        restart: { type: 'boolean', description: 'restart the game first; the frames begin at the new run\'s first step' },
        hold: { type: 'boolean', description: 'hold the game right after the last step until the next exercise, which then begins at exactly the next step (lockstep)' },
      },
      required: ['playSessionId', 'frames'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_instance_buffer',
    description:
      'Publish an instance-set buffer: the placements of many copies of one model, drawn with ' +
      'instancing as ONE entity (foliage, rocks, repeated detail). transforms is a flat list of 10 numbers per copy ' +
      `(position x y z, rotation quaternion x y z w, scale x y z; local to the entity), 1-${INSTANCE_BUFFER_INLINE_MAX} copies. Returns ` +
      '{digest, count}; then create the entity with tl_command createEntity {kind:"group", components:{instances:' +
      '{asset:{assetId}, buffer:digest, count}}} or setComponent "instances". Publishing changes no project state. ' +
      'Give digest instead (an instance set\'s buffer) to READ its copies ({digest, count, transforms}; sets of up to ' +
      `${INSTANCE_BUFFER_INLINE_MAX} copies) - to move, turn, scale, delete or add single copies, edit that list, publish it and setComponent "instances" ` +
      '{buffer, count} (one undo step; the editor\'s copy editing does exactly this; to paint or erase many copies on a surface use tl_command paintInstances).',
    inputSchema: {
      type: 'object',
      properties: {
        transforms: { type: 'array', items: { type: 'number' }, minItems: INSTANCE_FLOATS, maxItems: INSTANCE_BUFFER_INLINE_MAX * INSTANCE_FLOATS },
        digest: { type: 'string', description: 'read this buffer (64 hex) instead of publishing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_control',
    description:
      'Submit one bounded game-control command (replay (restart the game: the start scenes, every object as authored), mute, unmute, clearSave (forget the game\'s saves in this browser), or loadScene / unloadScene with ' +
      'sceneId - the same request a script makes with ctx.scenes; debugPause / debugResume / debugStep hold the simulation at a step boundary, ' +
      'release it, or run exactly one step while held - the visual-script debugger; tl_game_observe shows debug {paused, hit {behaviorId, entityId, nodeId, stepIndex}}; ' +
      'debugCommand with name and args runs a project debug command - one a script declared with ctx.debug.command(name, {description, args: [{name, type: number|string|boolean, optional}]}, handler?) - ' +
      'inside the next simulation step as part of its input (a recording replays it; tl_game_observe lists debugCommands {registered, applied [{stepIndex, name, args}]}); ' +
      'refused (game_command_invalid) when no script declared it or the args do not match); ' +
      'setQuality with level draws the play at that quality level from now on (one of the project\'s environment.qualityLevels ids, else low | medium | high) to compare levels in one session - presentation only (not the simulation\'s input, not the player\'s saved setting); refused (game_command_invalid) when the project has no such level; tl_diagnostics renderer.quality {level, levels, source, pixelRatioCap, shadowMapSize, localLights, shadowedLights, lodBias, keyShadowMapSize}, renderer.render {ambientOcclusion, renderScale, …} and renderer.environment {passes, samples} show what it draws; ' +
      '{signal: name} (command signal) emits a signal as a script\'s ctx.signals.emit would - switches, movers, timelines, effects, event sounds and scripts see it in the step the call rides on - sent as the engine\'s signal debug command (input of the next step: a recording replays it; debugCommands.applied lists it); signals carry no value, so value is refused; ' +
      'all go to an explicitly presented play ' +
      'session. expectedRunId is an optional optimistic guard (<snapshotId>#<replayEpoch>); a mismatch is refused ' +
      'with game_run_stale and no command is applied. The result is the preview\'s exact accepted result (identity ' +
      'tuple + play state running|paused); replay restarts the game and answers once the restart is applied: runId is then the new run ' +
      '(<snapshotId>#<replayEpoch>, the epoch counting the restarts of this play, a script\'s too) and restart {state: applied, atStep (the step the new run began at)}; ' +
      'when the game takes no step in time (paused, held by the debugger, a busy page) it answers restart {state: pending} with the runId the restarted run will have - the restart still applies at the next step (tl_game_observe runId shows it); with no connected/presenting browser the contracted session_unavailable is returned - ' +
      'never a fabricated success. Body <= 4 KiB; no gameplay simulation, no eval.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        command: { type: 'string', enum: [...TOOL_CONTROL_COMMANDS], description: 'absent with signal: signal' },
        signal: { type: 'string', description: 'signal: the signal to emit (1-64 characters)' },
        expectedRunId: { type: 'string' },
        sceneId: { type: 'string', description: 'loadScene / unloadScene: the scene' },
        name: { type: 'string', description: 'debugCommand: the debug command a script declared' },
        args: { type: 'object', description: 'debugCommand: its arguments by name (numbers, text up to 256 characters, true/false; at most 8)', additionalProperties: { type: ['number', 'string', 'boolean'] } },
        level: { type: 'string', description: 'setQuality: the quality level id' },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_observe',
    description:
      `Read one bounded observation document (<= ${GAME_OBSERVATION_MAX_BYTES / 1024} KiB) from an explicitly presented play ` +
      'session: `state` running|paused (the engine pause holds the simulation: a menu, the pause panel, a game mode), stepIndex, simTime, `player` {x, y, z} (the controller object\'s position; the first one\'s when there are several), `players` [{id, x, y, z}] (a game with several player controllers, local co-op: each one, in order), ' +
      '`scenes` {loaded, loading}; the observation is bounded and carries no ' +
      'GLB/WAV bytes, base64 media, authoring token or locator capability; `animators` maps each animated entity to its ' +
      'current animator state; `counters` the named counters (collectibles and scripts add to them); `health` every object\'s health {objectId: {current, max}}; `shell` {screen, scene, hud} the game shell; `spawned` {count, ids (first 64)} the live entities scripts spawned; `audio` (once scripts used ctx.audio or a panned audio source plays; the Web Audio graph state, not heard sound) voices [{handle (0: an audio source, see key), assetId, bus, state playing|pending|stopping, loop, gain, rate, pan? (-1 left..1 right of the listener), distanceGain?, distance?, position?}] (first 24; voiceCount all), music {owner script|shell, assetId, playing, duck}, buses {sfx, music, voice, ui}, listener {position, rotation} (the active camera), panningModel, late {started, dropped, recent: [{handle, assetId, outcome started|dropped, lateMs, maxLateMs, waitedFor? file|unlock}]} (script sounds whose file was not ready when played: started late, or dropped past their maxLateMs); with entityId, `behaviors` {entityId, scripts: [{behaviorId, properties: [{key, label, type, visibility, value}]}]} — the values the entity\'s running scripts read, private ones included (read-only); `renderer` {requested, source, backend, api, state, reason} the renderer backend that draws the play and why; `effects` {executor: webgpu|cpu, caps {particlesPerSystem, particlesTotal, instances, lights, sortLimit}, playing, particles, refused, lights} the visual-effect player (WebGPU compute on WebGPU, the CPU fallback on WebGL 2; presentation only); `simulation` {mode: worker|single, transport: message|shared|null, isolated} where the play runs its simulation; `saves` (a project with a save schema) {slotCount, storage, slots: [{slot, title, chapter, location, playSeconds, savedAt, version, bytes, thumbnail? {type, width, height, bytes}, damaged?}] (the first 32 used slots), settings (the project settings document)}; `run` {stepIndex, runStep (steps since this run began: the start or the last restart), digest (the run digest now: transforms, counters, hidden and switched-off objects, script-written fields, looks, poses, loaded scenes and spawned copies, the camera, the UI model, materials, environment, mode), lastInput? {fromStep, toStep, runStep, digest, restarted, held? (the game holds there: an exercise with hold)} (the run digest right after the last tl_input_exercise\'s last step)} - the same input after a restart gives the same lastInput digest at the same runStep; `pointer` {x, y, buttons, over, locked, overUi?} the pointer the simulation read last (overUi: over a UI element); `ui` (a project with UI documents) {shown, screen, hud?, focus, actionMap, values|valueKeys, elements: [{doc, widget, type, index?, rect: [x, y, w, h] (fractions of the view, 0,0 top left), hit? (a pointer press there goes to the UI: buttons, inputs), disabled?, focused?}] (the shown widgets with an id or that take the pointer, first 48 within 4 KiB) - aim tl_input_exercise pointer clicks at a rect\'s centre}; `resources` {resident: {kind: {count, bytes}} (kinds bytes, model, texture, clip, audio (decoded), audio-bytes (kept compressed, decoded per play), audio-stream (streams playing), font, image, effect-model: what is loaded from assets now, freed when the last scene, object or sound holding it goes), loading, loads {kind: n}, frees {kind: n}, failed, waiting (let go, freed after this frame), handles (script asset handles open: ctx.assets.load until ctx.assets.release), open? [{handle, key, state loading|ready|failed, assets, error? (why it failed)}] (first 32), notReleased? [same] + notReleasedCount (handles a run ended with, e.g. a restart: released then; not releasing a handle keeps its assets in memory), textures? {budgetBytes, residentBytes (streamed textures, each GPU copy, plus fixedBytes: the textures that do not stream), streamedBytes, fixedBytes (incl. the images inside model files), embedded? {count, bytes, resources, largest: [{kind, key, count, bytes}]} (images inside model files; a model\'s own resident.model.textures), over, loading, upgrades, drops, textures: [{id, width, height, levels, tail, resident (the largest mip level held, 0 = full size), wanted (the level its size on screen asks for), copies, bytes}]} (texture streaming)}. timeoutMs 250-15000 (default 5000). ' +
      'With no connected/presenting browser the contracted session_unavailable is returned; a relay that exceeds ' +
      'timeoutMs is game_relay_timeout (503) - never a simulated value. A play that ended answers play_not_found with ended {reason, presented, at, detail?} and a message saying why (e.g. it ended before it was presented because the editor page reloaded).',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: GAME_OBSERVE_TIMEOUT_MIN_MS, maximum: GAME_OBSERVE_TIMEOUT_MAX_MS },
        entityId: { type: 'string', description: 'also return this entity\'s running script property values (public and private) as `behaviors`, and with an animator its pose as `animator` {state, clips [{assetId, clip, time (s), weight}], layers?, look? {yaw, pitch (degrees), bones}} and its model\'s bones as drawn as `renderedBones` {name: {position, rotation}}' },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_sessions',
    description: 'List the (bounded) authoring sessions for the project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tl_play_start',
    description:
      'Start a play session for the project from the current revision. Requires a connected editor ' +
      'browser (an active authoring session); with none, the backend opens a headless editor (else session_unavailable). ' +
      'Pass sessionId (from tl_sessions) to require a specific browser session. Returns ' +
      'playSessionId + the frozen snapshotId/revision on success. Test/debug starts (the editor\'s "Play from..." sends the same): ' +
      'sceneId - start there (the scene loads with the start scenes and the character starts at its first player spawn); ' +
      `variables - {key: JSON value} the scripts read with ctx.save from step 0 (<= ${PLAY_START_VARIABLES_MAX} keys, <= ${PLAY_START_VARIABLE_MAX_CHARS} characters each); ` +
      'save - a project save document {format: "thirdlight.save", formatVersion: 2, version, playSeconds?, doc, sections?, world?: {scenes, activeSpawn, listedScene, character: {position, velocity, facing?} | null}} (a project with a save schema; <= 1 MiB; loaded at the first step, older versions migrated; world puts the game back at the saved scenes and where the character stood when the game keeps it: world in the save schema sections, or the deprecated default without legacyWorld: false; a document without world still loads) or saveSlot 1-99 (a project slot of the Play page); ' +
      'mode - the game mode the run starts in (checked against content.modes; ignored and noted in start.notes when the project has none). ' +
      'Variables apply at the start and again at every restart (replay, a shell\'s new game). threads - worker|single: where this play\'s simulation runs. ' +
      'The result echoes the resolved start; tl_game_observe reports start {ok, applied | reason}. ' +
      'Before building, the file check imports again every asset file changed on disk (as Unity refreshes before Play, without asking); the result\'s check is that check\'s report ' +
      '(as the file check\'s check): check.reimported [{assetId, file, version, reason file_changed|converted_again, oldDigest, newDigest}], check.failed, check.rebuilt; ' +
      'each re-import is also a Problems line (code asset_reimported, tl_diagnostics). ' +
      'A missing asset file a start scene draws refuses the start, naming every missing file at once in error.missingFiles [{assetId, kind, path, inStart, code}]; ' +
      'missing files no start scene draws are stood in for (magenta box, checker texture, silence) and listed in the result\'s placeholders.',
    inputSchema: {
      type: 'object',
      properties: {
        demo: { type: 'boolean' },
        sessionId: { type: 'string', pattern: '^sess-[0-9a-f]{32}$' },
        sceneId: { type: 'string', description: 'start Play at this scene' },
        mode: { type: 'string', description: 'a game mode id (applies once the project has game modes)' },
        variables: { type: 'object', description: 'script variables: what ctx.save holds from step 0' },
        save: { type: 'object', description: 'a project save document (format "thirdlight.save") to continue from' },
        saveSlot: { type: 'string', pattern: '^[1-9][0-9]?$', description: `continue from this project save slot of the Play page (1-${SAVE_LIMITS.slots})` },
        threads: { type: 'string', enum: ['worker', 'single'], description: 'where this play\'s simulation runs (a worker or the page\'s main thread), over the project setting sim_thread' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_play_stop',
    description: 'Stop an active play session by its playSessionId.',
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_diagnostics',
    description:
      'Without playSessionId: the project\'s recent problems (failed commands, import/compile/Play/' +
      'export failures, external file edits, a material whose graph has new problems, code material_graph_problems; asset files found missing or back, codes asset_files_missing / asset_files_found; ' +
      'assets a file check imported again with old and new digests, code asset_reimported; placeholders a Play stood in, code play_placeholders; a project upgraded on open, code project_upgraded) and whether editing is paused, ' +
      'plus materialProblems [{materialId, name, problems: [{nodeId?, severity, message}]}] - the graph materials that have problems now (the backend compiles them at load and after each change), ' +
      'and missingFiles {total, offset, files: [{assetId, displayName, kind, path, usedBy: [{kind scene|prefab|material|effect|animator|asset|project, id}]}]} - the asset files missing from the game folder now (listed at the first read and after each file check; ' +
      'the first page here, every page from GET problems/missing-files). A Play refused for missing files names every one in error.missingFiles [{assetId, kind, path, inStart, code}]; ' +
      'a Play whose missing files no start scene draws starts with placeholders (magenta box, checker texture, silence) listed in its result\'s placeholders. With playSessionId: bounded ' +
      'runtime diagnostics (≤ 16 KiB; a longer report drops its oldest log entries first, then the oldest of other lists, and says so in trimmed {logEntries, lists, omitted}) from that play\'s connected preview; its renderer block names the backend ' +
      'that draws (renderer.backend legacy|webgpu|webgl2, renderer.state) and why (renderer.reason); renderer.effects is the ' +
      'visual-effect player: executor webgpu|cpu with its caps, what plays, refused plays, unknown effect ids, per-effect executor and why an effect runs on the CPU on WebGPU. ' +
      'startTimings is where the start went (stages in ms from the page\'s time origin, the first frame, slow frames after it, each scene loaded since) and buildTimings the backend\'s part. ' +
      'resources is what the play holds from assets (as tl_game_observe resources: resident count and bytes per kind, loads, frees, open and not released script handles, textures against the texture budget, textures.embedded the images inside model files counted there); ' +
      'assetReads {reads, bytes} the asset files read so far and catalogReads {files, bytes} the runtime catalog files read so far (a scene load reads its scene and dependency file, an asset named by id its entry shard). ' +
      'runtime.errors holds the last script logs (code behavior_log) and errors; an entry with a compiled position (at, frames) also has source (and sources) ' +
      '{behaviorId | libraryId, path, line, column}: the place in the project\'s own script or library file. ' +
      'runtime.messageQueue (present once a ctx.messages.send was refused) {refused, firstRefusedStep, lastRefusedStep, perStepLimit, warning}. ' +
      'runtime.blockMemory (while a block layer is loaded) {bytes, layers: [{entityId, chunks, columns, cells, bytes}] largest first}: what the layers\' cells take in memory (a layer has no cell cap; this bounds it). ' +
      'audio is why a play is silent: unlock {state locked|unlocked|blocked|unsupported, reason?, context none|suspended|running|closed, muted, hidden} (locked until the player\'s first key press or click in the game), ' +
      'playing {music {assetId, playing, waitingFor? unlock|muted|file}, voices, byBus, loops, pending, list}, started (by bus), skipped (by why: muted, locked, not_ready, decode_failed, not_registered, voice_cap, context_closed, stale_run), late {started, dropped, recent} and notes (the newest, naming the sound). ' +
      'A play that ended answers play_not_found with ended {reason, presented, at, detail?} and why in the message; one that ended before it was presented is also in the problems.',
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_playtest',
    description:
      'A headless play-test - play the game from its start with an input script and report what happened as JSON ' +
      '(node tools/playtest.mjs <game folder> runs the same from the command line, and also runs a driver: the project\'s own Node module that plays step by step). ' +
      'With no editor open the backend plays in its headless editor. ' +
      'Each run begins with a restart of the game (start scenes, every object as authored, the start variables set again) and every exercise holds the game after it, so runs are step-exact; ' +
      'runs per threading mode (runs 1-8, default 2) and threads (project: the project setting (default), worker, single, both) - runs with the same input must agree, in the worker and on a single thread alike. ' +
      'frames: the input script - tl_input_exercise frames {stepOffset (from the run\'s first step, 0), steps?, actions?, pointer?, gamepad?, ui?}, ascending, over up to 432000 steps ' +
      '(sent as several exercises split between frames; gaps are neutral; a pad or pointer button held across a split presses again). ' +
      'observe: {fields? (dot paths into the tl_game_observe document; default state, player, counters, scenes, ui.values), atSteps? (also right after these run steps; not inside a frame\'s run), entityId?}. ' +
      'sceneId, mode, variables: the start (as tl_play_start). The game runs at its step rate (a minute of play takes a minute); timeoutMs bounds the whole test (default 600000). ' +
      'Returns {ok, input, runs: [{threads, run, simulation, playSessionId, observations: [{runStep, digest (the run digest), fields}], runStep, digest, errors (script errors and logs), errorCount}], deterministic, mismatches}; ' +
      'a failure {ok: false, error {code, message}, runs (finished before it)}. A game that starts paused (a title screen) is refused: start it past the title (sceneId).',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        mode: { type: 'string' },
        variables: { type: 'object' },
        threads: { type: 'string', enum: ['project', 'worker', 'single', 'both'] },
        runs: { type: 'integer', minimum: 1, maximum: 8 },
        frames: { type: 'array', minItems: 1, maxItems: 20000, items: { type: 'object' } },
        driver: { type: 'string', description: 'not taken here: a driver (the project\'s own Node module) runs from node tools/playtest.mjs <game folder> --driver <file>' },
        observe: {
          type: 'object',
          properties: {
            fields: { type: 'array', maxItems: 32, items: { type: 'string' } },
            atSteps: { type: 'array', maxItems: 64, items: { type: 'integer', minimum: 1 } },
            entityId: { type: 'string' },
          },
          additionalProperties: false,
        },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 3600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_screenshot',
    description:
      `Capture a bounded screenshot (dataUrl ≤ ${SCREENSHOT_DATA_URL_MAX / 1_048_576} MiB, maxWidth ${SCREENSHOT_MAX_WIDTH_MIN}–${SCREENSHOT_MAX_WIDTH_MAX}) from a play session's ` +
      'selected connected browser preview. Fails structurally if the play is not presented or the ' +
      'editor browser is not connected; a capture the preview cannot make says why (error.cause and ' +
      'message: e.g. screenshot_failed, bridge_message_refused, render_not_ready). A PNG over the bound comes back smaller (see width). ' +
      'A capture asked before the play\'s renderer drew its first frame (right after the start) waits for that frame within half the relay timeout; past it the answer is render_not_ready. ' +
      'The game\'s UI documents and overlays (fades, letterbox, menus) are drawn over the frame as the player sees them; ui: false captures the rendered frame alone.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        maxWidth: { type: 'integer', minimum: SCREENSHOT_MAX_WIDTH_MIN, maximum: SCREENSHOT_MAX_WIDTH_MAX },
        ui: { type: 'boolean' },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
];

export const MCP_TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((t) => t.name);

/** A structured tool error (surfaced with `isError: true`). */
function toolError(message: string, extra?: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify({ ok: false, error: { code: 'tool_error', message, ...(extra ?? {}) } });
  return { content: [{ type: 'text', text }], isError: true };
}

/** A structured tool success: the backend's body, JSON-encoded (bounded by the backend). */
function toolOk(body: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** Surface the backend's structured error body as a tool error (keeping code + fields). */
function surfaceBackendError(res: { status: number; body: unknown }): CallToolResult {
  const body = isObj(res.body) ? res.body : { ok: false, error: { code: 'invalid_request', message: 'empty backend response' } };
  return { content: [{ type: 'text', text: JSON.stringify({ ...body, __httpStatus: res.status }) }], isError: true };
}

const MUTATION_SET = new Set<string>(MUTATION_OPS);
const QUERY_SET = new Set<string>(QUERY_OPS);
/** Dispatch one `tools/call` to the backend services. Never throws. */
export async function handleToolCall(
  ctx: McpContext,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const a = isObj(args) ? args : {};
  try {
    switch (name) {
      case 'tl_inspect':
        return await inspect(ctx, a);
      case 'tl_command':
        return await command(ctx, a);
      case 'tl_sessions':
        return await sessions(ctx);
      case 'tl_play_start':
        return await playStart(ctx, a);
      case 'tl_play_stop':
        return await playStop(ctx, a);
      case 'tl_diagnostics':
        return await diagnostics(ctx, a);
      case 'tl_screenshot':
        return await screenshot(ctx, a);
      case 'tl_input_exercise':
        return await inputExercise(ctx, a);
      case 'tl_game_control':
        return await gameControl(ctx, a);
      case 'tl_instance_buffer':
        return await instanceBuffer(ctx, a);
      case 'tl_game_observe':
        return await gameObserve(ctx, a);
      case 'tl_content_query':
        return await contentQuery(ctx, a);
      case 'tl_content_upload':
        return await contentUpload(ctx, a);
      case 'tl_content_job':
        return await contentJob(ctx, a);
      case 'tl_playtest':
        return await playtest(ctx, a);
      default:
        return toolError(`unknown tool "${String(name).slice(0, 64)}"`);
    }
  } catch (err) {
    // Network/abort failures and unexpected throws become a structured error.
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = msg.includes('abort');
    return toolError(aborted ? 'request to the backend timed out or was aborted' : `internal tool error: ${msg.slice(0, 128)}`);
  }
}

async function inspect(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const target = a.target;
  if (target === 'selection') return inspectSelection(ctx);
  if (target === 'engine') {
    // The engine the backend runs.
    const res = await ctx.client.engineInfo();
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target !== 'project' && target !== 'entity' && target !== 'entities') {
    return toolError('target must be "project", "entity", "entities", "selection" or "engine"');
  }
  let op: string;
  let argsOut: Record<string, unknown>;
  if (target === 'project') {
    op = 'queryProject';
    argsOut = {};
    if (a.environments !== undefined) {
      if (typeof a.environments !== 'boolean') return toolError('environments must be a boolean');
      argsOut.environments = a.environments;
    }
  } else if (target === 'entity') {
    op = 'queryEntity';
    if (typeof a.entityId !== 'string' || a.entityId.length === 0) return toolError('entityId is required for target="entity"');
    argsOut = { entityId: a.entityId };
    if (a.includeSubtree !== undefined) {
      if (typeof a.includeSubtree !== 'boolean') return toolError('includeSubtree must be a boolean');
      argsOut.includeSubtree = a.includeSubtree;
    }
  } else {
    op = 'queryEntities';
    argsOut = {};
    if (a.limit !== undefined) {
      if (!isInt(a.limit) || a.limit < 1 || a.limit > 1024) return toolError('limit must be an integer 1–1024');
      argsOut.limit = a.limit;
    }
    if (a.offset !== undefined) {
      if (!isInt(a.offset) || a.offset < 0) return toolError('offset must be an integer ≥ 0');
      argsOut.offset = a.offset;
    }
    if (a.sceneId !== undefined) {
      if (typeof a.sceneId !== 'string' || a.sceneId.length === 0) return toolError('sceneId must be a scene id');
      argsOut.sceneId = a.sceneId;
    }
  }
  const res = await ctx.client.command(ctx.projectId, { op, args: argsOut });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function command(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const op = a.op;
  // A staged library patch goes to the library stage route (it changes no revision).
  if (op === 'stageScriptLibrary') {
    if (!isObj(a.args)) return toolError('args is required for stageScriptLibrary ({stageId?, libraryId, name?, files?} or {stageId, discard: true})');
    const res = await ctx.client.stageScriptLibrary(ctx.projectId, a.args);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (typeof op !== 'string' || !MUTATION_SET.has(op)) {
    return toolError(`op must be one of ${MUTATION_OPS.join(', ')}`);
  }
  if (!isInt(a.expectedRevision) || a.expectedRevision < 0) {
    return toolError('expectedRevision is required (an integer ≥ 0) for command submission');
  }
  const requestId = typeof a.requestId === 'string' ? a.requestId : makeRequestId();
  const envelope: Record<string, unknown> = {
    op,
    projectId: ctx.projectId,
    expectedRevision: a.expectedRevision,
    requestId,
    origin: { kind: 'mcp', clientId: ctx.clientId },
  };
  if (a.args !== undefined) {
    if (!isObj(a.args)) return toolError('args must be an object');
    envelope.args = a.args;
  } else if (op !== 'undo' && op !== 'redo') {
    // createEntity/setTransform/deleteEntity require args; undo/redo take none.
    return toolError(`args is required for ${op}`);
  }
  const res = await ctx.client.command(ctx.projectId, envelope);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** The entities selected in the project's connected editor (≤ 64). */
async function inspectSelection(ctx: McpContext): Promise<CallToolResult> {
  const list = await ctx.client.listSessions(ctx.projectId);
  if (!isObj(list.body) || list.body.ok !== true) return surfaceBackendError(list);
  const all = (list.body.sessions as Array<{ sessionId: string; connected: boolean; selection?: string[] }>) ?? [];
  const session = all.find((s) => s.connected);
  if (session === undefined) return toolError('no editor browser is connected for this project (nothing is selected)');
  const entities: unknown[] = [];
  for (const entityId of session.selection ?? []) {
    const res = await ctx.client.command(ctx.projectId, { op: 'queryEntity', args: { entityId } });
    if (isObj(res.body) && res.body.ok === true) entities.push(res.body.entity);
  }
  return toolOk({ ok: true, sessionId: session.sessionId, selection: session.selection ?? [], entities });
}

async function sessions(ctx: McpContext): Promise<CallToolResult> {
  const res = await ctx.client.listSessions(ctx.projectId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function playStart(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  // The play-start body is `{ options: { demo } }` (demo
  // boolean, default true) — `demo` nests under `options`, not at the top level.
  const body: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  if (a.demo !== undefined) {
    if (typeof a.demo !== 'boolean') return toolError('demo must be a boolean');
    options.demo = a.demo;
  }
  // The start options and the threading mode go in `options` too (the backend validates and resolves them).
  for (const k of ['sceneId', 'mode', 'variables', 'save', 'saveSlot', 'threads'] as const) if (a[k] !== undefined) options[k] = a[k];
  if (Object.keys(options).length > 0) body.options = options;
  if (a.sessionId !== undefined) {
    if (typeof a.sessionId !== 'string') return toolError('sessionId must be a string');
    body.sessionId = a.sessionId;
  }
  const res = await ctx.client.startPlay(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function playStop(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const res = await ctx.client.stopPlay(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function diagnostics(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (a.playSessionId === undefined) {
    const problems = await ctx.client.problems(ctx.projectId);
    if (!isObj(problems.body) || problems.body.ok !== true) return surfaceBackendError(problems);
    const project = await ctx.client.command(ctx.projectId, { op: 'queryProject', args: {} });
    const workspace = isObj(project.body) && project.body.ok === true ? project.body.workspace : null;
    // The graph materials that have problems.
    return toolOk({ ok: true, workspace, total: problems.body.total, problems: problems.body.problems, ...(problems.body.materialProblems !== undefined ? { materialProblems: problems.body.materialProblems } : {}), ...(problems.body.missingFiles !== undefined ? { missingFiles: problems.body.missingFiles } : {}) });
  }
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId must be a non-empty string');
  const res = await ctx.client.diagnostics(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function screenshot(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  let maxWidth: number | undefined;
  if (a.maxWidth !== undefined) {
    if (!isInt(a.maxWidth) || a.maxWidth < SCREENSHOT_MAX_WIDTH_MIN || a.maxWidth > SCREENSHOT_MAX_WIDTH_MAX) return toolError(`maxWidth must be an integer ${SCREENSHOT_MAX_WIDTH_MIN}–${SCREENSHOT_MAX_WIDTH_MAX}`);
    maxWidth = a.maxWidth;
  }
  if (a.ui !== undefined && typeof a.ui !== 'boolean') return toolError('ui must be true or false');
  const res = await ctx.client.screenshot(ctx.projectId, a.playSessionId, maxWidth, a.ui === false ? false : undefined);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** Bounded exclusive-test input relay (semantic actions only). */
async function inputExercise(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  if (!Array.isArray(a.frames) || a.frames.length < 1 || a.frames.length > 600) {
    return toolError(`frames must be an array of 1–${INPUT_RELAY_MAX_FRAMES} entries`);
  }
  const frames: Array<Record<string, unknown>> = [];
  let previous = -1;
  let previousEnd = 0;
  for (let i = 0; i < a.frames.length; i += 1) {
    const raw = a.frames[i];
    if (!isObj(raw)) return toolError(`frames[${i}] must be an object`);
    const { stepOffset, actions } = raw;
    // Frame version 2 has no fixed channels.
    for (const old of ['moveX', 'moveY', 'jump']) {
      if (raw[old] !== undefined) return toolError(`frames[${i}].${old} is not a frame field (input frame version 2): use actions {move: {v}, jump: {v, p}}`);
    }
    if (!isInt(stepOffset) || stepOffset < 0) return toolError(`frames[${i}].stepOffset must be an integer ≥ 0`);
    if (stepOffset <= previous) return toolError('frames must be strictly ascending by stepOffset');
    previous = stepOffset;
    if (actions !== undefined && !isObj(actions)) return toolError(`frames[${i}].actions must be an object`);
    // The pointer too.
    if (raw.pointer !== undefined && !isObj(raw.pointer)) return toolError(`frames[${i}].pointer must be an object { x, y, ... }`);
    // Run length (no overlap), a virtual gamepad, UI edges.
    const span = relayFrameEnd(stepOffset, raw.steps, previousEnd);
    if (!span.ok) return toolError(`frames[${i}]: ${span.reason}`);
    previousEnd = span.end;
    if (raw.gamepad !== undefined && parseRelayGamepad(raw.gamepad) === null) return toolError(`frames[${i}].gamepad must be { buttons?: up to 17 numbers 0-1, axes?: up to 4 numbers -1..1 }`);
    if (raw.ui !== undefined && parseRelayUiEdges(raw.ui) === null) return toolError(`frames[${i}].ui must be 1-8 of up, down, left, right, submit, cancel, pause`);
    for (const k of Object.keys(raw)) if (!['stepOffset', 'steps', 'actions', 'pointer', 'gamepad', 'ui'].includes(k)) return toolError(`frames[${i}].${k} is not a frame field (stepOffset, steps, actions, pointer, gamepad, ui)`);
    // The named actions reach the game (the backend validates them).
    frames.push({
      stepOffset,
      ...(raw.steps !== undefined ? { steps: raw.steps } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(raw.pointer !== undefined ? { pointer: raw.pointer } : {}),
      ...(raw.gamepad !== undefined ? { gamepad: raw.gamepad } : {}),
      ...(raw.ui !== undefined ? { ui: raw.ui } : {}),
    });
  }
  if (a.restart !== undefined && typeof a.restart !== 'boolean') return toolError('restart must be true or false');
  if (a.hold !== undefined && typeof a.hold !== 'boolean') return toolError('hold must be true or false');
  const request = { mode: 'exclusive-test', frames, ...(a.restart === true ? { restart: true } : {}), ...(a.hold === true ? { hold: true } : {}) };
  const body = JSON.stringify(request);
  if (body.length > INPUT_RELAY_MAX_BODY_BYTES) return toolError(`the relay body exceeds the ${INPUT_RELAY_MAX_BODY_BYTES}-byte bound`);
  const res = await ctx.client.inputRelay(ctx.projectId, a.playSessionId, request);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

// ---- content tools ------------------------------------------------------------

/** Bounded content queries (commands.md and the content routes). */
async function contentQuery(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const target = a.target;
  if (target === 'projectFiles') {
    const dir = a.dir ?? '';
    if (typeof dir !== 'string') return toolError('dir must be a string');
    const res = await ctx.client.listProjectFiles(ctx.projectId, dir);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'materials') {
    // The materials and their graph problems (the backend checks them at load and after each change).
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    if (a.materialId !== undefined && typeof a.materialId !== 'string') return toolError('materialId must be a string');
    if (a.withProblems !== undefined && typeof a.withProblems !== 'boolean') return toolError('withProblems must be a boolean');
    const res = await ctx.client.contentMaterials(ctx.projectId, { ...(paged.args as { limit?: number; offset?: number }), ...(typeof a.materialId === 'string' ? { materialId: a.materialId } : {}), ...(a.withProblems === true ? { withProblems: true } : {}) });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'integrity') {
    if (a.check !== undefined && typeof a.check !== 'boolean') return toolError('check must be a boolean');
    if (a.problems !== undefined && typeof a.problems !== 'boolean') return toolError('problems must be a boolean');
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const page = { ...(paged.args as { limit?: number; offset?: number }), ...(a.problems === true ? { problems: true } : {}) };
    const res = a.check === true ? await ctx.client.checkFiles(ctx.projectId, page) : await ctx.client.contentIntegrity(ctx.projectId, page);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // The v3 game-config query (commands.md) over the same shared command
  // surface; no args.
  if (target === 'game') {
    if (a.includeDescriptors !== undefined && typeof a.includeDescriptors !== 'boolean') return toolError('includeDescriptors must be a boolean');
    const res = await ctx.client.command(ctx.projectId, { op: 'queryGameConfig', ...(a.includeDescriptors === true ? { args: { descriptors: true } } : {}) });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'assets' || target === 'asset') {
    if (target === 'asset') {
      if (typeof a.assetId !== 'string' || a.assetId.length === 0) return toolError('assetId is required for target="asset"');
      const one = await ctx.client.contentAsset(ctx.projectId, a.assetId);
      return isObj(one.body) && one.body.ok === true ? toolOk(one.body) : surfaceBackendError(one);
    }
    const args: Record<string, unknown> = {};
    if (a.includeVersions !== undefined) {
      if (typeof a.includeVersions !== 'boolean') return toolError('includeVersions must be a boolean');
      args.includeVersions = a.includeVersions;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryAssets', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'prefabs') {
    const args: Record<string, unknown> = {};
    if (a.prefabId !== undefined) {
      if (typeof a.prefabId !== 'string') return toolError('prefabId must be a string');
      args.prefabId = a.prefabId;
    }
    if (a.includeEntities !== undefined) {
      if (typeof a.includeEntities !== 'boolean') return toolError('includeEntities must be a boolean');
      args.includeEntities = a.includeEntities;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryPrefabs', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'behaviors') {
    const args: Record<string, unknown> = {};
    if (a.behaviorId !== undefined) {
      if (typeof a.behaviorId !== 'string') return toolError('behaviorId must be a string');
      args.behaviorId = a.behaviorId;
    }
    if (a.includeDeclaration !== undefined) {
      if (typeof a.includeDeclaration !== 'boolean') return toolError('includeDeclaration must be a boolean');
      args.includeDeclaration = a.includeDeclaration;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryBehaviors', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // Block-layer cells and regions.
  if (target === 'blocks') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'entityId', 'chunks', 'box', 'region'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'queryBlocks', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // Terrains: tiles and their bytes, the surface at points.
  if (target === 'terrain') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'entityId', 'points', 'scatter'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'queryTerrain', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // The ground at points from whichever block layer or terrain is there.
  if (target === 'surface') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'points'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'querySurface', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // The project index: every asset, resource and scene (file, name, labels, what it references).
  if (target === 'index') {
    const args: Record<string, unknown> = {};
    for (const k of ['kind', 'id', 'label', 'address', 'referencing', 'text', 'folder', 'sort'] as const) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== 'string') return toolError(`${k} must be a string`);
      args[k] = a[k];
    }
    for (const k of ['loadable', 'recursive', 'folders', 'descending'] as const) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== 'boolean') return toolError(`${k} must be a boolean`);
      args[k] = a[k];
    }
    if (a.labels !== undefined) {
      if (!Array.isArray(a.labels) || !a.labels.every((l) => typeof l === 'string')) return toolError('labels must be an array of strings');
      args.labels = a.labels;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryIndex', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  return toolError('target must be "assets", "asset", "prefabs", "behaviors", "integrity", "game", "projectFiles", "blocks", "materials" or "index"');
}

function pageArgs(a: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: CallToolResult } {
  const args: Record<string, unknown> = {};
  if (a.limit !== undefined) {
    if (!isInt(a.limit) || a.limit < 1 || a.limit > CONTENT_ASSETS_LIMIT_MAX) return { ok: false, error: toolError(`limit must be an integer 1–${CONTENT_ASSETS_LIMIT_MAX}`) };
    args.limit = a.limit;
  }
  if (a.offset !== undefined) {
    if (!isInt(a.offset) || a.offset < 0) return { ok: false, error: toolError('offset must be an integer ≥ 0') };
    args.offset = a.offset;
  }
  return { ok: true, args };
}

/** Decode base64 without a `node:` import (the global Web `atob`). */
function decodeBase64(text: string): Uint8Array | null {
  const fn = (globalThis as { atob?: (data: string) => string }).atob;
  if (typeof fn !== 'function') return null;
  let binary: string;
  try {
    binary = fn(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/** Stage + upload (bounded frames) + inspect over the real backend routes. */
async function contentUpload(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  // Pack a texture (array) from texture assets.
  if (a.pack !== undefined) {
    if (a.dataBase64 !== undefined || a.projectPath !== undefined || a.ktx2 !== undefined) return toolError('pack goes alone (no dataBase64, projectPath or ktx2; its encoding is pack.encoding)');
    if (!isObj(a.pack)) return toolError('pack must be an object {layers, encoding}');
    const body: Record<string, unknown> = { layers: a.pack.layers, encoding: a.pack.encoding };
    if (a.displayName !== undefined) body.displayName = a.displayName;
    const res = await ctx.client.packTexture(ctx.projectId, body);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // An asset tool's job export (a folder or zip: a GLB and manifest.json).
  if (a.jobExport !== undefined) {
    if (!isObj(a.jobExport)) return toolError('jobExport must be an object {path?}');
    if (a.projectPath !== undefined || a.kind !== undefined || a.ktx2 !== undefined || a.animation !== undefined) return toolError('jobExport goes alone (with dataBase64 of a zip, or its own path; the model is kind "model")');
    const body: Record<string, unknown> = {};
    if (a.displayName !== undefined) body.displayName = a.displayName;
    if (a.jobExport.path !== undefined) {
      if (a.dataBase64 !== undefined) return toolError('give jobExport.path or dataBase64 (a zip), not both');
      body.path = a.jobExport.path;
    } else {
      if (typeof a.dataBase64 !== 'string' || a.dataBase64.length === 0) return toolError('jobExport needs a path, or dataBase64 of a zip');
      const zip = decodeBase64(a.dataBase64);
      if (zip === null || zip.length === 0) return toolError('dataBase64 is not valid base64');
      if (zip.length > CONTENT_STAGE_MAX) return toolError(`dataBase64 exceeds the ${CONTENT_STAGE_MAX}-byte stage cap`);
      const created = await ctx.client.createStage(ctx.projectId, {});
      if (!(isObj(created.body) && created.body.ok === true && typeof created.body.stageId === 'string')) return surfaceBackendError(created);
      for (let offset = 0; offset < zip.length; offset += CONTENT_UPLOAD_FRAME_MAX) {
        const put = await ctx.client.uploadFrame(ctx.projectId, created.body.stageId, offset, zip.length, zip.subarray(offset, Math.min(offset + CONTENT_UPLOAD_FRAME_MAX, zip.length)));
        if (!(isObj(put.body) && put.body.ok === true)) return surfaceBackendError(put);
      }
      body.stageId = created.body.stageId;
    }
    const res = await ctx.client.inspectJobExport(ctx.projectId, body);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (a.projectPath !== undefined) {
    if (a.dataBase64 !== undefined) return toolError('give either dataBase64 or projectPath, not both');
    return projectFileInspect(ctx, a);
  }
  if (a.writeTo !== undefined) {
    if (typeof a.writeTo !== 'string' || a.writeTo.length === 0) return toolError('writeTo must be a path relative to the game folder, e.g. assets/voice/line-001.ogg');
    if (a.kind !== undefined || a.ktx2 !== undefined || a.animation !== undefined || a.displayName !== undefined) return toolError('writeTo goes with dataBase64 only (the file is written, not inspected)');
  }
  if (typeof a.dataBase64 !== 'string' || a.dataBase64.length === 0) return toolError('dataBase64 or projectPath is required');
  const bytes = decodeBase64(a.dataBase64);
  if (bytes === null) return toolError('dataBase64 is not valid base64');
  if (bytes.length === 0) return toolError('dataBase64 decodes to zero bytes');
  if (bytes.length > CONTENT_STAGE_MAX) return toolError(`dataBase64 exceeds the ${CONTENT_STAGE_MAX}-byte stage cap`);
  const body: Record<string, unknown> = {};
  if (a.displayName !== undefined) {
    if (typeof a.displayName !== 'string' || a.displayName.length < 1 || a.displayName.length > 128) {
      return toolError('displayName must be a 1–128 character string');
    }
    body.displayName = a.displayName;
  }
  const created = await ctx.client.createStage(ctx.projectId, body);
  if (!(isObj(created.body) && created.body.ok === true && typeof created.body.stageId === 'string')) {
    return surfaceBackendError(created);
  }
  const stageId = created.body.stageId;
  for (let offset = 0; offset < bytes.length; offset += CONTENT_UPLOAD_FRAME_MAX) {
    const frame = bytes.subarray(offset, Math.min(offset + CONTENT_UPLOAD_FRAME_MAX, bytes.length));
    const put = await ctx.client.uploadFrame(ctx.projectId, stageId, offset, bytes.length, frame);
    if (!(isObj(put.body) && put.body.ok === true)) return surfaceBackendError(put);
  }
  if (typeof a.writeTo === 'string') {
    const filed = await ctx.client.fileStage(ctx.projectId, stageId, a.writeTo);
    return isObj(filed.body) && filed.body.ok === true ? toolOk(filed.body) : surfaceBackendError(filed);
  }
  // The additive inspect request selects the inspector of a kind
  // or the role-aware animated GLB profile.
  const inspectBody: Record<string, unknown> = {};
  if (a.kind !== undefined) {
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'font') return toolError('kind must be "model", "audio", "texture" or "font" (audio of any length is "audio")');
    inspectBody.kind = a.kind;
  }
  if (a.animation !== undefined) {
    if (!isObj(a.animation)) return toolError('animation must be an object');
    const roles = a.animation.roles;
    if (!isObj(roles)) return toolError('animation.roles must be an object');
    inspectBody.animation = a.animation;
  }
  if (a.ktx2 !== undefined) {
    if (a.ktx2 !== 'color' && a.ktx2 !== 'normal' && a.ktx2 !== 'data') return toolError('ktx2 must be "color", "normal" or "data"');
    inspectBody.ktx2 = a.ktx2;
  }
  const inspected = await ctx.client.inspectStage(ctx.projectId, stageId, inspectBody);
  return isObj(inspected.body) && inspected.body.ok === true ? toolOk(inspected.body) : surfaceBackendError(inspected);
}

/** Inspect a file already in the game folder, in place (no upload, no copy). */
async function projectFileInspect(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.projectPath !== 'string' || a.projectPath.length === 0) return toolError('projectPath must be a non-empty string');
  const body: Record<string, unknown> = { path: a.projectPath };
  if (a.displayName !== undefined) {
    if (typeof a.displayName !== 'string' || a.displayName.length < 1 || a.displayName.length > 128) {
      return toolError('displayName must be a 1–128 character string');
    }
    body.displayName = a.displayName;
  }
  if (a.kind !== undefined) {
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'font') return toolError('kind must be "model", "audio", "texture" or "font" (audio of any length is "audio")');
    body.kind = a.kind;
  }
  if (a.animation !== undefined) {
    if (!isObj(a.animation) || !isObj(a.animation.roles)) return toolError('animation.roles must be an object');
    body.animation = a.animation;
  }
  if (a.ktx2 !== undefined) {
    if (a.ktx2 !== 'color' && a.ktx2 !== 'normal' && a.ktx2 !== 'data') return toolError('ktx2 must be "color", "normal" or "data"');
    body.ktx2 = a.ktx2;
  }
  const res = await ctx.client.inspectProjectFile(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

// ---- game control/observation relay tools -------------------------------------

/** Publish an instance-set buffer (inline transforms). */
async function instanceBuffer(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (a.digest !== undefined) {
    if (a.transforms !== undefined) return toolError('give transforms (publish) or digest (read), not both');
    if (typeof a.digest !== 'string' || !/^[0-9a-f]{64}$/.test(a.digest)) return toolError('digest must be 64 lowercase hex characters');
    const read = await ctx.client.readInstanceBuffer(ctx.projectId, a.digest);
    if (!read.ok) return surfaceBackendError(read.response);
    const count = Math.floor(read.floats.length / 10);
    if (count > INSTANCE_BUFFER_INLINE_MAX) return toolError(`the buffer holds ${count} copies; reading returns sets of up to ${INSTANCE_BUFFER_INLINE_MAX} copies`);
    // 9 significant digits: every float32 reads back to the same value when republished.
    return toolOk({ ok: true, digest: a.digest, count, transforms: Array.from(read.floats, (v) => Number(v.toPrecision(9))) });
  }
  const t = a.transforms;
  if (!Array.isArray(t) || t.length === 0 || t.length % INSTANCE_FLOATS !== 0 || t.length > INSTANCE_BUFFER_INLINE_MAX * INSTANCE_FLOATS || !t.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return toolError(`transforms must be a flat list of finite numbers, ${INSTANCE_FLOATS} per copy, 1-${INSTANCE_BUFFER_INLINE_MAX} copies`);
  }
  const res = await ctx.client.publishInstanceBuffer(ctx.projectId, { transforms: t });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** Bounded game-control relay (never a simulation). */
async function gameControl(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const playSessionId = a.playSessionId;
  if (typeof playSessionId !== 'string' || playSessionId.length === 0) return toolError('playSessionId is required');
  const command = a.command ?? (a.signal !== undefined ? SIGNAL_DEBUG_COMMAND_NAME : undefined);
  if (typeof command !== 'string' || !(TOOL_CONTROL_COMMANDS as readonly string[]).includes(command)) {
    return toolError(`command must be one of ${TOOL_CONTROL_COMMANDS.join(', ')}`);
  }
  if (command === SIGNAL_DEBUG_COMMAND_NAME) {
    if (a.value !== undefined) return toolError('signals carry no value (ctx.signals.emit takes a name only); give scripts a value with a debugCommand or a script message');
    if (typeof a.signal !== 'string' || a.signal.length === 0) return toolError('signal (the signal name) is required for command signal');
    if (a.name !== undefined || a.args !== undefined || a.sceneId !== undefined || a.level !== undefined) return toolError('signal takes the signal name only');
    a = { ...a, command: 'debugCommand', name: SIGNAL_DEBUG_COMMAND_NAME, args: { name: a.signal } };
  } else if (a.signal !== undefined) {
    return toolError('signal goes with command signal only');
  }
  const body: Record<string, unknown> = { command: a.command };
  if (a.expectedRunId !== undefined) {
    if (typeof a.expectedRunId !== 'string' || a.expectedRunId.length === 0 || a.expectedRunId.length > 128) {
      return toolError('expectedRunId must be a bounded non-empty string');
    }
    body.expectedRunId = a.expectedRunId;
  }
  if (a.command === 'loadScene' || a.command === 'unloadScene') {
    if (typeof a.sceneId !== 'string' || a.sceneId.length === 0) return toolError('sceneId is required for loadScene / unloadScene');
    body.sceneId = a.sceneId;
  } else if (a.sceneId !== undefined) {
    return toolError('sceneId goes with loadScene / unloadScene only');
  }
  // A debug command's name and arguments.
  if (a.command === 'debugCommand') {
    if (typeof a.name !== 'string' || a.name.length === 0) return toolError('name is required for debugCommand');
    body.name = a.name;
    if (a.args !== undefined) {
      if (!isObj(a.args)) return toolError('args must be an object of argument values');
      body.args = a.args;
    }
  } else if (a.name !== undefined || a.args !== undefined) {
    return toolError('name and args go with debugCommand only');
  }
  if (a.command === 'setQuality') {
    if (typeof a.level !== 'string' || a.level.length === 0) return toolError('level (a quality level id) is required for setQuality');
    body.level = a.level;
  } else if (a.level !== undefined) {
    return toolError('level goes with setQuality only');
  }
  const res = await ctx.client.gameControl(ctx.projectId, playSessionId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** Bounded read-only observation relay (never a simulation). */
async function gameObserve(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const body: Record<string, unknown> = {};
  if (a.timeoutMs !== undefined) {
    if (!isInt(a.timeoutMs) || a.timeoutMs < GAME_OBSERVE_TIMEOUT_MIN_MS || a.timeoutMs > GAME_OBSERVE_TIMEOUT_MAX_MS) return toolError(`timeoutMs must be an integer ${GAME_OBSERVE_TIMEOUT_MIN_MS}–${GAME_OBSERVE_TIMEOUT_MAX_MS}`);
    body.timeoutMs = a.timeoutMs;
  }
  if (a.entityId !== undefined) {
    if (typeof a.entityId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.entityId)) return toolError('entityId must be an entity id');
    body.entityId = a.entityId;
  }
  const res = await ctx.client.gameObserve(ctx.projectId, a.playSessionId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function contentJob(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.jobId !== 'string' || !/^job-[0-9a-f]{32}$/.test(a.jobId)) return toolError('jobId must be job- + 32 hex');
  const res = await ctx.client.contentJob(ctx.projectId, a.jobId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}
// ---- the headless play-test runner ------------------------------------------

async function playtest(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const spec: { -readonly [K in keyof PlaytestSpec]: PlaytestSpec[K] } = {};
  if (a.sceneId !== undefined) {
    if (typeof a.sceneId !== 'string') return toolError('sceneId must be a string');
    spec.sceneId = a.sceneId;
  }
  if (a.mode !== undefined) {
    if (typeof a.mode !== 'string') return toolError('mode must be a string');
    spec.mode = a.mode;
  }
  if (a.driver !== undefined) {
    // The driver is the project's own Node code: this process loads no code by a computed path (dependencies.md).
    return toolError('a driver script runs from the command line: node tools/playtest.mjs <game folder> --driver <file> (tl_playtest takes an input script: frames)');
  }
  // The runner checks the rest (frames, threads, runs, observe, variables, timeoutMs).
  if (a.variables !== undefined) spec.variables = a.variables as Record<string, unknown>;
  if (a.threads !== undefined) spec.threads = a.threads as PlaytestSpec['threads'];
  if (a.runs !== undefined) spec.runs = a.runs as number;
  if (a.frames !== undefined) spec.frames = a.frames as PlaytestSpec['frames'];
  if (a.observe !== undefined) spec.observe = a.observe as PlaytestSpec['observe'];
  if (a.timeoutMs !== undefined) spec.timeoutMs = a.timeoutMs as number;
  const result = await runPlaytest(playtestBackend(ctx.client, ctx.projectId), ctx.projectId, spec);
  return result.ok ? toolOk(result) : { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
}

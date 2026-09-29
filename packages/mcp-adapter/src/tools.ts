/**
 * The MCP tool surface (charter §7; decision 0001 §5). Six categories,
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
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpContext {
  readonly client: BackendClient;
  readonly projectId: string;
  /** The `origin.clientId` recorded on MCP-submitted commands (commands.md §3). */
  readonly clientId: string;
}

export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The M1 command ops (commands.md §2/§4). */
const M1_MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'] as const;
/** The M2 content/property/prefab mutation ops (commands.md §8.5–§8.12). */
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
/** The M3 v3 game/presentation mutation ops (commands.md §8.13/§8.14, packet 45/48). */
const M3_MUTATION_OPS = ['applySurfacePreset', 'updateEntity', 'moveEntities', 'setTags', 'setAssetOptions', 'pasteEntities', 'setMaterial', 'deleteMaterial', 'setEnvironment', 'setLighting', 'setAnimator', 'deleteAnimator', 'setInput', 'setCollisionLayers', 'setSaveSchema', 'createScene', 'renameScene', 'deleteScene', 'setStartScenes', 'setGraph', 'deleteGraph', 'graphEdit', 'setEffect', 'deleteEffect', 'renameEffect', 'setScriptLibrary', 'deleteScriptLibrary', 'editBlocks', 'setBlockType', 'deleteBlockType', 'setCellFields', 'setBlockStamp', 'deleteBlockStamp', 'setUiDocument', 'deleteUiDocument', 'setUiTheme', 'deleteUiTheme', 'setTimeline', 'deleteTimeline', 'setModes', 'setBehaviorGroups', 'setEventCues', 'setShell', 'setDialogue', 'deleteDialogue', 'setSpeaker', 'deleteSpeaker', 'setDialogueSettings', 'deleteAsset', 'deletePrefab', 'createEntities', 'commitScriptLibraryStage'] as const;
const MUTATION_OPS = [...M1_MUTATION_OPS, ...M2_MUTATION_OPS, ...M3_MUTATION_OPS] as const;
const QUERY_OPS = ['queryProject', 'queryEntity', 'queryEntities', 'queryAssets', 'queryPrefabs', 'queryBehaviors'] as const;
/** The closed §20 control command set (sessions.md §20.1). */
const GAME_CONTROL_COMMANDS = ['replay', 'mute', 'unmute', 'loadScene', 'unloadScene', 'clearSave', 'debugPause', 'debugResume', 'debugStep', 'debugCommand'] as const;
/** The largest single upload frame accepted by the backend (sessions.md §11.5). */
const CONTENT_UPLOAD_FRAME_MAX = 1_048_576;
/** The staged-source cap (workspace.md §13.9) — the MCP upload tool's bound. */
const CONTENT_STAGE_MAX = 33_554_432;

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
      'target="selection" returns the entities selected in the connected editor. A project has one or more scenes ' +
      '(one file each; target="project" lists scenes and startScenes, target="entity" names its sceneId). Never mutates.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['project', 'entity', 'entities', 'selection'] },
        entityId: { type: 'string' },
        includeSubtree: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1024 },
        offset: { type: 'integer', minimum: 0 },
        sceneId: { type: 'string', description: 'target="entities": only this scene' },
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
      'updateEntity (rename/reparent/flags/tags: {entityId, name?, parentId?, active?, locked?, static?, tags?: [tag names]}; a reparent keeps ' +
      'the world position), moveEntities (file entities with their subtrees, keeping world positions: ' +
      '{entityIds, parentId|null, beforeId?}), deleteEntity, undo, redo. A folder has no transform and sits at the ' +
      'root or in another folder; folders pass active/locked/static and their tags down to their subtree. ' +
      'Tags: setTags {tags: [{bit?, name}]} replaces the project tag registry (up to 32; a rename keeps the bit, a new ' +
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
      '(loops: at most 10000 iterations per step in all, more is a script error with the node id), gate (enter/open/close/toggle), doonce (in/reset), delay {seconds} ' +
      '(step-counted, a timer "vs.delay.<n>"), switch {on: text|int, cases: "a, b, c" (comma separated, up to 32; outputs case1..caseN)} (+ default), select. Data ports: number, boolean, string, vector [x,y,z], list and map ' +
      '(bounded: 1024 items, 256 entries; list/map nodes return new values) with conversions number→string, boolean→string, boolean→number, number→vector, vector→string; ' +
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
      'audioSource, faceMovement, health, collectible, patrol, hitbox…); a collider only on its root; never the player controller or scene wiring). ' +
      'Component fields, defaults, the GameObject menu\'s create entries (label, size, value) and icons: tl_content_query target="game" includeDescriptors. ' +
      'Generic primitives (phase 24.4, both physics dimensions; fields in queryGameConfig {descriptors}): collectible {counter, amount?, size?, onCollect?, respawn?}, ' +
      'health {max, start?} on any object (scripts: ctx.health.get/damage/heal, damaged/healed/died events), patrol {mode: waypoints|edges, speed, ...}, ' +
      'hitbox {shape?, size|radius, damage?} (contact/separate events with the other object and the normal). ' +
      'climbVolume {size: [w, h] or [w, h, d]} (phase 25.13: the character climbs in it — up/down along the object\'s +Y, sideways across, at its controller climbSpeed, no gravity; jump or moving out leaves), gravity {scale? 0-10, size?} (an object that is not a character — e.g. an edge patrol — falls under the project gravity onto colliders below; not with mover, collider or a waypoint patrol); an edges patrol direction on the 2D plane may have a y part (it walks up/down, no ledge probe). ' +
      'Phase 24.4e-i: trigger.sceneTransition {scene, spawn? (a playerSpawn in that scene or the trigger\'s), unload? [sceneIds]} loads the scene and moves the character there on entry; ' +
      'switch.action (interact mode; default interact); faceMovement {mode: "velocity", yawOffset?, turnSeconds?} faces the motion in any direction; playerSpawn.yaw (degrees, 0 = +Z); ' +
      'virtualCamera rig "track" {target, trackOffset?, deadZone? [w,h,d], damping?, boundsMin?, boundsMax?}; setEventCues {cues: [{on: signal|event, name, entity?, assetId (audio), volume?, bus?}]} plays sounds for signals and ctx.events types; ' +
      'scripts: ctx.character.impulse([x,y,z]), ctx.look.set(id, {emissive?, emissiveIntensity?, tint?}) / clear(id) / get(id). Surface presets: applySurfacePreset {entityId, preset: matte-ground|signal-red|emissive-accent}. setSettings also takes the engine settings fixed_step_hz 60|120|240 (120), audio_voices 1-32 (8), music_fade_s 0-10 (1), animation_crossfade_s 0-2 (0.2), render_backend 1|2|3 (1: auto = WebGPU else WebGL 2, the default; 2: WebGPU; 3: WebGL 2; an old 0 means auto; a page URL flag ?renderer=auto|webgpu|webgl2 overrides it), sim_thread 1|2 (1: the simulation runs in a worker, the default; 2: on the main thread of the page; ?threads=off|on overrides it), physics_dimension 2|3 (2: the 2D plane, the default; 3: 3D physics — every box collider then needs hz, its half depth, colliders may rotate on any axis and scale, polygons are 2D-only; 3D collider shapes: sphere {radius}, capsule {radius, height}, convex {points [[x,y,z]...] 4-64}, mesh {vertices [[x,y,z]...] <=1024, triangles [[a,b,c]...] <=2048; static}; triggers: box size [w,h,d], sphere {radius}, capsule {radius, height}; switches are 2D-only), random_seed 0-4294967295 (0: the seed of ctx.random in scripts; the same seed gives the same numbers in every run and replay), audio_spatial 0|1|2 (0: automatic = 2D by X distance to the player, 3D panned; 1: by distance; 2: panned, the listener on the active camera). Scenes: createScene {name, sceneId?}, ' +
      'renameScene {sceneId, name}, deleteScene {sceneId} (only an empty scene), setStartScenes {sceneIds} (the ' +
      'scenes the game starts with; the camera, the character and start spawn live only in start scenes; lights belong to any scene: the most recently loaded scene\'s directional, ambient and hemisphere light is on, point/spot lights of all loaded scenes share a budget of 16; a spot light may carry cookie: a texture assetId projected through its cone). ' +
      'createEntity/instantiatePrefab take sceneId (default: the first scene; with parentId, the parent\'s scene); ' +
      'one command edits one scene and entity ids are unique across scenes. An instance set is ' +
      'setComponent "instances" {asset:{assetId, piece?}, buffer:<sha256 of a staged buffer>, count}. Models: createEntity kind "model" ' +
      'takes model {asset:{assetId}, piece?} — piece names one piece of a multi-piece GLB (the base name of its <piece>_LOD0..n / ' +
      '<piece>_COL nodes, or a top-level node); LOD nodes switch by screen size and _COL nodes are never drawn. A folder create ' +
      'may carry children: [createEntity args without parentId] (up to 256, one undo). createEntity also takes active, locked, static (booleans) ' +
      'and tags ([tag names]). createEntities {entities: [createEntity args + ref?], sceneId?} creates up to 1024 in one revision and one undo ' +
      '(a later item\'s parentId may name an earlier item\'s ref; the change lists the created entities in order). deleteAsset {assetId} and ' +
      'deletePrefab {prefabId} remove a record; refused (reference_in_use, the uses in details) while any object, prefab, asset, material, document ' +
      'or a script\'s string literal still names it; the stored bytes stay, one undo restores it. setAssetOptions {assetId, vertexColors: ' +
      '"data"|"tint"}: COLOR_0 is shader data by default, "tint" multiplies it into the base colour. pasteEntities {entities: [full entity ' +
      'values as tl_inspect returns them, parents with their children], parentId?: id|null, offset?: [x,y,z], sceneId?} copies them with ' +
      'new ids in one undo (references inside the copy are remapped; use it to duplicate or to copy between scenes). Materials: ' +
      'setMaterial {material: {materialId, name, shader: standard|foliage|kit|unlit|water, params: {...overrides}, textures: {slot: ' +
      'textureAssetId}}} creates or replaces one (on a model it starts from the file\'s own material and changes only what it sets); ' +
      'deleteMaterial {materialId}; objects use them with setComponent "materials" {<source material name or "*">: materialId}, a ' +
      'model asset for every placement with setAssetOptions {assetId, materials: {...}|null}. A graph material adds graph: {nodes, edges, groups?, comments?} (graph kind ' +
      '"material": the graph replaces shader/params/textures at render time: it compiles to a node material in the Scene view, Play and exports; the file\'s own material is not used) and ' +
      'parameters: [{key (identifier), type: float|vec2|vec3|vec4|color|texture|data, default, min?, max?, size? (data: [w, h] cells 1-64; default = the RGBA bytes every cell starts with), visibility?: public|private, label?, group?, tooltip?}] ' +
      '(read by Parameter nodes {key}); its graph is then edited with graphEdit {owner: {kind: "material", id: materialId}, ops}; objects override public parameters ' +
      'with setComponent "materialParams" {<materialId>: {<key>: value}} (private ones are refused; data parameters are written by scripts: ctx.materials.setData, read by Sample data nodes). Material functions (reusable sub-graphs) are standalone graphs of kind ' +
      '"material-function" (setGraph; Function input {name, type, default} / Function output {name, type} nodes are the ports of every Function call {function: graphId} node; ' +
      'calls may not form a cycle; a function whose ports are wired in a material cannot drop them). setEnvironment {environment: {wind: ' +
      '{direction: [x, z], strength, gust, gustFrequency, turbulence}, sky?: {mode: procedural|gradient|texture|color, ...}, fog?: {mode: none|linear|exp2, color, near?, far?, density?}, ' +
      'post?: {toneMapping?, exposure?, bloom?, grading?: {brightness?, contrast?, saturation?, tint?, lut?, lift? -0.5..0.5, gamma? 0.2..5, gain? 0..4}, vignette?, ssao?, dof?, antialias?}, quality?, presets?: [{presetId, name, sky?, fog?, post?, lights?: [{entity|tag|type, color?, intensity?, direction?, groundColor?}], lightmap?: {intensity?, tint?}}] (phase 23.18: named looks scripts switch/blend to with ctx.environment.set(id, {blend, easing, override}) / blend(a, b, t); tl_game_observe reports environment {target, progress, weights})}} ' +
      '(the foliage shader bends by COLOR_0.r); a fogVolume component {size, density, color, falloff?, heightFalloff? per m (density fades above the box bottom)}. Cameras (phase 23.4): a virtualCamera component {rig: follow|orbitPoint|topDown|fixed|rail, priority?, enabled?, target? (entity), targetOffset?, distance?, yaw?, pitch?, pitchMin/Max?, yawAction?/pitchAction?/zoomAction?/turnLeftAction?/turnRightAction? (input action names), yawStep?, turnTime?, point?, collision?, damping?, path? (rail: the entity with a cameraPath {points: [[x,y,z]...], closed?, smooth?}), progress?, railSpeed?, railMode?, fovY?, near?, far?, blend?: cut|linear|eased, blendTime?, letterbox?, shakeAmplitude?/Frequency?/Rotation?} — the enabled one with the highest priority is live (scripts: ctx.camera); tl_game_observe reports the resolved camera. Sockets (phase 23.11): a socketAttach component {target (an entity with a model), node (a node/bone name of its model), position?, rotation?, scale? (offset in the node space), attached? (default true)} — the object rides on that node every step (scripts: ctx.sockets.attach/detach, ctx.animator(id).setSpeed); tl_game_observe reports sockets [{entityId, target, node, position}]. setLighting {sceneId, ' +
      'lighting: null} clears a scene\'s baked lightmaps (bakes are made in the editor\'s Lighting window). Animation: setAnimator {controller: ' +
      '{controllerId, name, parameters: [{name, type: float|int|bool|trigger, default?}], states: [{id, name, motion: {kind: "clip", clip: ' +
      '{assetId, clip, duration}} | {kind: "blend1d", parameter, children: [{threshold, clip}]}, speed, speedParameter?, loop}], transitions: ' +
      '[{from: stateId|"*", to, conditions: [{parameter, op: greater|less|equals|notEquals|true|false|trigger, value?}], duration, exitTime?, ' +
      'interruption?: none|source}], entry, events: [{assetId, clip, time, name}], layers?: [{name, mask: [bone names] (empty = every ' +
      'bone), weight 0-1, weightParameter? (a float param it is multiplied by), states (motion may also be {kind: "empty"}: the layers ' +
      'under show through), transitions, entry}] (up to 3 override layers over the base layer, e.g. an upper-body attack while running; ' +
      'state ids are unique across layers), morphs?: [{target (a morph target name), parameter (a float param: its 0-1 value is the weight)}]}}; deleteAnimator {controllerId}; a model entity plays one ' +
      'with setComponent "animator" {controller, parameters?}. An animation-only GLB (clips, no mesh needed) is marked with ' +
      'setAssetOptions {assetId, clipsFor: rigModelAssetId | null}; its clips then play on that model (matched by bone names) and ' +
      'controllers may name them. The old modelAnimation idle/run/airborne component becomes an animator controller when the project ' +
      'is opened. The player\'s animators get speed, grounded, velocityY and a landed trigger ' +
      'automatically; scripts use ctx.animator(entityId)?.set/trigger/state(layer?). Input: setInput {input: {actions: [{name, type: ' +
      'button|axis1d|axis2d, map: gameplay|ui, bindings: [{kind: "key", code: KeyboardEvent.code} | {kind: "gamepadButton", button} | ' +
      '{kind: "gamepadAxis", axis} | {kind: "keys1d", negative, positive} | {kind: "keys2d", up, down, left, right} | {kind: ' +
      '"gamepadButtons1d", negative, positive} | {kind: "gamepadStick", x, y} | {kind: "pointerButton", button: left|right|middle} | ' +
      '{kind: "pointerPosition"} (axis2d: x, y 0-1 from the top left) | {kind: "pointerDelta"} (axis2d, up positive) | {kind: "pointerAxis", ' +
      'axis: x|y|wheel} (axis1d)], deadZone?, invert?, scale?}], cursor?: {gameplay?: free|locked, ui?: free|locked}} | null} (null = defaults: ' +
      'move, jump, attack, interact, pause, submit, cancel, navigate); scripts read ctx.input.value/pressed/released/held(name), ' +
      'ctx.input.pointer() / pointerPressed/Released/Held(button) and ctx.input.setCursor(free|locked|auto); the cursor hides while a gamepad drives. ' +
      '3D queries (physics_dimension 3): ctx.physics.raycast3d/overlapSphere/overlapBox3d/overlapCapsule/pickAt/pickAtPointer with a filter ' +
      '{tags?, layers?, exclude?}; setCollisionLayers {layers: [name...]} names up to 15 collision layers ("default" is implicit) that ' +
      'collider {layers: [...]} lists. ' +
      'Project saves (v4): setSaveSchema {schema: {version (1+), slots (1-99), migrations?: [{from, name}], sections?: [grid|materials|spawned|storage|dialogue], ' +
      'thumbnail?: {width, height (16-512 px), format: jpeg|webp, quality?}, settings?: [{key, type: bool|number|string|enum, default, label?, min?, max?, values?, ' +
      'engine?: music|sfx|ui|quality}]} | null}; scripts use ctx.saves.write(doc)/read()/save(slot, {title?, chapter?, location?, thumbnail?})/load(slot)/' +
      'delete(slot)/slots()/results()/migration(name, fn)/setting(key)/setSetting(key, value) (1 MiB per slot; saves live in the browser). ' +
      'Gameplay blocks (v4; setComponent or createEntity components): mover {waypoints: [[dx, dy, dz]...] offsets, speed, mode: ' +
      'loop|pingpong|once, wait?, easing?: linear|smooth|gravity (gravity: from rest at each point, constant acceleration), startOn?: signal, stopOn?: signal (holds it), toggleOn?: signal (moves a held one, holds a moving one), reverseOn?: signal (back the way it came), active?: false (held), maxPush? 1-1000 m/s (60: how hard it shoves a player out of its way)} (with a box collider it is a moving platform that carries ' +
      'the player; startOn makes a door); trigger {size: [w, h] (box) | shape: "circle", radius m (instead of size), signal, once?, exitSignal? (sent on leaving), mode?: enter|stay (stay: the signal every step while the player is inside)}; switch {mode: interact|stand, signal, size, once?}; ' +
      'health {max, start?} (any object); collectible, patrol and hitbox (above); collider {oneWay: true} (jump up through, Down+Jump drops), a box shape\'s hz? m (half depth; required when physics_dimension is 3); controller {capsule: {radius 0.05-5 m, height 0.1-20 m (total, >= 2 x radius), offset? [x, y] or [x, y, z] m from the entity origin (z: 3D projects)} | null} is the player\'s collision capsule (absent = radius 0.3, height 1.8, centred; every system uses it: physics, spawn clearance, triggers, collectibles, hitboxes), plus the optional movement tuning acceleration (40 m/s²), deceleration (60), coyoteTime (0.05 s), jumpBuffer (0.0667 s), jumpRelease (0.5), groundSnap (0.1 m), skin (0.01 m), autostep (false), autostepHeight (0.25 m), phase 25.13 climbSpeed (2 m/s), climbAction? (an axis; absent: the move action\'s y), wallSlide (false), wallSlideSpeed (2 m/s), wallJump (false), wallJumpAway? (absent: run speed), wallJumpUp? (absent: jump speed) (null resets one); playerSpawn {yaw?} (v4; degrees about +Y, 0 = +Z; the character\'s face-movement models turn to it on arrival; null = none); audioSource ' +
      '{assetId (audio or music), volume 0-1, range m, distanceModel?: linear|inverse|exponential, refDistance? m (range/4), rolloff? (1)} loops louder as the player comes near (along X), or, with setting audio_spatial 2 (or 0 in a 3D project), through a panner with the listener on the active camera (range = its max distance). ' +
      'Scripts use ctx.signals.emit/on(name), ctx.game.counter/add/health()/setVisible(id, bool), ctx.physics.raycast/overlapBox(center, half)/overlapCircle(center, r) (32 queries/step), ctx.emit({kind: "pose", entityId, rotation?: {yaw?, pitch?, roll?} degrees, scale?: n | [x, y, z]}) in the transform phase for an owned entity and ctx.audio.play(audioAssetId, {volume?, loop?, pitch?, bus?: sfx|music|voice|ui, fadeIn?, entityId?, position?, distanceModel?, refDistance?, maxDistance?, rolloff?}) -> handle (then stop(h, fade?), fade(h, to, s), setVolume/setPitch/setLoop, playing(h), finished(h) the step after it ended; music(id|null, fade?)/releaseMusic (scripts win over the flow\'s music until released), stinger(id, {duck?, fade?}), duck(level, s)/unduck, setBusVolume(bus, v, s)), ctx.save.get/set/remove/keys (kept in the player\'s save), ctx.spawn(prefabId, {position: [x, y] | [x, y, z], rotation?: [x, y, z, w], scale?: n | [x, y, z]}) ' +
      '-> "spawn-<n>" root id or null (a copy of a project prefab in the running game only — its colliders, components and scripts work; it appears at the next step; ' +
      'at most 64 spawns per step and 1024 spawned entities alive; a new run removes them all; saves never keep them) and ctx.destroy(spawnedId) (removes it and its children; ' +
      'an authored entity throws: hide it with setVisible); a script whose source container lists "@self" in ownedTransforms may move its own entity (each carrier, spawned copies included) with transform/pose intents in the transform phase. ' +
      'ctx.timers.after(name, seconds)/every(name, seconds) (step-counted; calling it again with the same length changes nothing, another length restarts it; ' +
      'at most 64 per script instance; a new run clears them), ctx.timers.fired(name) (true in the step it fires), ctx.timers.cancel(name); ' +
      'ctx.events also holds {type: "enter"|"exit", trigger: entityId, stepIndex} (seen the step after) for the triggers the script owns: on its own entity, below it, ' +
      'or named by one of its entityRef properties. ' +
      'Graphs (node graphs; one op set for every graph kind): setGraph {graph: {graphId, kind, name, graph: {nodes: [], edges: []}}} ' +
      'creates or renames a standalone graph (kind "test" is the framework\'s test kind; the kinds\' node catalogues, port types and conversions are in ' +
      'tl_content_query target="game" includeDescriptors (graphKinds); the graphs themselves in target="game" (graphs)); deleteGraph {graphId}; graphEdit {owner: {kind: "graph", id: graphId}, ' +
      'ops: [...]} applies up to 512 ops atomically as ONE undo step: addNodes {nodes: [{id, type, position: [x, y], collapsed?: true, data?: {field: value}}]}, ' +
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
      'systems: [{systemId, name, maxParticles 1-1048576, space: local|world, graph}] (up to 16, evaluation order)}} creates or replaces one (adding/removing a system = setEffect); ' +
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
      'paths end in .ts or .json; up to 16 files, 64 KiB each); a changed library recompiles every published script that imports it in the same command (refused with the compile error ' +
      'naming the script if one no longer compiles, or behavior_trust_unacknowledged {sourceDigest} until acknowledgeBehaviorTrust acknowledges the library\'s new digest); ' +
      'deleteScriptLibrary {libraryId} (refused while a published script imports it). A script may also import .json files of its own source (import data from "./data.json"). ' +
      'Edits larger than one request (the 64 KiB cap) or across several libraries are staged: op stageScriptLibrary {stageId?, libraryId, name?, files?} (no expectedRevision; ' +
      'the setScriptLibrary patch shape, and a file larger than one request comes in pieces: {path, text, append: true} adds to the staged file; without stageId it opens a stage and answers its stageId, the libraries staged and their digests; {stageId, discard: true} drops it) adds ' +
      'one patch at a time without changing the project, then commitScriptLibraryStage {stageId} commits every staged library in one revision and one undo step, recompiling each ' +
      'published script that imports a changed library once (the answer\'s libraryStage.compiled); acknowledge the staged digests first as for setScriptLibrary. ' +
      'Each library is its own shared module in Play and exports (compiled once, minified and tree-shaken; scripts import it instead of carrying a copy). ' +
      'The libraries are in tl_content_query target="game" (scriptLibraries). ' +
      'Block layers (grid levels built from blocks): setBlockType {block: {blockId, name, variants: [{model: {assetId, piece?}} | {prefab} | {color: "#rrggbb"}, weight?], ' +
      'shape: full|half|ramp|stairs|custom|none (collision; ramps/stairs rise toward +Z), boxes? (custom: [x0,y0,z0,x1,y1,z1] in 0-1), solid?, footprint? [x,y,z] cells, ' +
      'rotations? [0,90,180,270], metadata? {field: value}, materials?}} / deleteBlockType {blockId}; setCellFields {fields: [{key, type: bool|enum|int|float|string, default?, values? (enum), min?, max?, color?, label?}]} ' +
      '(the cell metadata schema); an entity gets setComponent "blockLayer" {cellSize: [x,y,z] m, bounds: {min: [x,y,z], max: [x,y,z]} cells (max exclusive), metadataOnly?, collision?} ' +
      '(its position is the min corner of cell 0; a root at identity rotation and unit scale). A prop may carry setComponent "blockFootprint" {layer?: layer entity id, size?: [x,z] cells, set: {field: value}} ' +
      '(the metadata the editor writes into the cells beneath it when it is placed or moved; via MCP write them with an editBlocks meta edit). editBlocks {entityId, edits: [...]} edits one layer as one undo step (cells are {block?, rot? 90|180|270, variant?, meta?}; ' +
      'boxes are [x0,y0,z0,x1,y1,z1] max exclusive): {kind:"fill", box, cell|null, mode?: set|keep|replace}, {kind:"cells", at: [x,y,z,...], cell|null}, ' +
      '{kind:"array", origin, size: [w,h,d], palette: [cell|null,...], data: [count, index, ...] run-length, x fastest then z then y, index -1 leaves a cell}, ' +
      '{kind:"replace", match: {block: id|null, rot?, variant?}, cell|null, box?}, {kind:"meta", set: {field: value|null}, box?|at?, occupiedOnly?} (paint metadata; empty cells become metadata-only cells), ' +
      '{kind:"flood", at, cell|null, connectivity?: xz|xyz}, {kind:"column", at: [x,z,...], delta: ±n, cell?} (raise/lower), {kind:"stamp", stampId, at, rot?, mirror?: x|z, mode?}, ' +
      '{kind:"copy", box, to, rot?, mirror?, move?, mode?} (copy/move/mirror a selection), {kind:"region", regionId, op: set|add|remove|delete|rename, boxes?, to?} (named regions), ' +
      '{kind:"heightmap", png: base64 greyscale PNG, origin: [x,z], y, scale (cells for white), cell, keepAbove?, colors?: {png, map: [{color, cell}]}} (import a heightmap; the colour map picks each column\'s cell). ' +
      'The change names the chunks [cx,cz] (16×16 columns) and regions touched; read cells back with tl_content_query target="blocks". Keep each request under 64 KiB (use boxes and runs). ' +
      'setBlockStamp {stamp} or {stampId, name, entityId, box} (save a selection) / deleteBlockStamp {stampId}. ' +
      'Project UI (drawn by the game host over the view, in Play and exports): setUiDocument {document: {uiDocumentId, name, layer? (-100..100), modal?, focus? (takes keyboard/gamepad focus; default modal), ' +
      'actionMap? (gameplay|ui: the only input map active while it has focus), theme? (uiThemeId), scale? {reference: [w, h], mode: fit|width|height}, styles? {name: style}, icons? {name: {asset: texture, rect?: [x, y, w, h]}}, ' +
      'tweens? {name: {kind: fade|slide|scale|stamp, duration 0.01-10 s, delay?, easing?: linear|easeIn|easeOut|easeInOut|back, from?, to?, direction?: left|right|up|down, distance?}}, showTween?, hideTween?, initialFocus? (widget id), onCancel? (action), root: widget}} ' +
      'creates or replaces one (whole JSON, ≤ 48 KiB, ≤ 512 widgets, depth ≤ 16); deleteUiDocument {uiDocumentId}; setUiTheme {theme: {uiThemeId, name, styles, icons?}}; deleteUiTheme {uiThemeId}. ' +
      'A widget: {type: panel|stack|grid|text|image|bar|button|list|input, id?, anchor? [0-1, 0-1], pivot?, offset? [px, px], size? [w|null, h|null], stretch?: x|y|both, margin? [l, t, r, b], grow?, style?: name|[names], css?: style, ' +
      'visible?/enabled?: bool|{bind}, focusable?, nav? {up, down, left, right, next, prev: widget ids}, worldAnchor? {entity: id|{bind} | point: [x, y, z], offset?, clamp?, margin?, indicator?: child id}, onFocus?, children? (panel anchors them; stack direction row|column, gap, align, justify, wrap; grid columns, cellSize), ' +
      'text (rich: [b] [i] [color=#hex] [size=N] [icon=name], {path} values, {action:name} the glyph of an input action), image {image: texture|{bind}, slice? [t, r, b, l], fit?, tint?}, bar {value, min?, max? (numbers or {bind}), direction?: right|left|up|down, shape?: linear|radial, fillColor?, fillStyle?}, ' +
      'button {text?, children?, onClick}, list {items: {bind}, template: widget ($item.x, $index in its bindings), direction?: row|column|grid}, input {value?, placeholder?, maxLength?, onSubmit}}. ' +
      'A style (never raw CSS): color, background, backgroundImage (texture) + slice, opacity, font (a font asset or sans|serif|mono|rounded), fontSize, bold, italic, align, lineHeight, letterSpacing, padding, radius, borderWidth, borderColor, textShadow, shadow, and hover|focus|pressed|disabled variants. ' +
      'An action: {do: "event", name, value?} (a UI event for scripts on the next input frame), {do: "engine", action: resume|pause|restartLevel|newGame|continue|quitToTitle|settings|load|save|back|setSetting|mute|unmute|rebind|cancelRebind|resetBindings|open|nextScene, screen? (open: title|pause|settings|controls|save|load), slot?, setting?, value?, step?, input? (rebind/resetBindings: the input action), device?, index?, part?, policy? swap|refuse|allow}, ' +
      '{do: "show"|"hide"|"toggle", doc}, {do: "play", tween, widget?}. Bindings read the scripts\' view model (ctx.ui.set(path, value)); $flow.* reads the host values (the shell screen, volumes, slots, counters, health, prompts). ' +
      'The game shell: setShell {shell: {screens?: {title|pause|settings|controls|save|load: uiDocumentId}, hud?: [uiDocumentId], scenes?: [{scene, spawn?}], pause?, status?} | null} draws its menus and HUD with UI documents (save/load use the project saves); HUD bindings read $flow.counters.<name>, $flow.health.<objectId>.current|max, $flow.prompts (generated from the input actions) and $flow.shell (screen, scene, canContinue, saves.<n>.label, note); tl_game_observe reports shell {screen, scene, hud}. Scripts: ctx.ui.set/get/clear, show/hide/isShown, play, focus, events()/event(name). ' +
      'They are in tl_content_query target="game" (uiDocuments, uiThemes); tl_game_observe reports ui {shown, screen, focus, actionMap}. ' +
      'Text widgets may also take content: {bind} (rich text from the view model) and reveal: number|{bind} (a typewriter); an action {do: "dialogue", input: advance|choose|skip|auto|backlog, value?} is a dialogue input. ' +
      'Dialogue (phase 23.16): setDialogue {dialogue: {dialogueId, name, graph?}} creates (graph absent: a Start node) or renames a conversation; its graph is owner kind "dialogue" (owner id = dialogueId, graph kind dialogue) edited with graphEdit: ' +
      'nodes start (fixed), entry {name}, line {speaker (speakerId|$binding|""), expression, text (rich text, {var}/{$binding} values, [pause=0.5]), voice (audio or music asset), auto: default|on|off}, choice (outputs options → option nodes, none), ' +
      'option {text, condition, effects, once}, branch {condition} (outputs true/false), set {effects}, signal {name, value, wait}, wait {seconds}, jump {dialogue, entry}, end; wires port "next". ' +
      'Conditions: variables, $bindings, numbers, "texts", true/false/null, ! not, * / %, + -, < <= > >=, == !=, && and, || or, seen("nodeId"); effects: "name = value; count += 1; x -= 2". ' +
      'deleteDialogue {dialogueId}; setSpeaker {speaker: {speakerId, name, color? #rrggbb, portraits? {expression: texture}, defaultExpression?, voiceProfile?, blip? (audio), blipEvery?, blipVolume?}}; deleteSpeaker {speakerId}; ' +
      'setDialogueSettings {settings: {textSpeed? (chars/s, 0 instant), autoAdvance?, autoDelay?, duck? (music/SFX level under a voice), backlog?, document? (uiDocumentId; absent: the engine document "tl-dialogue"), theme?} | null}. ' +
      'Scripts: ctx.dialogue.start(id, {entry?, node?, bindings?}), advance, choose, skip, setAuto, resume, stop, current, events, get/set variables, seen, history. ' +
      'Game modes: setModes {modes: [{modeId, name, inputMaps? (gameplay|ui|input.maps names; absent: every map — actions of other maps read as released), camera? (a virtualCamera object, live over priorities while the mode is), ' +
      'ui? (uiDocumentIds shown while active), groups? (behavior groups that tick; absent: all), ungrouped?: tick|pause, pause? (engine pause allowed, default true), pauseScreen? (uiDocumentId drawn while paused; absent: the engine panel), ' +
      'timeScale? (0.1-4), physics?: run|hold, enter? {blend?: cut|linear|eased, blendTime?, fade? (uiDocumentId shown for fadeTime s), fadeTime?}}]} replaces the whole list (the first is the start mode; ≤ 16); ' +
      'setBehaviorGroups {groups: [names]}; an object joins a group with setComponent behaviorGroup {group}; setInput input.maps [names] adds project input maps. A UI action {do: "mode", mode} switches from a button. ' +
      'Scripts: ctx.modes.current/previous/is/switch(id, {blend?, blendTime?, fade?, fadeTime?})/events()/entered(id?)/exited(id?)/time() (a switch applies at the next step; enter/exit events in that step); ' +
      'ctx.lifecycle.respawn(spawnId?)/setSpawn/spawnPoint/restart() for a game without the game session block. tl_game_observe reports mode {current, previous, since, pending, pause, inputMaps, timeScale, physics, modes} and paused. ' +
      'Timelines (sequencer, played in the simulation step): setTimeline {timeline: {timelineId, name, duration (s, ≤ 600), slots? [{name, entity? (default binding)}], markers? [{name, time}], skipAction? (input action), playOnStart?, playOnSignal?, ' +
      'tracks: [{trackId, type, name?, muted?, target? (a slot: transform|animator|activation|material), keys: [{time, …}]}]}} creates or replaces one (≤ 48 KiB, 32 tracks, 256 keys each); deleteTimeline {timelineId}. Track types and key fields: ' +
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
      'Bounded, read-only M2 content queries. target="assets" pages the asset catalog (limit ≤ 128, default 50); ' +
      'target="asset" returns one record with assetId (includeVersions optional); target="prefabs" pages prefab ' +
      'summaries (includeEntities optional); target="behaviors" pages behavior summaries (includeDeclaration ' +
      'optional); target="integrity" returns the bounded content-integrity report (a file referenced in place is ' +
      'ok / changed / missing); target="game" returns the ' +
      'full normalized `content.game` block (the v3 `queryGameConfig`, or null; includeDescriptors adds the ' +
      'component and content descriptor registry: every field\'s type, unit, range, default, label, tooltip and ' +
      'Scene handle, ~120 KB); target="projectFiles" lists one ' +
      'folder of the game folder (dir relative to the folder holding thirdlight.json; subfolders and .glb/.fbx/.wav ' +
      'files) for tl_content_upload projectPath; target="blocks" reads block layers: without entityId the layers ' +
      '(component, cell count, chunks, regions; sceneId optional), with entityId one layer — chunks [[cx,cz],…] in their stored ' +
      'form, box [x0,y0,z0,x1,y1,z1] its cells as [x,y,z,paletteIndex] with each value\'s effective metadata, or region (its ' +
      'boxes and cells). Never returns bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['assets', 'asset', 'prefabs', 'behaviors', 'integrity', 'game', 'projectFiles', 'blocks'] },
        sceneId: { type: 'string', description: 'target="blocks": the scene whose layers are listed' },
        entityId: { type: 'string', description: 'target="blocks": one block layer (the entity carrying blockLayer)' },
        chunks: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, description: 'target="blocks": [[cx, cz], …] chunks to read' },
        box: { type: 'array', items: { type: 'integer' }, description: 'target="blocks": [x0, y0, z0, x1, y1, z1] cells to read' },
        region: { type: 'string', description: 'target="blocks": a region id of the layer' },
        dir: { type: 'string', description: 'target="projectFiles": a folder relative to the game folder ("" = the game folder)' },
        assetId: { type: 'string' },
        prefabId: { type: 'string' },
        behaviorId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 128 },
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
      'import_rejected error carrying the ordered diagnostics). dataBase64 ≤ 32 MiB decoded. The command that ' +
      'commits the content is submitted separately with tl_command (publishAsset), so dedup precedes any stage lookup. ' +
      'For a project in a game folder, projectPath instead inspects a file already in that folder in place (nothing ' +
      'is copied): the result carries sourcePath, which the publishAsset args must include so the version references ' +
      'the file. Give exactly one of dataBase64 or projectPath. An FBX (either way) is converted to GLB by Blender on ' +
      'the server first: the result then carries convertedFrom (not sourcePath), which the publishAsset args must include. ' +
      'kind "font" inspects a TrueType (.ttf), OpenType (.otf), WOFF2 or WOFF font (<= 4 MiB; at most 16 fonts per project) for the project UI; publish it with kind "font".',
    inputSchema: {
      type: 'object',
      properties: {
        dataBase64: { type: 'string', description: 'base64 of the source bytes (≤ 32 MiB decoded)' },
        projectPath: {
          type: 'string',
          description: 'a .glb/.fbx/.wav file relative to the game folder (the folder holding thirdlight.json), forward slashes, e.g. assets/props/crate.glb',
        },
        displayName: { type: 'string' },
        kind: { type: 'string', enum: ['model', 'audio', 'texture', 'music', 'font'] },
        animation: {
          type: 'object',
          description: 'request the role-aware animated GLB profile (presentation.md §41.3.3)',
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
      'frames ≤ 600 ascending by stepOffset, body ≤ 16 KiB; each frame {stepOffset, actions?, pointer?} (input frame version 2: ' +
      'no fixed move/jump channels): actions {<action name>: {v, x?, y?, p: none|pressed|held|released}} - the character ' +
      'controller reads its move and jump actions (default names move and jump: move {v: -1..1} walks along x, or {v, x, y} ' +
      'for a 2D move where a 3D character walks along (x, y) relative to the camera; jump {v: 0|1, p}), scripts read any action ' +
      'with ctx.input; an action absent from a frame is released. Optional pointer: {x, y (0-1 of the view, 0,0 top left), dx?, dy?, wheel?, buttons?, pressed?, released? ' +
      '(masks: 1 left, 2 right, 4 middle), over?, locked?} (a frame without one keeps the last position and held buttons; a button ' +
      'going down between frames is a click - ctx.input.pointerPressed, ctx.physics.pickAtPointer). Returns the applied ' +
      'step range plus the pinned snapshotId/buildId, or the structured session_unavailable outcome when no browser is ' +
      'connected (never a simulated success). No DOM injection, no eval.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        frames: {
          type: 'array',
          minItems: 1,
          maxItems: 600,
          items: {
            type: 'object',
            properties: {
              stepOffset: { type: 'integer', minimum: 0 },
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
                description: 'phase 23.3: the pointer this step (a frame without one keeps the last position and held buttons)',
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
      },
      required: ['playSessionId', 'frames'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_instance_buffer',
    description:
      'Publish an instance-set buffer (phase 12 c): the placements of many copies of one model, drawn with ' +
      'instancing as ONE entity (foliage, rocks, repeated detail). transforms is a flat list of 10 numbers per copy ' +
      '(position x y z, rotation quaternion x y z w, scale x y z; local to the entity), 1-4096 copies. Returns ' +
      '{digest, count}; then create the entity with tl_command createEntity {kind:"group", components:{instances:' +
      '{asset:{assetId}, buffer:digest, count}}} or setComponent "instances". Publishing changes no project state. ' +
      'Phase 15.2: give digest instead (an instance set\'s buffer) to READ its copies ({digest, count, transforms}; sets of up to ' +
      '4096 copies) - to move, turn, scale, delete or add single copies, edit that list, publish it and setComponent "instances" ' +
      '{buffer, count} (one undo step; the editor\'s copy editing and brush do exactly this).',
    inputSchema: {
      type: 'object',
      properties: {
        transforms: { type: 'array', items: { type: 'number' }, minItems: 10, maxItems: 40960 },
        digest: { type: 'string', description: 'read this buffer (64 hex) instead of publishing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_control',
    description:
      'Submit one bounded §20 game-control command (replay (restart the game: the start scenes, every object as authored), mute, unmute, clearSave (forget the game\'s saves in this browser), or loadScene / unloadScene with ' +
      'sceneId - the same request a script makes with ctx.scenes; debugPause / debugResume / debugStep hold the simulation at a step boundary, ' +
      'release it, or run exactly one step while held - the visual-script debugger; tl_game_observe shows debug {paused, hit {behaviorId, entityId, nodeId, stepIndex}}; ' +
      'phase 23.8: debugCommand with name and args runs a project debug command - one a script declared with ctx.debug.command(name, {description, args: [{name, type: number|string|boolean, optional}]}, handler?) - ' +
      'inside the next simulation step as part of its input (a recording replays it; tl_game_observe lists debugCommands {registered, applied [{stepIndex, name, args}]}); ' +
      'refused (game_command_invalid) when no script declared it or the args do not match) to an explicitly presented play ' +
      'session. expectedRunId is an optional optimistic guard (<snapshotId>#<replayEpoch>); a mismatch is refused ' +
      'with game_run_stale and no command is applied. The result is the preview\'s exact accepted result (identity ' +
      'tuple + play state running|paused); replay restarts the game; with no connected/presenting browser the contracted session_unavailable is returned - ' +
      'never a fabricated success. Body <= 4 KiB; no gameplay simulation, no eval.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        command: { type: 'string', enum: [...GAME_CONTROL_COMMANDS] },
        expectedRunId: { type: 'string' },
        sceneId: { type: 'string', description: 'loadScene / unloadScene: the scene' },
        name: { type: 'string', description: 'debugCommand: the debug command a script declared' },
        args: { type: 'object', description: 'debugCommand: its arguments by name (numbers, text up to 256 characters, true/false; at most 8)', additionalProperties: { type: ['number', 'string', 'boolean'] } },
      },
      required: ['playSessionId', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_observe',
    description:
      'Read one bounded §20 observation document (<= 16 KiB) from an explicitly presented play ' +
      'session: `state` running|paused (the engine pause holds the simulation: a menu, the pause panel, a game mode), stepIndex, simTime, `player` {x, y, z} (the controller object\'s position), ' +
      '`scenes` {loaded, loading}; the observation is bounded and carries no ' +
      'GLB/WAV bytes, base64 media, authoring token or locator capability; `animators` maps each animated entity to its ' +
      'current animator state; `counters` the named counters (collectibles and scripts add to them); `health` every object\'s health {objectId: {current, max}}; `shell` {screen, scene, hud} the game shell; `spawned` {count, ids (first 64)} the live entities scripts spawned; `audio` (once scripts used ctx.audio or a panned audio source plays; the Web Audio graph state, not heard sound) voices [{handle (0: an audio source, see key), assetId, bus, state playing|pending|stopping, loop, gain, rate, pan? (-1 left..1 right of the listener), distanceGain?, distance?, position?}] (first 24; voiceCount all), music {owner script|shell, assetId, playing, duck}, buses {sfx, music, voice, ui}, listener {position, rotation} (the active camera), panningModel; with entityId, `behaviors` {entityId, scripts: [{behaviorId, properties: [{key, label, type, visibility, value}]}]} — the values the entity\'s running scripts read, private ones included (read-only); `renderer` {requested, source, backend, api, state, reason} the renderer backend that draws the play and why; `effects` {executor: webgpu|cpu, caps {particlesPerSystem, particlesTotal, instances, lights, sortLimit}, playing, particles, refused, lights} the visual-effect player (WebGPU compute on WebGPU, the CPU fallback on WebGL 2; presentation only); `simulation` {mode: worker|single, transport: message|shared|null, isolated} where the play runs its simulation (phase 22); `saves` (a project with a save schema) {slotCount, storage, slots: [{slot, title, chapter, location, playSeconds, savedAt, version, bytes, thumbnail? {type, width, height, bytes}, damaged?}] (the first 32 used slots), settings (the project settings document)}. timeoutMs 250-15000 (default 5000). ' +
      'With no connected/presenting browser the contracted session_unavailable is returned; a relay that exceeds ' +
      'timeoutMs is game_relay_timeout (503) - never a simulated value. A play that ended answers play_not_found with ended {reason, presented, at, detail?} and a message saying why (e.g. it ended before it was presented because the editor page reloaded).',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 250, maximum: 15000 },
        entityId: { type: 'string', description: 'also return this entity\'s running script property values (public and private) as `behaviors`' },
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
      'playSessionId + the frozen snapshotId/revision on success. Phase 23.8 test/debug starts (the editor\'s "Play from..." sends the same): ' +
      'sceneId - start there (the scene loads with the start scenes and the character starts at its first player spawn); ' +
      'variables - {key: JSON value} the scripts read with ctx.save from step 0 (<= 64 keys, <= 4 KB each); ' +
      'save - a project save document {format: "thirdlight.save", formatVersion: 2, version, playSeconds?, doc, sections?, world: {scenes, activeSpawn, listedScene, character: {position, velocity} | null}} (a project with a save schema; <= 1 MiB; loaded at the first step, older versions migrated; world puts the character back where it was saved; a formatVersion 1 document without world still loads) or saveSlot 1-99 (a project slot of the Play page); ' +
      'mode - the game mode the run starts in (checked against content.modes; ignored and noted in start.notes when the project has none). ' +
      'The result echoes the resolved start; tl_game_observe reports start {ok, applied | reason}.',
    inputSchema: {
      type: 'object',
      properties: {
        demo: { type: 'boolean' },
        sessionId: { type: 'string', pattern: '^sess-[0-9a-f]{32}$' },
        sceneId: { type: 'string', description: 'start Play at this scene' },
        mode: { type: 'string', description: 'a game mode id (applies once the project has game modes)' },
        variables: { type: 'object', description: 'script variables: what ctx.save holds from step 0' },
        save: { type: 'object', description: 'a project save document (format "thirdlight.save") to continue from' },
        saveSlot: { type: 'string', pattern: '^[1-9][0-9]?$', description: 'continue from this project save slot of the Play page (1-99)' },
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
      'export failures, external file edits) and whether editing is paused. With playSessionId: bounded ' +
      'runtime diagnostics (≤ 16 KiB) from that play\'s connected preview; its renderer block names the backend ' +
      'that draws (renderer.backend legacy|webgpu|webgl2, renderer.state) and why (renderer.reason); renderer.effects is the ' +
      'visual-effect player: executor webgpu|cpu with its caps, what plays, refused plays, unknown effect ids, per-effect executor and why an effect runs on the CPU on WebGPU. ' +
      'startTimings is where the start went (stages in ms from the page\'s time origin, the first frame, slow frames after it, each scene loaded since) and buildTimings the backend\'s part. ' +
      'runtime.errors holds the last script logs (code behavior_log) and errors; an entry with a compiled position (at, frames) also has source (and sources) ' +
      '{behaviorId | libraryId, path, line, column}: the place in the project\'s own script or library file. ' +
      'A play that ended answers play_not_found with ended {reason, presented, at, detail?} and why in the message; one that ended before it was presented is also in the problems.',
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_screenshot',
    description:
      'Capture a bounded screenshot (dataUrl ≤ 1 MiB, maxWidth 256–2048) from a play session\'s ' +
      'selected connected browser preview. Fails structurally if the play is not presented or the ' +
      'editor browser is not connected; a capture the preview cannot make says why (error.cause and ' +
      'message). A PNG over the bound comes back smaller (see width).',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        maxWidth: { type: 'integer', minimum: 256, maximum: 2048 },
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
  if (target !== 'project' && target !== 'entity' && target !== 'entities') {
    return toolError('target must be "project", "entity", "entities", or "selection"');
  }
  let op: string;
  let argsOut: Record<string, unknown>;
  if (target === 'project') {
    op = 'queryProject';
    argsOut = {};
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
  // Phase 25.9: a staged library patch goes to the library stage route (it changes no revision).
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
  // sessions.md §10.1: the play-start body is `{ options: { demo } }` (demo
  // boolean, default true) — `demo` nests under `options`, not at the top level.
  const body: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  if (a.demo !== undefined) {
    if (typeof a.demo !== 'boolean') return toolError('demo must be a boolean');
    options.demo = a.demo;
  }
  // Phase 23.8: the start options go in `options` too (the backend validates and resolves them).
  for (const k of ['sceneId', 'mode', 'variables', 'save', 'saveSlot'] as const) if (a[k] !== undefined) options[k] = a[k];
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
    return toolOk({ ok: true, workspace, total: problems.body.total, problems: problems.body.problems });
  }
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId must be a non-empty string');
  const res = await ctx.client.diagnostics(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function screenshot(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  let maxWidth: number | undefined;
  if (a.maxWidth !== undefined) {
    if (!isInt(a.maxWidth) || a.maxWidth < 256 || a.maxWidth > 2048) return toolError('maxWidth must be an integer 256–2048');
    maxWidth = a.maxWidth;
  }
  const res = await ctx.client.screenshot(ctx.projectId, a.playSessionId, maxWidth);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** sessions.md §18.1: bounded exclusive-test input relay (semantic actions only). */
async function inputExercise(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  if (!Array.isArray(a.frames) || a.frames.length < 1 || a.frames.length > 600) {
    return toolError('frames must be an array of 1–600 entries');
  }
  const frames: Array<Record<string, unknown>> = [];
  let previous = -1;
  for (let i = 0; i < a.frames.length; i += 1) {
    const raw = a.frames[i];
    if (!isObj(raw)) return toolError(`frames[${i}] must be an object`);
    const { stepOffset, actions } = raw;
    // Phase 24.8: frame version 2 has no fixed channels.
    for (const old of ['moveX', 'moveY', 'jump']) {
      if (raw[old] !== undefined) return toolError(`frames[${i}].${old} is not a frame field (input frame version 2): use actions {move: {v}, jump: {v, p}}`);
    }
    if (!isInt(stepOffset) || stepOffset < 0) return toolError(`frames[${i}].stepOffset must be an integer ≥ 0`);
    if (stepOffset <= previous) return toolError('frames must be strictly ascending by stepOffset');
    previous = stepOffset;
    if (actions !== undefined && !isObj(actions)) return toolError(`frames[${i}].actions must be an object`);
    // Phase 23.3: the pointer too.
    if (raw.pointer !== undefined && !isObj(raw.pointer)) return toolError(`frames[${i}].pointer must be an object { x, y, ... }`);
    // The named actions reach the game (the backend validates them).
    frames.push({ stepOffset, ...(actions !== undefined ? { actions } : {}), ...(raw.pointer !== undefined ? { pointer: raw.pointer } : {}) });
  }
  const body = JSON.stringify({ mode: 'exclusive-test', frames });
  if (body.length > 16_384) return toolError('the relay body exceeds the 16384-byte bound');
  const res = await ctx.client.inputRelay(ctx.projectId, a.playSessionId, { mode: 'exclusive-test', frames });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

// ---- packet 25 content tools --------------------------------------------------

/** Bounded M2 content queries (commands.md §4/§5.6 + the content routes). */
async function contentQuery(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const target = a.target;
  if (target === 'projectFiles') {
    const dir = a.dir ?? '';
    if (typeof dir !== 'string') return toolError('dir must be a string');
    const res = await ctx.client.listProjectFiles(ctx.projectId, dir);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'integrity') {
    const res = await ctx.client.contentIntegrity(ctx.projectId);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // Packet 48 repair: the v3 game-config query (commands.md §3.1.11/§A6) over
  // the same shared command surface; no args.
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
  // Phase 23.5: block-layer cells and regions.
  if (target === 'blocks') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'entityId', 'chunks', 'box', 'region'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'queryBlocks', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  return toolError('target must be "assets", "asset", "prefabs", "behaviors", "integrity", "game", "projectFiles" or "blocks"');
}

function pageArgs(a: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: CallToolResult } {
  const args: Record<string, unknown> = {};
  if (a.limit !== undefined) {
    if (!isInt(a.limit) || a.limit < 1 || a.limit > 128) return { ok: false, error: toolError('limit must be an integer 1–128') };
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
  if (a.projectPath !== undefined) {
    if (a.dataBase64 !== undefined) return toolError('give either dataBase64 or projectPath, not both');
    return projectFileInspect(ctx, a);
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
  // Packet 48: the additive inspect request selects the bounded PCM-WAV
  // inspector or the role-aware animated GLB profile (presentation.md §41.3.3).
  const inspectBody: Record<string, unknown> = {};
  if (a.kind !== undefined) {
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'music' && a.kind !== 'font') return toolError('kind must be "model", "audio", "texture", "music" or "font"');
    inspectBody.kind = a.kind;
  }
  if (a.animation !== undefined) {
    if (!isObj(a.animation)) return toolError('animation must be an object');
    const roles = a.animation.roles;
    if (!isObj(roles)) return toolError('animation.roles must be an object');
    inspectBody.animation = a.animation;
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
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'music' && a.kind !== 'font') return toolError('kind must be "model", "audio", "texture", "music" or "font"');
    body.kind = a.kind;
  }
  if (a.animation !== undefined) {
    if (!isObj(a.animation) || !isObj(a.animation.roles)) return toolError('animation.roles must be an object');
    body.animation = a.animation;
  }
  const res = await ctx.client.inspectProjectFile(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

// ---- packet 48 §20 game control/observation relay tools -----------------------

/** Phase 12 (c): publish an instance-set buffer (inline transforms). */
async function instanceBuffer(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (a.digest !== undefined) {
    if (a.transforms !== undefined) return toolError('give transforms (publish) or digest (read), not both');
    if (typeof a.digest !== 'string' || !/^[0-9a-f]{64}$/.test(a.digest)) return toolError('digest must be 64 lowercase hex characters');
    const read = await ctx.client.readInstanceBuffer(ctx.projectId, a.digest);
    if (!read.ok) return surfaceBackendError(read.response);
    const count = Math.floor(read.floats.length / 10);
    if (count > 4096) return toolError(`the buffer holds ${count} copies; reading returns sets of up to 4096 copies`);
    // 9 significant digits: every float32 reads back to the same value when republished.
    return toolOk({ ok: true, digest: a.digest, count, transforms: Array.from(read.floats, (v) => Number(v.toPrecision(9))) });
  }
  const t = a.transforms;
  if (!Array.isArray(t) || t.length === 0 || t.length % 10 !== 0 || t.length > 40960 || !t.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return toolError('transforms must be a flat list of finite numbers, 10 per copy, 1-4096 copies');
  }
  const res = await ctx.client.publishInstanceBuffer(ctx.projectId, { transforms: t });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** sessions.md §20.1: bounded game-control relay (never a simulation). */
async function gameControl(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  if (typeof a.command !== 'string' || !(GAME_CONTROL_COMMANDS as readonly string[]).includes(a.command)) {
    return toolError(`command must be one of ${GAME_CONTROL_COMMANDS.join(', ')}`);
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
  // Phase 23.8: a debug command's name and arguments.
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
  const res = await ctx.client.gameControl(ctx.projectId, a.playSessionId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** sessions.md §20.1: bounded read-only observation relay (never a simulation). */
async function gameObserve(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const body: Record<string, unknown> = {};
  if (a.timeoutMs !== undefined) {
    if (!isInt(a.timeoutMs) || a.timeoutMs < 250 || a.timeoutMs > 15000) return toolError('timeoutMs must be an integer 250–15000');
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
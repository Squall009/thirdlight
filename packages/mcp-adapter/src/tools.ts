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
const M3_MUTATION_OPS = ['applySurfacePreset', 'setGameConfig', 'updateEntity', 'moveEntities', 'setTags', 'setAssetOptions', 'pasteEntities', 'setMaterial', 'deleteMaterial', 'setEnvironment', 'setLighting', 'setAnimator', 'deleteAnimator', 'setInput', 'setFlow', 'createScene', 'renameScene', 'deleteScene', 'setStartScenes', 'setGraph', 'deleteGraph', 'graphEdit'] as const;
const MUTATION_OPS = [...M1_MUTATION_OPS, ...M2_MUTATION_OPS, ...M3_MUTATION_OPS] as const;
const QUERY_OPS = ['queryProject', 'queryEntity', 'queryEntities', 'queryAssets', 'queryPrefabs', 'queryBehaviors'] as const;
/** The closed §20 control command set (sessions.md §20.1). */
const GAME_CONTROL_COMMANDS = ['start', 'replay', 'mute', 'unmute', 'loadScene', 'unloadScene', 'clearSave', 'debugPause', 'debugResume', 'debugStep'] as const;
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
      'event.animator {event?, entity?}, event.timer {timer}, event.message {message, type} (sent with api.messages.send). Flow: flow.branch, sequence, for, foreach, while ' +
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
      'instantiatePrefab (a prefab keeps the source\'s collider, surface, materials, animator, mover, trigger, switch, pickup, enemy, ' +
      'audioSource and faceMovement; a collider only on its root; never the player controller or scene wiring). Game ops: applySurfacePreset, setGameConfig (v4: optional respawnDelay 0-10 s (0.25), dropThroughTime 0.01-2 s (0.125), settleTime 0-1 s (0.1); null resets one). setSettings also takes the engine settings fixed_step_hz 60|120|240 (120), audio_voices 1-32 (8), music_fade_s 0-10 (1), animation_crossfade_s 0-2 (0.2), render_backend 0|1|2|3 (0: WebGL legacy renderer, 1: auto = WebGPU else WebGL 2, 2: WebGPU, 3: WebGL 2 on the WebGPU renderer; a page URL flag ?renderer=legacy|auto|webgpu|webgl2 overrides it). Scenes: createScene {name, sceneId?}, ' +
      'renameScene {sceneId, name}, deleteScene {sceneId} (only an empty scene), setStartScenes {sceneIds} (the ' +
      'scenes the game starts with; the camera, player, lights and start spawn live only in start scenes). ' +
      'createEntity/instantiatePrefab take sceneId (default: the first scene; with parentId, the parent\'s scene); ' +
      'one command edits one scene and entity ids are unique across scenes. An instance set is ' +
      'setComponent "instances" {asset:{assetId, piece?}, buffer:<sha256 of a staged buffer>, count}. Models: createEntity kind "model" ' +
      'takes model {asset:{assetId}, piece?} — piece names one piece of a multi-piece GLB (the base name of its <piece>_LOD0..n / ' +
      '<piece>_COL nodes, or a top-level node); LOD nodes switch by screen size and _COL nodes are never drawn. A folder create ' +
      'may carry children: [createEntity args without parentId] (up to 256, one undo). setAssetOptions {assetId, vertexColors: ' +
      '"data"|"tint"}: COLOR_0 is shader data by default, "tint" multiplies it into the base colour. pasteEntities {entities: [full entity ' +
      'values as tl_inspect returns them, parents with their children], parentId?: id|null, offset?: [x,y,z], sceneId?} copies them with ' +
      'new ids in one undo (references inside the copy are remapped; use it to duplicate or to copy between scenes). Materials: ' +
      'setMaterial {material: {materialId, name, shader: standard|foliage|kit|unlit|water, params: {...overrides}, textures: {slot: ' +
      'textureAssetId}}} creates or replaces one (on a model it starts from the file\'s own material and changes only what it sets); ' +
      'deleteMaterial {materialId}; objects use them with setComponent "materials" {<source material name or "*">: materialId}, a ' +
      'model asset for every placement with setAssetOptions {assetId, materials: {...}|null}. A graph material adds graph: {nodes, edges, groups?, comments?} (graph kind ' +
      '"material": the graph replaces shader/params/textures at render time — the graph compiler arrives with 18.3, until then it renders with its shader) and ' +
      'parameters: [{key (identifier), type: float|vec2|vec3|vec4|color|texture, default, min?, max?, visibility?: public|private, label?, group?, tooltip?}] ' +
      '(read by Parameter nodes {key}); its graph is then edited with graphEdit {owner: {kind: "material", id: materialId}, ops}; objects override public parameters ' +
      'with setComponent "materialParams" {<materialId>: {<key>: value}} (private ones are refused). Material functions (reusable sub-graphs) are standalone graphs of kind ' +
      '"material-function" (setGraph; Function input {name, type, default} / Function output {name, type} nodes are the ports of every Function call {function: graphId} node; ' +
      'calls may not form a cycle; a function whose ports are wired in a material cannot drop them). setEnvironment {environment: {wind: ' +
      '{direction: [x, z], strength, gust, gustFrequency, turbulence}, sky?: {mode: procedural|gradient|texture|color, ...}, fog?: {mode: none|linear|exp2, color, near?, far?, density?}, ' +
      'post?: {toneMapping?, exposure?, bloom?, grading?: {brightness?, contrast?, saturation?, tint?, lut?, lift? -0.5..0.5, gamma? 0.2..5, gain? 0..4}, vignette?, ssao?, dof?, antialias?}, quality?}} ' +
      '(the foliage shader bends by COLOR_0.r); a fogVolume component {size, density, color, falloff?, heightFalloff? per m (density fades above the box bottom)}. setLighting {sceneId, ' +
      'lighting: null} clears a scene\'s baked lightmaps (bakes are made in the editor\'s Lighting window). Animation: setAnimator {controller: ' +
      '{controllerId, name, parameters: [{name, type: float|int|bool|trigger, default?}], states: [{id, name, motion: {kind: "clip", clip: ' +
      '{assetId, clip, duration}} | {kind: "blend1d", parameter, children: [{threshold, clip}]}, speed, speedParameter?, loop}], transitions: ' +
      '[{from: stateId|"*", to, conditions: [{parameter, op: greater|less|equals|notEquals|true|false|trigger, value?}], duration, exitTime?, ' +
      'interruption?: none|source}], entry, events: [{assetId, clip, time, name}], layers?: [{name, mask: [bone names] (empty = every ' +
      'bone), weight 0-1, weightParameter? (a float param it is multiplied by), states (motion may also be {kind: "empty"}: the layers ' +
      'under show through), transitions, entry}] (up to 3 override layers over the base layer, e.g. an upper-body attack while running; ' +
      'state ids are unique across layers)}}; deleteAnimator {controllerId}; a model entity plays one ' +
      'with setComponent "animator" {controller, parameters?}. An animation-only GLB (clips, no mesh needed) is marked with ' +
      'setAssetOptions {assetId, clipsFor: rigModelAssetId | null}; its clips then play on that model (matched by bone names) and ' +
      'controllers may name them. The old modelAnimation idle/run/airborne component becomes an animator controller when the project ' +
      'is opened. The player\'s animators get speed, grounded, velocityY and a landed trigger ' +
      'automatically; scripts use ctx.animator(entityId)?.set/trigger/state(layer?). Input: setInput {input: {actions: [{name, type: ' +
      'button|axis1d|axis2d, map: gameplay|ui, bindings: [{kind: "key", code: KeyboardEvent.code} | {kind: "gamepadButton", button} | ' +
      '{kind: "gamepadAxis", axis} | {kind: "keys1d", negative, positive} | {kind: "keys2d", up, down, left, right} | {kind: ' +
      '"gamepadButtons1d", negative, positive} | {kind: "gamepadStick", x, y}], deadZone?, invert?, scale?}]} | null} (null = defaults: ' +
      'move, jump, attack, interact, pause, submit, cancel, navigate); scripts read ctx.input.value/pressed/released/held(name). ' +
      'Gameplay blocks (v4; setComponent or createEntity components): mover {waypoints: [[dx, dy, dz]...] offsets, speed, mode: ' +
      'loop|pingpong|once, wait?, easing?: linear|smooth, startOn?: signal, maxPush? 1-1000 m/s (60: how hard it shoves a player out of its way)} (with a box collider it is a moving platform that carries ' +
      'the player; startOn makes a door); trigger {size: [w, h] (box) | shape: "circle", radius m (instead of size), signal, once?, exitSignal? (sent on leaving), mode?: enter|stay (stay: the signal every step while the player is inside)}; switch {mode: interact|stand, signal, size, once?}; ' +
      'health {max, start?, invulnerableSeconds? (1 s), knockback? m/s, knockbackTime? s (0.25), hitBounce? m/s (5)} (on the player); pickup {kind: coin|gem|heart|life|key|custom, value, counter? (custom), size? (absent: its model\'s recorded bounds, else 1 x 1 m), ' +
      'respawn?: never|death, cue?: audioAssetId (collect sound)}; enemy {patrol: points|edges, range? [left, right] (points), speed, size, contactDamage, stompable, ' +
      'health, chase? m (walks toward a player in range), chaseHeight? m (2), stompBounce? m/s (9), stompTolerance? m (0.2), defeat?: none|squash|fade (squash), defeatTime? s (0.3), wallProbe? m (0.05, edges), ledgeProbe? m (0.4, edges)}; collider {oneWay: true} (jump up through, Down+Jump drops); controller {capsule: {radius 0.05-5 m, height 0.1-20 m (total, >= 2 x radius), offset? [x, y] m from the entity origin} | null} is the player\'s collision capsule (absent = radius 0.3, height 1.8, centred; every system uses it: physics, spawn clearance, zones, pickups, stomps), plus the optional movement tuning acceleration (40 m/s²), deceleration (60), coyoteTime (0.05 s), jumpBuffer (0.0667 s), jumpRelease (0.5), groundSnap (0.1 m), skin (0.01 m), autostep (false), autostepHeight (0.25 m) (null resets one); cameraFollow also takes distance? m (absent: where the camera is placed) and maxSpeed? m/s (480); gameZone hazard {damage?} (health instead of a life); playerSpawn {facing?: none|left|right} (v4; the player\'s face-movement models turn to it at start and respawn; null = none); audioSource ' +
      '{assetId (audio or music), volume 0-1, range m} loops louder as the player comes near (along X). ' +
      'Scripts use ctx.signals.emit/on(name), ctx.game.counter/add/health()/setVisible(id, bool), ctx.physics.raycast/overlapBox(center, half)/overlapCircle(center, r) (32 queries/step), ctx.emit({kind: "pose", entityId, rotation?: {yaw?, pitch?, roll?} degrees, scale?: n | [x, y, z]}) in the transform phase for an owned entity and ctx.audio.play(audioAssetId, {volume?}), ctx.save.get/set/remove/keys (kept in the player\'s save), ctx.spawn(prefabId, {position: [x, y] | [x, y, z], rotation?: [x, y, z, w], scale?: n | [x, y, z]}) ' +
      '-> "spawn-<n>" root id or null (a copy of a project prefab in the running game only — colliders, pickups, enemies, movers and its scripts work; it appears at the next step; ' +
      'at most 64 spawns per step and 1024 spawned entities alive; a new run removes them all; saves never keep them) and ctx.destroy(spawnedId) (removes it and its children; ' +
      'an authored entity throws: hide it with setVisible); a script whose source container lists "@self" in ownedTransforms may move its own entity (each carrier, spawned copies included) with transform/pose intents in the transform phase. ' +
      'ctx.timers.after(name, seconds)/every(name, seconds) (step-counted; calling it again with the same length changes nothing, another length restarts it; ' +
      'at most 64 per script instance; a new run clears them), ctx.timers.fired(name) (true in the step it fires), ctx.timers.cancel(name); ' +
      'ctx.events also holds {type: "enter"|"exit", trigger: entityId, stepIndex} (seen the step after) for the triggers the script owns: on its own entity, below it, ' +
      'or named by one of its entityRef properties. Game flow: setFlow {flow: {levels: [{id, name, scenes: [sceneId], ' +
      'spawnId, music?: musicAssetId, environment?: {sky?, fog?, post?, wind?} (the level\'s look: each part given replaces the project environment\'s part while the level plays; post merges per effect), ambience?: [audio or music assetId] (1-4, looped on the sound-effects bus while the level plays)}], lives?: {start, max}, title?: {subtitle?, music?, scene?: sceneId (the background behind the title menu, loaded like a level scene; the camera frames its first player spawn, else its middle; absent = the first level\'s start), pan?: {distance: -100..100 m (not 0), seconds: 2-600} (a slow sideways camera pan out and back)}, hud?: {preset: classic|minimal|corners, timer?}, ' +
      'ui?: {font: sans|serif|mono|rounded, accent, panel, text: #rrggbb, logo?: textureAssetId}, texts?: {levelComplete?, gameOver?, credits?}, ' +
      'volumes?: {music, sfx, ui? (menu sounds, default 1)}, sounds?: {move?, confirm?, back?: audioAssetId} (menu sounds on the ui bus), score?: {points?: {counterName: points per unit, e.g. coins, gems, keys, lives, defeated or a custom pickup counter}, ' +
      'timeBonus?: {targetSeconds, perSecond} (points per second under the target)}} | null} (score: shown on the HUD and the level complete/end screens, best per level kept in the player\'s save; ' +
      'every level must load the player\'s and camera\'s scenes; with a flow tl_game_control start = new game, ' +
      'replay = restart the level). Graphs (node graphs; one op set for every graph kind): setGraph {graph: {graphId, kind, name, graph: {nodes: [], edges: []}}} ' +
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
      'Returns the new revision on success, ' +
      'or a structured error (e.g. revision_conflict with currentRevision). Read-only queries use ' +
      'tl_inspect/tl_content_query, not this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...MUTATION_OPS] },
        args: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 0 },
        requestId: { type: 'string', pattern: '^req-[0-9a-f]{32}$' },
      },
      required: ['op', 'expectedRevision'],
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
      'files) for tl_content_upload projectPath. Never returns bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['assets', 'asset', 'prefabs', 'behaviors', 'integrity', 'game', 'projectFiles'] },
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
      'the server first: the result then carries convertedFrom (not sourcePath), which the publishAsset args must include.',
    inputSchema: {
      type: 'object',
      properties: {
        dataBase64: { type: 'string', description: 'base64 of the source bytes (≤ 32 MiB decoded)' },
        projectPath: {
          type: 'string',
          description: 'a .glb/.fbx/.wav file relative to the game folder (the folder holding thirdlight.json), forward slashes, e.g. assets/props/crate.glb',
        },
        displayName: { type: 'string' },
        kind: { type: 'string', enum: ['model', 'audio', 'texture', 'music'] },
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
      'frames ≤ 600 ascending by stepOffset, body ≤ 16 KiB; jump ∈ none|pressed|held|released; optional actions: ' +
      '{<action name>: {v, x?, y?, p: none|pressed|held|released}} for named input actions (attack, interact, …; scripts read ' +
      'them with ctx.input). Returns the applied ' +
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
              moveX: { type: 'number', minimum: -1, maximum: 1 },
              jump: { type: 'string', enum: ['none', 'pressed', 'held', 'released'] },
              actions: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: { v: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, p: { type: 'string', enum: ['none', 'pressed', 'held', 'released'] } },
                  required: ['v', 'p'],
                  additionalProperties: false,
                },
              },
            },
            required: ['stepOffset', 'moveX', 'jump'],
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
      'Submit one bounded §20 game-control command (start, replay, mute, unmute, clearSave (forget the game\'s saves in this browser), or loadScene / unloadScene with ' +
      'sceneId - the same request a script makes with ctx.scenes; debugPause / debugResume / debugStep hold the simulation at a step boundary, ' +
      'release it, or run exactly one step while held - the visual-script debugger; tl_game_observe shows debug {paused, hit {behaviorId, entityId, nodeId, stepIndex}}) to an explicitly presented play ' +
      'session. expectedRunId is an optional optimistic guard (<snapshotId>#<replayEpoch>); a mismatch is refused ' +
      'with game_run_stale and no command is applied. The result is the preview\'s exact accepted result (identity ' +
      'tuple + run state); with no connected/presenting browser the contracted session_unavailable is returned - ' +
      'never a fabricated success. Body <= 4 KiB; no gameplay simulation, no eval.',
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        command: { type: 'string', enum: [...GAME_CONTROL_COMMANDS] },
        expectedRunId: { type: 'string' },
        sceneId: { type: 'string', description: 'loadScene / unloadScene: the scene' },
      },
      required: ['playSessionId', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_observe',
    description:
      'Read one bounded §20 observation document (<= 16 KiB, <= 32 events) from an explicitly presented play ' +
      'session. The values come from the committed read-only GameView; the observation is bounded and carries no ' +
      'GLB/WAV bytes, base64 media, authoring token or locator capability; `animators` maps each animated entity to its ' +
      'current animator state; `counters` (coins, gems, keys, defeated…) and `health` the gameplay blocks\' run state; `spawned` {count, ids (first 64)} the live entities scripts spawned; `flow` (a game with levels) the screen (title/playing/paused/settings/levelComplete/gameOver/finished), level, lives, music and volumes (music, sfx, ui), menuSounds {played, last}, ambience (the assets looping now; `loops` shows them as ambience:<n>), pad (buttons the player rebound in the settings), and with score rules `score` {game, level, best per level id}; with entityId, `behaviors` {entityId, scripts: [{behaviorId, properties: [{key, label, type, visibility, value}]}]} — the values the entity\'s running scripts read, private ones included (read-only); `renderer` {requested, source, backend, api, state, reason} the renderer backend that draws the play and why. timeoutMs 250-15000 (default 5000). ' +
      'With no connected/presenting browser the contracted session_unavailable is returned; a relay that exceeds ' +
      'timeoutMs is game_relay_timeout (503) - never a simulated value.',
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
      'browser (an active authoring session); with none, returns the structured session_unavailable ' +
      'error. Pass sessionId (from tl_sessions) to require a specific browser session. Returns ' +
      'playSessionId + the frozen snapshotId/revision on success.',
    inputSchema: {
      type: 'object',
      properties: { demo: { type: 'boolean' }, sessionId: { type: 'string', pattern: '^sess-[0-9a-f]{32}$' } },
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
      'that draws (renderer.backend legacy|webgpu|webgl2, renderer.state) and why (renderer.reason).',
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
      'editor browser is not connected.',
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
  if (a.demo !== undefined) {
    if (typeof a.demo !== 'boolean') return toolError('demo must be a boolean');
    body.options = { demo: a.demo };
  }
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
    const { stepOffset, moveX, jump } = raw;
    if (!isInt(stepOffset) || stepOffset < 0) return toolError(`frames[${i}].stepOffset must be an integer ≥ 0`);
    if (stepOffset <= previous) return toolError('frames must be strictly ascending by stepOffset');
    previous = stepOffset;
    if (typeof moveX !== 'number' || !Number.isFinite(moveX) || moveX < -1 || moveX > 1) {
      return toolError(`frames[${i}].moveX must be a finite number in [-1, 1]`);
    }
    if (jump !== 'none' && jump !== 'pressed' && jump !== 'held' && jump !== 'released') {
      return toolError(`frames[${i}].jump must be one of none | pressed | held | released`);
    }
    frames.push({ stepOffset, moveX, jump });
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
  return toolError('target must be "assets", "asset", "prefabs", "behaviors", "integrity", "game", or "projectFiles"');
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
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'music') return toolError('kind must be "model", "audio", "texture" or "music"');
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
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'music') return toolError('kind must be "model", "audio", "texture" or "music"');
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
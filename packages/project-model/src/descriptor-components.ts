/**
 * The component descriptors: every component an object may carry, its fields,
 * handles, rules and create-menu entries, and the object's own fields.
 */

import { DEFAULT_PROBE_SPACING, PROBE_SPACING_MAX, PROBE_SPACING_MIN } from './probe-grids';
import { INSTANCE_DENSITY_END_DEFAULT, INSTANCE_DENSITY_MIN_DEFAULT, INSTANCE_DENSITY_SIZE_MIN, INSTANCE_DENSITY_START_DEFAULT } from './model-lod';
import { LOOK_AT_LIMITS, MAX_ANIMATOR_PARAMETERS } from './animator';
import { BLOCK_DEFAULTS, BLOCK_TUNING_LIMITS, HITBOX_SHAPES, GRAVITY_SCALE, MOVER_EASINGS, MOVER_MODES, PATROL_MODES, PRIMITIVE_DEFAULTS, PRIMITIVE_LIMITS, SWITCH_MODES, SWITCH_DEFAULT_ACTION, FACE_MOVEMENT_MODES, MAX_TRANSITION_FADE, MAX_TRANSITION_UNLOADS, TRIGGER_HEIGHT, TRIGGER_MODES, TRIGGER_RADIUS, TRIGGER_SHAPES } from './blocks';
import {
  CAPSULE_LIMITS,
  CHARACTER_3D_LIMITS,
  CHARACTER_MOVE_FRAMES,
  COLLIDER_3D_LIMITS,
  CONTROLLER_ACTION_DEFAULTS,
  CONTROLLER_MOVEMENT_LIMITS,
  DEFAULT_CONTROLLER_MOVEMENT,
  CONTROLLER_TUNING_LIMITS,
  DEFAULT_CHARACTER_3D,
  DEFAULT_CONTROLLER_CAPSULE,
  DEFAULT_CONTROLLER_TUNING,
  MAX_COLLIDER_EXTENT,
  MAX_POLYGON_VERTICES,
} from './components';
import { EFFECT_LIMITS } from './effects';
import { blockLayer } from './block-descriptors';
import { MAX_MATERIAL_PARAMETERS, MAX_MATERIAL_SLOTS } from './materials';
import { SOCKET_ATTACH_CONFLICTS, SOCKET_ATTACH_LIMITS } from './sockets';
import { MODE_BLENDS, MODE_DEFAULTS, MODE_LIMITS, MODE_PHYSICS, MODE_UNGROUPED } from './modes';
import { CAMERA_BLENDS, CAMERA_PATH_LIMITS, CAMERA_RAIL_MODES, CAMERA_REGION_DEFAULTS, CAMERA_REGION_LIMITS, VIRTUAL_CAMERA_DEFAULTS as VCD, VIRTUAL_CAMERA_LIMITS as VCL, VIRTUAL_CAMERA_RIGS } from './cameras';
import { MAX_LEN } from './validate';
import { INSTANCES_LOCAL_LIGHTS_DEFAULT, LIGHT_IMPORTANCES, LOCAL_LIGHT_MODES } from './local-lights';

/** How the local-light modes read in the Inspector. */
const LOCAL_LIGHT_LABELS = { pixel: 'Per pixel', vertex: 'Per vertex', none: 'None' } as const;
import { DIRECTIONAL_SHADOW_DEFAULTS, DIRECTIONAL_SHADOW_LIMITS, MAX_ABS_V3, MAX_EMISSIVE_INTENSITY, MAX_INTENSITY, MAX_LOCAL_INTENSITY, SURFACE_DEFAULTS } from './scene-v3';
import { MAX_INSTANCES } from './types-v3';
import { type ComponentDescriptor, type FieldDescriptor, type ObjectFieldDescriptor } from './descriptor-types';
import { asset, bool, color, enm, entity, ID, int, json, lightLayerMask, list, map, NAME, num, obj, ref, scene, signal, str, vec2, vec3, when } from './descriptor-builders';

// ---- components ------------------------------------------------------------------

/** The model's length bound and its v3 number bound. */
const POSITION_LIMIT = MAX_LEN;
const V3_LIMIT = MAX_ABS_V3;

const PHYSICS_RULES = ['A physics body (collider or controller) is at unit scale [1, 1, 1] on a 2D plane and rotated about Z only there (any axis and scale in a 3D one); the player controller and a mover are root objects and the controller stands upright; a collider on a child follows its parent.'];
const MARKER_RULES = ['A zone or player spawn is a root object at unit scale with no rotation.'];

export const transform: ComponentDescriptor = {
  name: 'transform',
  label: 'Transform',
  tooltip: 'Where the object is, how it is turned and how big it is (relative to its parent).',
  category: 'Object',
  value: obj('transform', 'Transform', 'Position, rotation and scale relative to the parent.', [
    vec3('position', 'Position', 'Offset from the parent (metres).', { min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.1, unit: 'm', default: [0, 0, 0] }),
    { type: 'quat', key: 'rotation', label: 'Rotation', tooltip: 'Orientation as a unit quaternion [x, y, z, w] (the Inspector shows degrees).', default: [0, 0, 0, 1] },
    vec3('scale', 'Scale', 'Size multiplier per axis (above 0).', { min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.1, unit: '×', default: [1, 1, 1] }),
  ]),
  add: { kind: 'never', reason: 'every object has a transform (a folder has none)' },
  handles: [],
  excludes: [],
  prefab: true,
};

export const model: ComponentDescriptor = {
  name: 'model',
  label: 'Model',
  tooltip: 'Shows an imported 3D model (a whole file or one named piece of it).',
  category: 'Rendering',
  value: obj('model', 'Model', 'The model asset and, for a multi-piece file, the piece.', [
    obj('asset', 'Asset', 'The model asset.', [asset('assetId', 'Model', 'The imported model file.', ['model'], { required: true })], { required: true }),
    str('piece', 'Piece', 'One named piece of a multi-piece file (absent: the whole file).', NAME),
    // True by default — solid geometry blocks the light and shows the shadows falling on it in any genre.
    bool('castShadow', 'Casts shadows', 'Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops).', { default: true, omitDefault: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the realtime shadows falling on it.', { default: true, omitDefault: true }),
    lightLayerMask('lightLayers', 'Light layers', 'The light layers it is in: only lights whose light mask shares one of them light it, and it casts shadows only for lights whose shadow caster mask shares one.', 1),
    enm('localLights', 'Local lights', 'Point, spot and effect lights per pixel, per vertex (diffuse only, cheap) or none (—: as its material says, else per pixel).', LOCAL_LIGHT_MODES, { labels: LOCAL_LIGHT_LABELS }),
  ]),
  add: { kind: 'pick', value: { asset: {} }, pick: ['asset/assetId'] },
  handles: [],
  excludes: [
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'box', reason: 'an object shows one model or box' },
    { component: 'instances', reason: 'an instance set places its own model many times' },
  ],
  prefab: true,
};

export const box: ComponentDescriptor = {
  name: 'box',
  label: 'Box',
  tooltip: 'A simple coloured box (blocking out a level, placeholders).',
  category: 'Rendering',
  value: obj('box', 'Box', 'A box mesh.', [
    vec3('size', 'Size', 'Width, height and depth in metres.', { min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.1, unit: 'm', default: [1, 1, 1], handle: 'box3', labels: ['w', 'h', 'd'] }),
    obj('material', 'Material', 'The box colour (a project material overrides it).', [color('color', 'Colour', 'The box colour.', { default: '#b0b0b0' })], { default: { color: '#b0b0b0' } }),
    // True by default — solid geometry blocks the light and shows the shadows falling on it in any genre.
    bool('castShadow', 'Casts shadows', 'Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops).', { default: true, omitDefault: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the realtime shadows falling on it.', { default: true, omitDefault: true }),
    lightLayerMask('lightLayers', 'Light layers', 'The light layers it is in: only lights whose light mask shares one of them light it, and it casts shadows only for lights whose shadow caster mask shares one.', 1),
    enm('localLights', 'Local lights', 'Point, spot and effect lights per pixel, per vertex (diffuse only, cheap) or none (—: as its material says, else per pixel).', LOCAL_LIGHT_MODES, { labels: LOCAL_LIGHT_LABELS }),
  ]),
  add: { kind: 'menu', value: { size: [1, 1, 1], material: { color: '#b0b0b0' } } },
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'transform' }],
  excludes: [
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'model', reason: 'an object shows one model or box' },
    { component: 'instances', reason: 'an instance set places its own model many times' },
  ],
  prefab: true,
};

export const behavior: ComponentDescriptor = {
  name: 'behavior',
  label: 'Script',
  tooltip: 'Runs a published behavior (script) on this object with per-object property values.',
  category: 'Scripting',
  value: obj('behavior', 'Script', 'The behavior and this object\'s property values.', [
    ref('behaviorId', 'Behavior', 'The published behavior.', 'behavior', { required: true }),
    map('values', 'Properties', 'Values for the behavior\'s declared properties (absent: the declared default).', 'Property', json('*', 'Value', 'A value of the declared property type.', { typedBy: 'behaviorDeclaration' }), { required: true, keyFormat: 'identifier', default: {} }),
  ]),
  add: { kind: 'pick', value: { values: {} }, pick: ['behaviorId'] },
  handles: [],
  excludes: [],
  prefab: true,
};

export const prefab: ComponentDescriptor = {
  name: 'prefab',
  label: 'Prefab link',
  tooltip: 'Which prefab (and which of its entities) this object was placed from.',
  category: 'Organisation',
  value: obj('prefab', 'Prefab link', 'Written when a prefab is placed.', [
    ref('prefabId', 'Prefab', 'The prefab this object came from.', 'prefab', { required: true, readOnly: true }),
    str('localId', 'Prefab entity', 'The prefab entity this object is a copy of.', { ...ID, required: true, readOnly: true }),
  ]),
  add: { kind: 'tool', tool: 'instantiatePrefab' },
  handles: [],
  excludes: [],
  prefab: false,
};

/**
 * The fields of one primitive collider shape (by its type) and where it sits
 * in its object's frame; a collider's shape and every shape of a compound
 * use them.
 */
function colliderPrimitiveFields(): FieldDescriptor[] {
  const primitives = ['box', 'polygon', 'sphere', 'capsule', 'convex', 'mesh'] as const;
  return [
    num('hx', 'Half width', 'Half the box width.', { required: true, when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', default: 0.5, handle: 'box2' }),
    num('hy', 'Half height', 'Half the box height.', { required: true, when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', default: 0.5, handle: 'box2' }),
    // The depth. Absent in a 2D plane (which ignores it); required by a 3D project (no guessed depth).
    num('hz', 'Half depth', 'Half the box depth along Z (needed in a 3D project; a 2D plane ignores it).', { when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', handle: 'box2' }),
    list('vertices', 'Vertices', `3–${MAX_POLYGON_VERTICES} corners [x, y], counter-clockwise, convex.`, vec2('*', 'Vertex', 'A corner [x, y] from the object origin.', { min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05, unit: 'm' }), {
      required: true,
      when: when('type', 'polygon'),
      minItems: 3,
      maxItems: MAX_POLYGON_VERTICES,
      handle: 'polygon',
    }),
    // The 3D shapes (a 3D project). A capsule stands along the object's Y, its height the controller's convention (end caps included).
    num('radius', 'Radius', 'The sphere\'s radius.', { required: true, when: when('type', 'sphere'), min: 0, minExclusive: true, max: MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm', default: 0.5, handle: 'radius' }),
    num('radius', 'Radius', 'The capsule\'s radius.', { required: true, when: when('type', 'capsule'), min: 0, minExclusive: true, max: MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm', default: 0.5, handle: 'capsule' }),
    num('height', 'Height', 'The capsule\'s total height along the object\'s Y (end caps included; at least twice the radius).', { required: true, when: when('type', 'capsule'), min: 0, minExclusive: true, max: 2 * MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm', default: 2, handle: 'capsule' }),
    // Generated from a model (its _COL node, else its geometry) and stored as data; shown read-only.
    list('points', 'Hull points', `4–${COLLIDER_3D_LIMITS.convexPoints} points [x, y, z] whose convex hull is the shape (made from a model).`, vec3('*', 'Point', 'A point [x, y, z] from the object origin.', { min: -MAX_COLLIDER_EXTENT, max: MAX_COLLIDER_EXTENT, unit: 'm' }), {
      required: true,
      when: when('type', 'convex'),
      minItems: 4,
      maxItems: COLLIDER_3D_LIMITS.convexPoints,
      readOnly: true,
    }),
    list('vertices', 'Mesh vertices', `3–${COLLIDER_3D_LIMITS.meshVertices} vertices [x, y, z] (made from a model).`, vec3('*', 'Vertex', 'A vertex [x, y, z] from the object origin.', { min: -MAX_COLLIDER_EXTENT, max: MAX_COLLIDER_EXTENT, unit: 'm' }), {
      required: true,
      when: when('type', 'mesh'),
      minItems: 3,
      maxItems: COLLIDER_3D_LIMITS.meshVertices,
      readOnly: true,
    }),
    list('triangles', 'Mesh triangles', `1–${COLLIDER_3D_LIMITS.meshTriangles} triangles [a, b, c] (vertex indices; made from a model).`, vec3('*', 'Triangle', 'Three different vertex indices [a, b, c].'), {
      required: true,
      when: when('type', 'mesh'),
      minItems: 1,
      maxItems: COLLIDER_3D_LIMITS.meshTriangles,
      readOnly: true,
    }),
    // Where the shape sits in the object's frame (absent: centred, unrotated).
    vec3('center', 'Center', 'The shape\'s centre from the object origin (metres; a 2D plane reads x and y).', { when: when('type', ...primitives), min: -MAX_COLLIDER_EXTENT, max: MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm' }),
    { type: 'quat', key: 'rotation', label: 'Rotation', tooltip: 'The shape\'s rotation in the object\'s frame (a unit quaternion; about Z only on a 2D plane; the Inspector shows degrees).', when: when('type', ...primitives) },
  ];
}

export const collider: ComponentDescriptor = {
  name: 'collider',
  label: 'Collider',
  tooltip: 'A solid shape the player stands on and bumps into (a box or a convex polygon in the X/Y plane; in a 3D project a box with a depth, a sphere, a capsule, a convex hull or a triangle mesh), placed anywhere in the object\'s frame; several shapes as a compound, or the convex parts of its model\'s _COL node.',
  category: 'Physics',
  value: obj('collider', 'Collider', 'The collision shape.', [
    obj('shape', 'Shape', 'A box (half extents) or a convex polygon; in a 3D project also a sphere, a capsule, a convex hull or a triangle mesh; a compound of several; or the model\'s _COL parts.', [
      enm('type', 'Shape', 'Box or convex polygon (2D plane); box, sphere, capsule, convex hull or mesh (3D project); a compound of shapes; or the convex parts of the model\'s _COL node (read when the game is built).', ['box', 'polygon', 'sphere', 'capsule', 'convex', 'mesh', 'compound', 'model'], { required: true, default: 'box' }),
      ...colliderPrimitiveFields(),
      list('shapes', 'Shapes', 'The compound\'s shapes (one body), each with its own centre and rotation.', obj('*', 'Shape', 'One shape of the compound.', [
        enm('type', 'Shape', 'Box or convex polygon (2D plane); box, sphere, capsule, convex hull or mesh (3D project).', ['box', 'polygon', 'sphere', 'capsule', 'convex', 'mesh'], { required: true, default: 'box' }),
        ...colliderPrimitiveFields(),
      ]), { required: true, when: when('type', 'compound'), minItems: 1 }),
    ], { required: true, rules: ['A polygon is convex, counter-clockwise, has no repeated corner, an area of at least 1e-6 m² and stays within 64 m of the origin.', 'Sphere, capsule, convex hull and mesh are 3D shapes (physics_dimension 3); a mesh is static level geometry (not on a mover).', 'A model shape needs a model on the same object; a build makes one convex hull of each mesh part of its _COL node.'] }),
    bool('oneWay', 'One-way', 'The player can jump up through it and land on top (a platform).', { default: false, omitDefault: true }),
    // Absent = the implicit "default" layer (every collider is in one layer; none has to be named).
    list('layers', 'Collision layers', `The collision layers it is in (3D; absent: "default"). Script queries filter by layer; name layers in the project's collision layers.`, str('*', 'Layer', 'A collision layer: "default" or one the project names.', { format: 'identifier', minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 16, unique: true }),
  ]),
  add: { kind: 'menu', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } },
  // A 3 × 0.2 m shelf (a platform to land on, thin enough to jump up through), 2D only (a 3D project has no one-way colliders).
  create: [{ label: 'One-way platform', menu: 'Gameplay', box: { size: [3, 0.2, 2], color: '#8fb573' }, value: { shape: { type: 'box', hx: 1.5, hy: 0.1 }, oneWay: true }, dimension: 2 }],
  presets: [
    { label: 'Box', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 } }, dimension: 2 },
    { label: 'Polygon', value: { shape: { type: 'polygon', vertices: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] } }, dimension: 2 },
    // 3D projects: a 1 m box, a 0.5 m sphere, a 2 m capsule, a 1 m cube's hull and a 1 m floor quad as starting shapes.
    { label: 'Box (3D)', value: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } }, dimension: 3 },
    { label: 'Sphere', value: { shape: { type: 'sphere', radius: 0.5 } }, dimension: 3 },
    { label: 'Capsule', value: { shape: { type: 'capsule', radius: 0.5, height: 2 } }, dimension: 3 },
    { label: 'Convex hull', value: { shape: { type: 'convex', points: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] } }, dimension: 3 },
    { label: 'Mesh', value: { shape: { type: 'mesh', vertices: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]], triangles: [[0, 2, 1], [0, 3, 2]] } }, dimension: 3 },
    // The model's own _COL parts, read when the game is built (an object with a model).
    { label: "Model's _COL parts", value: { shape: { type: 'model' } }, requires: ['model'] },
  ],
  handles: [
    { kind: 'box2', label: 'Box size', bind: { halfX: 'shape/hx', halfY: 'shape/hy', halfZ: 'shape/hz' }, space: 'local', when: when('shape/type', 'box'), follows: 'rotationZ' },
    { kind: 'polygon', label: 'Polygon', bind: { vertices: 'shape/vertices' }, space: 'local', when: when('shape/type', 'polygon'), follows: 'rotationZ' },
    // The 3D shapes turn and scale with the object (a 3D collider takes its whole transform).
    { kind: 'radius', label: 'Sphere radius', bind: { radius: 'shape/radius' }, space: 'local', when: when('shape/type', 'sphere'), follows: 'transform' },
    { kind: 'capsule', label: 'Capsule', bind: { radius: 'shape/radius', height: 'shape/height' }, space: 'local', when: when('shape/type', 'capsule'), follows: 'transform' },
  ],
  excludes: [
    { component: 'socketAttach', reason: 'a socket poses the object every step; a physics body is posed by physics' },
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'controller', reason: 'the player controller has its own capsule' },
    { component: 'playerSpawn', reason: 'a player spawn is a marker' },
    { component: 'instances', reason: 'an instance set is scenery without its own body' },
    { component: 'patrol', reason: 'a patroller is not a physics body (give it a hitbox)' },
    { component: 'gravity', reason: 'a gravity body is not a physics body (give it a hitbox)' },
  ],
  prefab: true,
  rules: PHYSICS_RULES,
};

const CT = DEFAULT_CONTROLLER_TUNING;
const TL = CONTROLLER_TUNING_LIMITS;
const C3 = DEFAULT_CHARACTER_3D;
const C3L = CHARACTER_3D_LIMITS;
const CML = CONTROLLER_MOVEMENT_LIMITS;
const CMD = DEFAULT_CONTROLLER_MOVEMENT;
const BD = BLOCK_DEFAULTS;
const BL = BLOCK_TUNING_LIMITS;

export const controller: ComponentDescriptor = {
  name: 'controller',
  label: 'Player controller',
  tooltip: 'Makes this object the player: it runs, jumps and collides with a capsule.',
  category: 'Physics',
  value: obj('controller', 'Player controller', 'The player character.', [
    obj('capsule', 'Capsule', `The collision capsule (absent: ${DEFAULT_CONTROLLER_CAPSULE.radius} m radius, ${DEFAULT_CONTROLLER_CAPSULE.height} m tall — an adult human).`, [
      num('radius', 'Radius', 'Half the capsule width.', { required: true, min: CAPSULE_LIMITS.minRadius, max: CAPSULE_LIMITS.maxRadius, step: 0.01, unit: 'm', default: DEFAULT_CONTROLLER_CAPSULE.radius, handle: 'capsule' }),
      num('height', 'Height', 'Total height, both end caps included.', { required: true, min: CAPSULE_LIMITS.minHeight, max: CAPSULE_LIMITS.maxHeight, step: 0.01, unit: 'm', default: DEFAULT_CONTROLLER_CAPSULE.height, handle: 'capsule' }),
      // [x, y] or [x, y, z] — z places the capsule in depth in a 3D project (a 2D plane ignores it).
      vec3('offset', 'Offset', 'The capsule centre from the object origin (z: in a 3D project).', { min: -CAPSULE_LIMITS.maxOffset, max: CAPSULE_LIMITS.maxOffset, step: 0.01, unit: 'm', default: [...DEFAULT_CONTROLLER_CAPSULE.offset], handle: 'capsule', optionalLast: true }),
    ], { group: 'Collision', rules: ['height ≥ 2 × radius'] }),
    // The movement tuning (absent: the engine defaults, the values every project played with before).
    num('acceleration', 'Acceleration', 'How fast it speeds up toward the run speed (40: a 4 m/s run in 0.1 s).', { group: 'Movement', ...TL.acceleration, step: 1, unit: 'm/s²', default: CT.acceleration }),
    num('deceleration', 'Deceleration', 'How fast it slows down when the input eases or stops.', { group: 'Movement', ...TL.deceleration, step: 1, unit: 'm/s²', default: CT.deceleration }),
    num('coyoteTime', 'Coyote time', 'A jump still starts this long after walking off an edge.', { group: 'Jump', ...TL.coyoteTime, step: 0.01, unit: 's', default: CT.coyoteTime }),
    num('jumpBuffer', 'Jump buffer', 'A jump pressed this long before landing still happens on landing.', { group: 'Jump', ...TL.jumpBuffer, step: 0.01, unit: 's', default: CT.jumpBuffer }),
    num('jumpRelease', 'Jump release', 'Share of the upward speed kept when jump is released early (1: a fixed jump height).', { group: 'Jump', ...TL.jumpRelease, step: 0.05, unit: '×', default: CT.jumpRelease }),
    num('groundSnap', 'Ground snap', 'Pulls the character down onto ground this close below it (walking down slopes and bumps).', { group: 'Collision', ...TL.groundSnap, step: 0.01, unit: 'm', default: CT.groundSnap }),
    num('skin', 'Skin', 'The small gap the character keeps from walls and floors.', { group: 'Collision', ...TL.skin, step: 0.001, unit: 'm', default: CT.skin }),
    // The 2D plane's autostep; a 3D character steps up with `stepHeight` instead.
    bool('autostep', 'Autostep', 'Climb low steps without jumping.', { group: 'Collision', default: CT.autostep, dimension: 2 }),
    num('autostepHeight', 'Step height', 'The highest step it climbs.', { group: 'Collision', when: when('autostep', true), ...TL.autostepHeight, step: 0.01, unit: 'm', default: CT.autostepHeight, dimension: 2 }),
    // The 3D character (physics_dimension 3; a 2D plane ignores these).
    num('walkSpeed', 'Walk speed', 'Speed with the move input fully pushed (2: a brisk walk).', { group: 'Movement', ...C3L.walkSpeed, step: 0.1, unit: 'm/s', default: C3.walkSpeed, dimension: 3 }),
    num('runSpeed', 'Run speed', 'Speed while the "run" input action is held (absent: the project run speed setting).', { group: 'Movement', ...C3L.runSpeed, step: 0.1, unit: 'm/s', dimension: 3 }),
    num('airControl', 'Air control', 'Share of the acceleration it has in the air (0: no steering mid-jump, 1: as on the ground).', { group: 'Movement', ...C3L.airControl, step: 0.05, unit: '×', default: C3.airControl, dimension: 3 }),
    num('gravityScale', 'Gravity scale', 'Multiplies the project gravity for this character.', { group: 'Movement', ...C3L.gravityScale, step: 0.1, unit: '×', default: C3.gravityScale, dimension: 3 }),
    num('turnSpeed', 'Turn speed', 'How fast it turns to face where it moves (0: at once).', { group: 'Movement', ...C3L.turnSpeed, step: 10, unit: 'deg/s', default: C3.turnSpeed, dimension: 3 }),
    bool('faceMovement', 'Face movement', 'Turn the object about its up axis to face the direction it moves (its +Z forward).', { group: 'Movement', default: C3.faceMovement, dimension: 3 }),
    enm('moveFrame', 'Move relative to', 'What the move input is read against: the live camera\'s heading (up walks away from the camera; world axes while no camera is live) or the world axes (up pushes along −Z, right along +X).', CHARACTER_MOVE_FRAMES, { group: 'Movement', default: C3.moveFrame, labels: { view: 'Camera', world: 'World axes' }, dimension: 3 }),
    bool('jump', 'Can jump', 'The jump input makes it jump (off: a character that only walks).', { group: 'Jump', default: C3.jump, dimension: 3 }),
    num('jumpSpeed', 'Jump speed', 'Upward speed at a jump (absent: the project jump velocity setting).', { group: 'Jump', when: when('jump', true), ...C3L.jumpSpeed, step: 0.1, unit: 'm/s', dimension: 3 }),
    num('slopeLimit', 'Slope limit', 'The steepest slope it walks up (absent: the project max_slope_climb_deg setting).', { group: 'Collision', ...C3L.slopeLimit, step: 1, unit: 'deg', dimension: 3 }),
    num('stepHeight', 'Step-up height', 'Steps up to this height are climbed without a jump (0.3: a stair riser; 0: off). The ground snap is at least this, so it walks down them too.', { group: 'Collision', ...C3L.stepHeight, step: 0.01, unit: 'm', default: C3.stepHeight, dimension: 3, handle: 'height' }),
    bool('ledgeClimb', 'Ledge climb', 'Pushing against a ledge higher than a step pulls the character up onto it.', { group: 'Collision', default: C3.ledgeClimb, dimension: 3 }),
    num('ledgeHeight', 'Ledge height', 'The highest ledge it climbs (above its feet).', { group: 'Collision', when: when('ledgeClimb', true), ...C3L.ledgeHeight, step: 0.05, unit: 'm', default: C3.ledgeHeight, dimension: 3, handle: 'height' }),
    num('ledgeClimbTime', 'Climb time', 'How long a ledge climb takes.', { group: 'Collision', when: when('ledgeClimb', true), ...C3L.ledgeClimbTime, step: 0.05, unit: 's', default: C3.ledgeClimbTime, dimension: 3 }),
    // The input actions it reads (the input frame has no fixed move/jump channels).
    str('moveAction', 'Move action', 'The input action (an axis) that moves it.', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Input', default: CONTROLLER_ACTION_DEFAULTS.moveAction }),
    str('jumpAction', 'Jump action', 'The input action (a button) that makes it jump.', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Input', default: CONTROLLER_ACTION_DEFAULTS.jumpAction }),
    str('runAction', 'Run action', 'The input action (a button) that makes it run while held.', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Input', default: CONTROLLER_ACTION_DEFAULTS.runAction, dimension: 3 }),
    // Climbing (inside a climb volume) and walls (both off by default), both dimensions.
    num('climbSpeed', 'Climb speed', 'How fast it moves inside a climb volume (up/down along it, sideways across it; jump leaves).', { group: 'Climbing and walls', ...CML.climbSpeed, step: 0.1, unit: 'm/s', default: CMD.climbSpeed }),
    str('climbAction', 'Climb action', 'The input action (an axis) that climbs: its value, or a 2D axis\' up/down (absent: the move action\'s up/down — a 2D project whose move is left/right only names another action here).', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Climbing and walls' }),
    bool('wallSlide', 'Wall slide', 'Falling while pushing into a wall, it slides down no faster than the wall slide speed.', { group: 'Climbing and walls', default: CMD.wallSlide }),
    num('wallSlideSpeed', 'Wall slide speed', 'The fastest it slides down a wall.', { group: 'Climbing and walls', when: when('wallSlide', true), ...CML.wallSlideSpeed, step: 0.1, unit: 'm/s', default: CMD.wallSlideSpeed }),
    bool('wallJump', 'Wall jump', 'In the air, jump pushes it off a wall it touches (away from the wall and up).', { group: 'Climbing and walls', default: CMD.wallJump }),
    num('wallJumpAway', 'Wall jump away', 'Speed away from the wall at a wall jump (absent: its run speed).', { group: 'Climbing and walls', when: when('wallJump', true), ...CML.wallJumpAway, step: 0.1, unit: 'm/s' }),
    num('wallJumpUp', 'Wall jump up', 'Upward speed at a wall jump (absent: its jump speed).', { group: 'Climbing and walls', when: when('wallJump', true), ...CML.wallJumpUp, step: 0.1, unit: 'm/s' }),
    num('wallJumpLock', 'Wall jump lock', 'How long after a wall jump the input does not steer (absent: until the top of the jump; 0: steers at once; a landing always ends it).', { group: 'Climbing and walls', when: when('wallJump', true), ...CML.wallJumpLock, step: 0.05, unit: 's' }),
  ], { rules: ['The steepest walkable slope is the project setting max_slope_climb_deg; run speed, jump speed and gravity are project settings too (a 3D character may override them).'] }),
  add: { kind: 'menu', value: {} },
  handles: [
    { kind: 'capsule', label: 'Capsule', bind: { radius: 'capsule/radius', height: 'capsule/height', offset: 'capsule/offset' }, space: 'local' },
    // 3D: the step-up and ledge heights above the capsule's feet.
    { kind: 'height', label: 'Step-up height', bind: { height: 'stepHeight' }, space: 'local', from: 'capsule', dimension: 3 },
    { kind: 'height', label: 'Ledge height', bind: { height: 'ledgeHeight' }, space: 'local', from: 'capsule', when: when('ledgeClimb', true), dimension: 3 },
  ],
  excludes: [
    { component: 'socketAttach', reason: 'a socket poses the object every step; the player is moved by its controller' },
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'collider', reason: 'the player controller has its own capsule' },
    { component: 'mover', reason: 'the player moves by input, not along waypoints' },
    { component: 'playerSpawn', reason: 'the spawn marks where the player starts' },
    { component: 'instances', reason: 'an instance set is scenery' },
    { component: 'collectible', reason: 'the character collects; it is not collected' },
    { component: 'patrol', reason: 'the character moves by input, not by itself' },
    { component: 'climbVolume', reason: 'the character climbs in a climb volume; it is not one' },
    { component: 'gravity', reason: 'the character falls under its own controller' },
  ],
  prefab: false,
  rules: PHYSICS_RULES,
};

export const playerSpawn: ComponentDescriptor = {
  name: 'playerSpawn',
  label: 'Player spawn',
  tooltip: 'Where the player starts (a level names its spawn).',
  category: 'Gameplay',
  value: obj('playerSpawn', 'Player spawn', 'A spawn marker.', [
    // A facing in any direction (3D too): the character's yaw on arrival (replaces the left/right facing).
    num('yaw', 'Yaw', 'The way the character faces on arrival, degrees about +Y (0: facing +Z; absent: as it was).', { min: -360, max: 360, step: 5, unit: 'deg' }),
  ]),
  add: { kind: 'menu', value: {} },
  create: [{ label: 'Spawn point' }],
  icon: 'spawn',
  handles: [],
  excludes: [
    { component: 'collider', reason: 'a player spawn is a marker' },
    { component: 'controller', reason: 'the spawn marks where the player starts' },
    { component: 'instances', reason: 'an instance set is scenery' },
  ],
  prefab: false,
  rules: MARKER_RULES,
};

// The camera framework (defaults and their reasons: project-model VIRTUAL_CAMERA_DEFAULTS).
const ORBITING = when('rig', 'follow', 'orbitPoint');
const TRACKING = when('rig', 'follow', 'orbitPoint', 'topDown');
/** The rigs that lag behind a target by `damping` (the track rig's smoothing). */
const DAMPED = when('rig', 'follow', 'orbitPoint', 'topDown', 'track');
const TRACK = when('rig', 'track');
const ACTION_NAME = { format: 'identifier' as const, minLength: 1, maxLength: 32 };
export const virtualCamera: ComponentDescriptor = {
  name: 'virtualCamera',
  label: 'Virtual camera',
  tooltip: 'A camera shot the game cuts or blends to: follow/orbit a target, orbit a point in snapped turns, top-down, fixed/look-at, along a rail, or track a target with a dead zone and bounds. The live one is the enabled camera with the highest priority (on a tie the one activated last); it is what the game shows (without one the view holds a default pose and Play warns).',
  category: 'Camera',
  value: obj('virtualCamera', 'Virtual camera', 'One camera shot and how the view blends to it.', [
    enm('rig', 'Rig', 'How the camera moves: follow/orbit a target, orbit a point, straight down onto the target, fixed where it is placed, along a camera path, or track a target without turning (dead zone, bounds).', VIRTUAL_CAMERA_RIGS, { required: true, default: 'follow', labels: { follow: 'Follow / orbit', orbitPoint: 'Orbit a point', topDown: 'Top-down', fixed: 'Fixed / look-at', rail: 'Rail (path)', track: 'Track (dead zone)' } }),
    int('priority', 'Priority', 'The enabled camera with the highest priority is live (on a tie: the one activated last, then the first in the scene).', { min: VCL.priority.min, max: VCL.priority.max, default: VCD.priority }),
    bool('enabled', 'Enabled at start', 'Takes part from the start; scripts activate and deactivate cameras (ctx.camera).', { default: VCD.enabled }),
    entity('target', 'Target', 'The object it follows, circles or looks at (none: the rig centres on where the camera is placed; fixed and rail cameras look ahead).', { anyScene: true }),
    vec3('targetOffset', 'Target offset', 'Added to the target\'s position (e.g. a character\'s head height).', { min: VCL.offset.min, max: VCL.offset.max, step: 0.1, unit: 'm', default: [...VCD.targetOffset] }),
    num('distance', 'Distance', 'How far from the target (or point) it sits; top-down: the height above it.', { when: TRACKING, min: VCL.distance.min, max: VCL.distance.max, step: 0.5, unit: 'm', default: VCD.distance }),
    num('minDistance', 'Min distance', 'The closest it zooms, and the closest a wall pulls it in.', { when: ORBITING, min: VCL.minDistance.min, max: VCL.minDistance.max, step: 0.1, unit: 'm', default: VCD.minDistance }),
    num('maxDistance', 'Max distance', 'The farthest it zooms out.', { when: ORBITING, min: VCL.maxDistance.min, max: VCL.maxDistance.max, step: 1, unit: 'm', default: VCD.maxDistance }),
    num('yaw', 'Yaw', 'The heading around the target (0: on its +Z side looking toward −Z).', { when: TRACKING, min: VCL.yaw.min, max: VCL.yaw.max, step: 5, unit: 'deg', default: VCD.yaw }),
    num('pitch', 'Pitch', 'How far above the target it looks down (negative: from below).', { when: ORBITING, min: VCL.pitch.min, max: VCL.pitch.max, step: 1, unit: 'deg', default: VCD.pitch }),
    num('pitchMin', 'Pitch min', 'The lowest a player tilts it.', { when: ORBITING, min: VCL.pitch.min, max: VCL.pitch.max, step: 1, unit: 'deg', default: VCD.pitchMin }),
    num('pitchMax', 'Pitch max', 'The highest a player tilts it.', { when: ORBITING, min: VCL.pitch.min, max: VCL.pitch.max, step: 1, unit: 'deg', default: VCD.pitchMax }),
    str('yawAction', 'Turn action', 'An input action (axis) that turns it around the target (a 2D axis: x turns, y tilts).', { ...ACTION_NAME, when: when('rig', 'follow'), group: 'Input' }),
    str('pitchAction', 'Tilt action', 'An input action (axis) that tilts it.', { ...ACTION_NAME, when: ORBITING, group: 'Input' }),
    num('rotateSpeed', 'Turn speed', 'Turning and tilting speed at full input (degrees per second).', { when: ORBITING, min: VCL.rotateSpeed.min, max: VCL.rotateSpeed.max, step: 10, unit: 'deg', default: VCD.rotateSpeed, group: 'Input' }),
    str('zoomAction', 'Zoom action', 'An input action (axis) that moves it closer (negative) or farther (positive).', { ...ACTION_NAME, when: ORBITING, group: 'Input' }),
    num('zoomSpeed', 'Zoom speed', 'Zoom speed at full input.', { when: ORBITING, min: VCL.zoomSpeed.min, max: VCL.zoomSpeed.max, step: 1, unit: 'm/s', default: VCD.zoomSpeed, group: 'Input' }),
    str('turnLeftAction', 'Turn left action', 'An input action (button): each press turns one step to the left.', { ...ACTION_NAME, when: when('rig', 'orbitPoint'), group: 'Input' }),
    str('turnRightAction', 'Turn right action', 'An input action (button): each press turns one step to the right.', { ...ACTION_NAME, when: when('rig', 'orbitPoint'), group: 'Input' }),
    num('yawStep', 'Turn step', 'How far one press turns (the yaw snaps to whole steps).', { when: when('rig', 'orbitPoint'), min: VCL.yawStep.min, max: VCL.yawStep.max, step: 5, unit: 'deg', default: VCD.yawStep }),
    num('turnTime', 'Turn time', 'How long a snapped turn takes (0: at once).', { when: when('rig', 'orbitPoint'), min: VCL.turnTime.min, max: VCL.turnTime.max, step: 0.05, unit: 's', default: VCD.turnTime }),
    vec3('point', 'Point', 'The world point it circles (absent: the target, else where the camera is placed).', { when: when('rig', 'orbitPoint'), min: VCL.point.min, max: VCL.point.max, step: 0.5, unit: 'm', handle: 'point' }),
    bool('collision', 'Collision', 'Pulled in front of colliders between it and the target (3D projects).', { when: when('rig', 'follow'), default: VCD.collision }),
    num('collisionRadius', 'Collision radius', 'The clearance it keeps from what it is pulled in by.', { when: when('rig', 'follow'), min: VCL.collisionRadius.min, max: VCL.collisionRadius.max, step: 0.05, unit: 'm', default: VCD.collisionRadius }),
    // The track rig — its offset from the framed point, the dead zone and the bounds (world axes).
    vec3('trackOffset', 'Offset', 'Where the camera sits relative to the point it frames (absent: where it is placed relative to the target at the start).', { when: TRACK, min: VCL.offset.min, max: VCL.offset.max, step: 0.5, unit: 'm' }),
    vec3('deadZone', 'Dead zone', 'The box (width, height, depth) around the framed point the target moves in before the camera follows (0: always follows).', { when: TRACK, min: VCL.deadZone.min, max: VCL.deadZone.max, step: 0.1, unit: 'm', default: [0, 0, 0], labels: ['w', 'h', 'd'], handle: 'box3' }),
    vec3('boundsMin', 'Bounds min', 'The framed point never goes below this on any axis (absent: no limit).', { when: TRACK, min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    vec3('boundsMax', 'Bounds max', 'The framed point never goes above this on any axis (absent: no limit).', { when: TRACK, min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    // Look-ahead (per axis; a vertical look-ahead is [0, t, 0]).
    vec3('lookAhead', 'Look-ahead', 'Frames this many seconds of the target\'s movement ahead of it, per axis (0: none; a vertical look-ahead [0, t, 0] shows the ground below a fall).', { when: TRACK, min: VCL.lookAhead.min, max: VCL.lookAhead.max, step: 0.05, unit: 's', default: [0, 0, 0], labels: ['x', 'y', 'z'] }),
    vec3('lookAheadMax', 'Look-ahead max', 'The farthest it looks ahead, per axis.', { when: TRACK, min: VCL.lookAheadMax.min, max: VCL.lookAheadMax.max, step: 0.5, unit: 'm', default: [...VCD.lookAheadMax], labels: ['x', 'y', 'z'] }),
    num('lookAheadSmoothing', 'Look-ahead smoothing', 'How long a change of the target\'s speed takes to show in the look-ahead (0: at once).', { when: TRACK, min: VCL.lookAheadSmoothing.min, max: VCL.lookAheadSmoothing.max, step: 0.05, unit: 's', default: VCD.lookAheadSmoothing }),
    num('damping', 'Damping', 'How long it lags behind a moving target (0: rigid; the track rig\'s smoothing).', { when: DAMPED, min: VCL.damping.min, max: VCL.damping.max, step: 0.05, unit: 's', default: VCD.damping }),
    entity('path', 'Path', 'The object carrying the camera path it rides (none: it stays where it is placed).', { when: when('rig', 'rail'), component: 'cameraPath', anyScene: true }),
    num('progress', 'Progress', 'Where along the path it starts (0: the first point, 1: the end).', { when: when('rig', 'rail'), min: VCL.progress.min, max: VCL.progress.max, step: 0.01, default: VCD.progress }),
    num('railSpeed', 'Rail speed', 'How fast it rides the path (negative: backwards; 0: stays until a script moves it).', { when: when('rig', 'rail'), min: VCL.railSpeed.min, max: VCL.railSpeed.max, step: 0.5, unit: 'm/s', default: VCD.railSpeed }),
    enm('railMode', 'At the end', 'Stop at the end, loop to the start, or ride back and forth.', CAMERA_RAIL_MODES, { when: when('rig', 'rail'), default: VCD.railMode, labels: { once: 'Stop', loop: 'Loop', pingpong: 'Back and forth' } }),
    num('fovY', 'Field of view', 'Vertical field of view (absent: the project\'s camera setting).', { min: VCL.fovY.min, max: VCL.fovY.max, step: 1, unit: 'deg', group: 'Lens' }),
    num('near', 'Near', 'The near clipping plane (absent: the project\'s camera setting).', { min: VCL.near.min, max: VCL.near.max, step: 0.01, unit: 'm', group: 'Lens' }),
    num('far', 'Far', 'The far clipping plane (absent: the project\'s camera setting).', { min: VCL.far.min, max: VCL.far.max, step: 10, unit: 'm', group: 'Lens' }),
    enm('blend', 'Blend in', 'How the view moves to this camera when it goes live: a cut, a constant-speed move or an eased move.', CAMERA_BLENDS, { default: VCD.blend, group: 'Blend' }),
    num('blendTime', 'Blend time', 'How long the move to this camera takes.', { when: when('blend', 'linear', 'eased'), min: VCL.blendTime.min, max: VCL.blendTime.max, step: 0.1, unit: 's', default: VCD.blendTime, group: 'Blend' }),
    num('letterbox', 'Letterbox', 'Black bars over the top and bottom while it is live (each a share of the view height).', { min: VCL.letterbox.min, max: VCL.letterbox.max, step: 0.01, default: VCD.letterbox, group: 'Effects' }),
    num('shakeAmplitude', 'Shake', 'A constant shake while it is live (0: none).', { min: VCL.shakeAmplitude.min, max: VCL.shakeAmplitude.max, step: 0.01, unit: 'm', default: VCD.shakeAmplitude, group: 'Effects' }),
    num('shakeFrequency', 'Shake frequency', 'How fast it shakes.', { min: VCL.shakeFrequency.min, max: VCL.shakeFrequency.max, step: 0.5, unit: 'Hz', default: VCD.shakeFrequency, group: 'Effects' }),
    num('shakeRotation', 'Shake rotation', 'How much the shake also turns it.', { min: VCL.shakeRotation.min, max: VCL.shakeRotation.max, step: 0.5, unit: 'deg', default: VCD.shakeRotation, group: 'Effects' }),
  ], { rules: ['pitchMin ≤ pitchMax, minDistance ≤ maxDistance and near < far when both are set'] }),
  // A new camera follows at the defaults (5 m away, 20° above); its target is picked next.
  add: { kind: 'menu', value: { rig: 'follow' } },
  presets: [
    { label: 'Follow / orbit', value: { rig: 'follow' } },
    { label: 'Orbit a point (snapped turns)', value: { rig: 'orbitPoint', distance: 15, pitch: 45 } },
    { label: 'Top-down', value: { rig: 'topDown', distance: 15 } },
    { label: 'Fixed / look-at', value: { rig: 'fixed' } },
    // Frames its target as placed, following once it leaves a 2 × 1 m box (about a body's reach), with a short 0.2 s lag.
    { label: 'Track (dead zone)', value: { rig: 'track', deadZone: [2, 1, 2], damping: 0.2 } },
  ],
  // The track rig's shot as its own object (the target is picked in the Inspector; without one it frames where it is placed).
  // A plain shot: the view from where it is placed (the scene's own camera before the engine owned the view).
  create: [
    { label: 'Camera', menu: 'Cameras', value: { rig: 'fixed' } },
    { label: 'Camera track', menu: 'Cameras', value: { rig: 'track', deadZone: [2, 1, 2], damping: 0.2 } },
  ],
  icon: 'camera',
  handles: [
    { kind: 'point', label: 'Orbit point', bind: { point: 'point' }, space: 'world', when: when('rig', 'orbitPoint') },
    // The track rig's dead zone (around its target, where it frames it at the start) and bounds (world corners).
    { kind: 'box3', label: 'Dead zone', bind: { size: 'deadZone' }, space: 'local', when: TRACK, anchor: { entity: 'target', offset: 'targetOffset' } },
    { kind: 'bounds', label: 'Bounds', bind: { min: 'boundsMin', max: 'boundsMax' }, space: 'world', when: TRACK },
  ],
  excludes: [],
  prefab: false,
};

export const cameraPath: ComponentDescriptor = {
  name: 'cameraPath',
  label: 'Camera path',
  tooltip: 'A path rail cameras ride (points as offsets from where this object is placed).',
  category: 'Camera',
  value: obj('cameraPath', 'Camera path', 'Points a rail camera rides through.', [
    list('points', 'Points', `${CAMERA_PATH_LIMITS.minPoints}–${CAMERA_PATH_LIMITS.maxPoints} points, as offsets from where the object is placed.`, vec3('*', 'Point', 'An offset [x, y, z].', { min: -CAMERA_PATH_LIMITS.coordinate, max: CAMERA_PATH_LIMITS.coordinate, step: 0.1, unit: 'm' }), { required: true, minItems: CAMERA_PATH_LIMITS.minPoints, maxItems: CAMERA_PATH_LIMITS.maxPoints, handle: 'path', default: [[0, 0, 0], [6, 0, 0]] }),
    bool('closed', 'Closed', 'The path runs back from the last point to the first.', { default: false }),
    bool('smooth', 'Smooth', 'A smooth curve through the points (off: straight segments).', { default: true }),
  ]),
  // A new path is a 6 m straight run sideways (a dolly move across a small set).
  add: { kind: 'menu', value: { points: [[0, 0, 0], [6, 0, 0]] } },
  handles: [{ kind: 'path', label: 'Path', bind: { points: 'points' }, space: 'local', loop: when('closed', true) }],
  excludes: [],
  prefab: false,
};

// A place where track cameras frame differently.
const CRD = CAMERA_REGION_DEFAULTS;
const CRL = CAMERA_REGION_LIMITS;
export const cameraRegion: ComponentDescriptor = {
  name: 'cameraRegion',
  label: 'Camera region',
  tooltip: 'While a track camera\'s target is inside this box, the camera uses the region\'s dead zone, bounds and distance (each absent: the camera\'s own); entering or leaving blends between them. A room, a corridor, an arena, a vista: any place that frames differently.',
  category: 'Camera',
  value: obj('cameraRegion', 'Camera region', 'How track cameras frame while their target is inside.', [
    vec3('size', 'Size', 'Width, height (and depth; absent: every depth), centred on the object along the world axes (its rotation is not used).', { required: true, min: CRL.size.min, max: CRL.size.max, step: 0.5, unit: 'm', default: [10, 6], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    entity('camera', 'Camera', 'The track camera it applies to (none: every track camera).', { component: 'virtualCamera', anyScene: true }),
    int('priority', 'Priority', 'Where regions overlap the highest wins (on a tie: the one entered last).', { min: VCL.priority.min, max: VCL.priority.max, default: CRD.priority }),
    vec3('deadZone', 'Dead zone', 'The camera\'s dead zone in here (absent: its own).', { min: VCL.deadZone.min, max: VCL.deadZone.max, step: 0.1, unit: 'm', labels: ['w', 'h', 'd'], handle: 'box3' }),
    vec3('boundsMin', 'Bounds min', 'The framed point stays at or above this in here, from the region\'s position (absent: the camera\'s own).', { min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    vec3('boundsMax', 'Bounds max', 'The framed point stays at or below this in here, from the region\'s position (absent: the camera\'s own).', { min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    num('distance', 'Distance', 'The camera\'s distance from the framed point in here, along its offset (absent: its own offset).', { min: VCL.distance.min, max: VCL.distance.max, step: 0.5, unit: 'm' }),
    num('blendTime', 'Blend time', 'How long entering or leaving blends the camera to its new framing (0: at once).', { min: VCL.blendTime.min, max: VCL.blendTime.max, step: 0.1, unit: 's', default: CRD.blendTime }),
  ]),
  // 10 × 6 m: a room about two storeys high (the default 1.8 m character several strides from wall to wall).
  add: { kind: 'menu', value: { size: [10, 6] } },
  create: [
    { label: 'Camera region', menu: 'Cameras', dimension: 2 },
    { label: 'Camera region', menu: 'Cameras', value: { size: [10, 6, 10] }, dimension: 3 },
  ],
  icon: 'camera',
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'position' },
    { kind: 'bounds', label: 'Bounds', bind: { min: 'boundsMin', max: 'boundsMax' }, space: 'local' },
    { kind: 'box3', label: 'Dead zone', bind: { size: 'deadZone' }, space: 'local' },
  ],
  excludes: [],
  prefab: false,
};

// An object riding on a node of another object's model.
export const socketAttach: ComponentDescriptor = {
  name: 'socketAttach',
  label: 'Socket',
  tooltip: 'Rides on a named node (a bone or any node) of another object\'s model, with an offset: equipment in a hand, a rider on a mount, a pilot in a cockpit. The simulation places it every step, following the target\'s animation; scripts attach and detach at run time (ctx.sockets).',
  category: 'Object',
  value: obj('socketAttach', 'Socket', 'The node this object rides on and its offset from it.', [
    entity('target', 'Target', 'The object whose model carries the node.', { required: true, component: 'model' }),
    str('node', 'Node', 'The node (or bone) of the target\'s model it rides on (the list shows the model\'s nodes).', { required: true, minLength: 1, maxLength: SOCKET_ATTACH_LIMITS.nodeName, format: 'socketNode' }),
    vec3('position', 'Offset', 'The offset from the node, in the node\'s space.', { min: -SOCKET_ATTACH_LIMITS.offset, max: SOCKET_ATTACH_LIMITS.offset, step: 0.05, unit: 'm', default: [0, 0, 0] }),
    { type: 'quat', key: 'rotation', label: 'Rotation offset', tooltip: 'The rotation from the node\'s (the Inspector shows degrees).', default: [0, 0, 0, 1] },
    vec3('scale', 'Scale', 'Scale relative to the node.', { min: SOCKET_ATTACH_LIMITS.scaleMin, max: SOCKET_ATTACH_LIMITS.scaleMax, step: 0.05, default: [1, 1, 1] }),
    bool('attached', 'Attached at start', 'Rides on the node from the start (off: a script attaches it later with ctx.sockets.attach).', { default: true }),
  ]),
  // A socket needs its target (picked first; the node starts as a placeholder name picked from the target's list next).
  add: { kind: 'pick', value: {}, pick: ['target'] },
  handles: [],
  excludes: SOCKET_ATTACH_CONFLICTS.map((c) => ({ component: c, reason: 'a physics body is posed by physics, not by a socket' })),
  prefab: false,
};

const LIGHT_TYPES = ['directional', 'ambient', 'point', 'spot', 'hemisphere'] as const;
export const light: ComponentDescriptor = {
  name: 'light',
  label: 'Light',
  tooltip: 'A light: directional (the sun), ambient, point, spot or hemisphere (sky and ground).',
  category: 'Lighting',
  value: obj('light', 'Light', 'A light source.', [
    enm('type', 'Type', 'The kind of light.', LIGHT_TYPES, { required: true, default: 'point' }),
    color('color', 'Colour', 'The light colour (a hemisphere light: the sky colour).', { required: true, default: '#ffffff' }),
    num('intensity', 'Intensity', 'Brightness.', { required: true, when: when('type', 'directional', 'ambient', 'hemisphere'), min: 0, max: MAX_INTENSITY, step: 0.05, default: 1 }),
    num('intensity', 'Intensity', 'Brightness in candela.', { required: true, when: when('type', 'point', 'spot'), min: 0, max: MAX_LOCAL_INTENSITY, step: 1, unit: 'cd', default: 30 }),
    vec3('direction', 'Direction', 'Where the light shines (need not be unit length; not all 0).', { required: true, when: when('type', 'directional'), min: -1, max: 1, step: 0.05, nonZero: true, handle: 'direction', default: [0.4, -1, -0.3] }),
    vec3('direction', 'Direction', 'Where the spot points (not all 0).', { required: true, when: when('type', 'spot'), min: -1, max: 1, step: 0.05, nonZero: true, handle: 'cone', default: [0, -1, 0] }),
    bool('castShadow', 'Cast shadows', 'The light casts shadows.', { when: when('type', 'directional', 'point', 'spot'), default: false }),
    // The sun's shadow map as data (defaults and their reasons: project-model DIRECTIONAL_SHADOW_DEFAULTS).
    int('shadowMapSize', 'Shadow map size', 'Shadow resolution in texels per side (sharper, more memory).', { when: when('type', 'directional'), values: [...DIRECTIONAL_SHADOW_LIMITS.mapSizes], default: DIRECTIONAL_SHADOW_DEFAULTS.mapSize, omitDefault: true }),
    num('shadowBias', 'Shadow bias', 'Depth offset of the shadow test (more negative: less acne, shadows may detach).', { when: when('type', 'directional'), min: DIRECTIONAL_SHADOW_LIMITS.bias.min, max: DIRECTIONAL_SHADOW_LIMITS.bias.max, step: 0.0001, default: DIRECTIONAL_SHADOW_DEFAULTS.bias, omitDefault: true }),
    num('shadowNormalBias', 'Shadow normal bias', 'Offset along the surface normal (removes stripes on grazing surfaces).', { when: when('type', 'directional'), min: DIRECTIONAL_SHADOW_LIMITS.normalBias.min, max: DIRECTIONAL_SHADOW_LIMITS.normalBias.max, step: 0.005, unit: 'm', default: DIRECTIONAL_SHADOW_DEFAULTS.normalBias, omitDefault: true }),
    num('shadowExtent', 'Shadow extent', 'Half the side of the shadowed square around the camera (v4 games; a v3 game uses its level bounds).', { when: when('type', 'directional'), min: DIRECTIONAL_SHADOW_LIMITS.extent.min, max: DIRECTIONAL_SHADOW_LIMITS.extent.max, step: 1, unit: 'm', default: DIRECTIONAL_SHADOW_DEFAULTS.extent, omitDefault: true }),
    num('range', 'Range', 'Light reaches this far (0: unlimited).', { when: when('type', 'point'), min: 0, max: 1000, step: 0.5, unit: 'm', default: 0, handle: 'radius' }),
    num('range', 'Range', 'Light reaches this far (0: unlimited).', { when: when('type', 'spot'), min: 0, max: 1000, step: 0.5, unit: 'm', default: 0, handle: 'cone' }),
    num('decay', 'Decay', 'How fast it fades with distance (2: physically correct).', { when: when('type', 'point', 'spot'), min: 0, max: 4, step: 0.1, default: 2 }),
    num('angle', 'Angle', 'Half-angle of the spot cone.', { when: when('type', 'spot'), min: 1, max: 89, step: 1, unit: 'deg', default: 30, handle: 'cone' }),
    num('penumbra', 'Soft edge', 'How soft the cone edge is (0: hard).', { when: when('type', 'spot'), min: 0, max: 1, step: 0.05, default: 0.2 }),
    // A spot light's cookie (directional lights get none).
    asset('cookie', 'Cookie', 'A texture projected through the cone (the light is tinted and masked by it: a window frame, leaves, a logo).', ['texture'], { when: when('type', 'spot') }),
    color('groundColor', 'Ground colour', 'The colour from below.', { when: when('type', 'hemisphere'), default: '#444444' }),
    enm('mode', 'Mode', 'Realtime, baked into lightmaps, or both (mixed).', ['realtime', 'baked', 'mixed'], { default: 'realtime', omitDefault: true }),
    lightLayerMask('lightMask', 'Light mask', 'The light layers it lights: an object is lit only when it is in one of them.', 0),
    lightLayerMask('shadowCasterMask', 'Shadow caster mask', 'Only objects in one of these light layers cast its shadow.', 0, { when: when('type', 'directional', 'point', 'spot') }),
    enm('importance', 'Importance', 'Auto: as each lit object says; or always per pixel (a hero light) or per vertex (a cheap fill).', LIGHT_IMPORTANCES, { when: when('type', 'point', 'spot'), default: 'auto', omitDefault: true, labels: { auto: 'Auto', pixel: 'Per pixel', vertex: 'Per vertex' } }),
  ]),
  add: { kind: 'menu', value: { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } },
  // Genre-neutral reasons (the GameObject menu creates these too):
  // - directional and ambient = a new project's starter lights: a white key from
  //   above-front at 1.2 casting shadows (a lone key without shadows flattens any
  //   scene) over a cool fill at 0.6 (shadowed sides stay readable, not black).
  // - point: a warm lamp (most placed point lights stand for a lamp, torch or
  //   candle), 30 cd reaching 8 m (a room); spot: white 80 cd, a 30° cone 12 m
  //   long pointing down (a ceiling spot or a stage light).
  // - hemisphere: a pale sky over a neutral grey ground (#444444, the field
  //   default; it was an earth brown, which assumes an outdoor ground).
  presets: [
    { label: 'Directional light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: true } },
    { label: 'Ambient light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6 } },
    { label: 'Point light', value: { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } },
    { label: 'Spot light', value: { type: 'spot', color: '#ffffff', intensity: 80, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0] } },
    { label: 'Hemisphere light', value: { type: 'hemisphere', color: '#bcd7ff', groundColor: '#444444', intensity: 0.8 } },
  ],
  handles: [
    { kind: 'direction', label: 'Direction', bind: { direction: 'direction' }, space: 'world', when: when('type', 'directional') },
    { kind: 'cone', label: 'Cone', bind: { direction: 'direction', angle: 'angle', range: 'range' }, space: 'local', when: when('type', 'spot'), follows: 'rotation' },
    { kind: 'radius', label: 'Range', bind: { radius: 'range' }, space: 'local', when: when('type', 'point') },
  ],
  excludes: [{ component: 'instances', reason: 'an instance set is scenery' }],
  prefab: false,
  rules: [
    'At most one directional, one ambient and one hemisphere light and 16 point/spot lights per scene; any scene may hold any light.',
    'With scenes loaded together, the most recently loaded scene\'s directional, ambient and hemisphere light is on (each kind on its own); the others come back when it unloads.',
    'Point and spot lights of all loaded scenes share the budget of 16; past it the most recently loaded scenes\' lights are on.',
  ],
};

export const surface: ComponentDescriptor = {
  name: 'surface',
  label: 'Surface',
  tooltip: 'Simple look overrides for a box or model: colour, roughness, metalness and glow.',
  category: 'Rendering',
  value: obj('surface', 'Surface', 'Surface look.', [
    color('color', 'Colour', 'Base colour.', { default: SURFACE_DEFAULTS.color }),
    num('roughness', 'Roughness', '0: mirror-like, 1: matte.', { min: 0, max: 1, step: 0.05, default: SURFACE_DEFAULTS.roughness }),
    num('metalness', 'Metalness', '0: plastic/wood/stone, 1: metal.', { min: 0, max: 1, step: 0.05, default: SURFACE_DEFAULTS.metalness }),
    color('emissive', 'Glow colour', 'Light it gives off.', { default: SURFACE_DEFAULTS.emissive }),
    num('emissiveIntensity', 'Glow strength', 'How strongly it glows.', { min: 0, max: MAX_EMISSIVE_INTENSITY, step: 0.1, default: SURFACE_DEFAULTS.emissiveIntensity }),
  ]),
  add: { kind: 'menu', value: { ...SURFACE_DEFAULTS } },
  handles: [],
  requiresAnyOf: { components: ['box', 'model'], reason: 'a surface colours a box or a model' },
  excludes: [],
  prefab: true,
};

export const modelAnimation: ComponentDescriptor = {
  name: 'modelAnimation',
  label: 'Model animation (old)',
  tooltip: 'The old idle/run/airborne clip roles. Projects are moved to an animator when opened; this stays only where the clips could not be measured.',
  category: 'Animation',
  value: obj('modelAnimation', 'Model animation (old)', 'Idle, run and airborne clips.', [
    asset('assetId', 'Model', 'The entity\'s model asset.', ['model'], { required: true, readOnly: true }),
    int('version', 'Version', 'The model version the roles were made for.', { required: true, min: 1, readOnly: true }),
    obj('roles', 'Roles', 'The clip per role.', [
      json('idle', 'Idle', 'The idle clip binding.', { required: true, readOnly: true }),
      json('run', 'Run', 'The run clip binding.', { required: true, readOnly: true }),
      json('airborne', 'Airborne', 'The airborne clip binding.', { required: true, readOnly: true }),
    ], { required: true, readOnly: true }),
  ]),
  add: { kind: 'never', reason: 'replaced by the animator (kept for old data)' },
  handles: [],
  requiresAnyOf: { components: ['model'], reason: 'it animates the object\'s model' },
  excludes: [{ component: 'instances', reason: 'an instance set is not animated' }],
  prefab: false,
  legacy: true,
};

export const folder: ComponentDescriptor = {
  name: 'folder',
  label: 'Folder',
  tooltip: 'Organises objects in the Hierarchy; carries nothing else.',
  category: 'Organisation',
  value: obj('folder', 'Folder', 'A folder (no fields).', []),
  add: { kind: 'tool', tool: 'createFolder' },
  handles: [],
  excludes: [],
  prefab: false,
  rules: ['A folder carries no transform and no other component.'],
};

export const instances: ComponentDescriptor = {
  name: 'instances',
  label: 'Instance set',
  tooltip: 'One model placed many times (grass, rocks, trees), stored as a binary transform buffer.',
  category: 'Rendering',
  value: obj('instances', 'Instance set', 'A model and its copies.', [
    obj('asset', 'Asset', 'The model placed.', [
      asset('assetId', 'Model', 'The model file.', ['model'], { required: true }),
      str('piece', 'Piece', 'One named piece of a multi-piece file (absent: the whole file).', NAME),
    ], { required: true }),
    str('buffer', 'Buffer', 'The SHA-256 of the copies\' transforms (written by the brush and import tools).', { format: 'sha256', minLength: 64, maxLength: 64, required: true, readOnly: true }),
    int('count', 'Copies', 'How many copies the buffer holds.', { min: 1, max: MAX_INSTANCES, required: true, readOnly: true }),
    // Off by default: an instance set is mostly foliage and scatter, whose many small shadows cost a shadow pass
    // more than they show; a set of rocks or trees that should cast turns it on.
    bool('castShadow', 'Casts shadows', 'Blocks the directional light: casts a realtime shadow (off unless set: foliage and scatter rarely need one).', { default: false, omitDefault: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the realtime shadows falling on it.', { default: true, omitDefault: true }),
    lightLayerMask('lightLayers', 'Light layers', 'The light layers it is in: only lights whose light mask shares one of them light it, and it casts shadows only for lights whose shadow caster mask shares one.', 1),
    enm('localLights', 'Local lights', `Point, spot and effect lights per pixel, per vertex (diffuse only, cheap) or none (—: as the material says, else ${INSTANCES_LOCAL_LIGHTS_DEFAULT === 'vertex' ? 'per vertex' : 'per pixel'}).`, LOCAL_LIGHT_MODES, { labels: LOCAL_LIGHT_LABELS }),
    // Absent = the project's Instance chunk size (32 m unless set).
    num('chunkSize', 'Chunk size', 'The copies are drawn in chunks about this wide, each hidden when out of view (absent: the project\'s Instance chunk size). Each chunk draws one level of detail for its copies unless "Level per copy" is on.', { min: 1, max: 4096, step: 1, unit: 'm' }),
    // Off by default: a chunk straddling a switch point draws once per level when on (performance first).
    bool('lodPerCopy', 'Level per copy', 'Each copy picks its own level of detail by its own distance and size, instead of the level its chunk picks at its centre: truer where a chunk spans a switch point, at one more draw per level in each such chunk.', { default: false, omitDefault: true }),
    // Absent = the engine's density falloff (model-lod.ts): far copies thin out where they are a few pixels across.
    num('densityStart', 'Thinning starts at', `Copies start thinning out where they cover less than this share of the screen height (absent: ${INSTANCE_DENSITY_START_DEFAULT}).`, { min: INSTANCE_DENSITY_SIZE_MIN, max: 1, step: 0.001 }),
    num('densityEnd', 'Thinnest at', `Below this share of the screen height only the "Thinnest density" share of copies is drawn (absent: ${INSTANCE_DENSITY_END_DEFAULT}).`, { min: INSTANCE_DENSITY_SIZE_MIN, max: 1, step: 0.001 }),
    num('densityMin', 'Thinnest density', `The share of copies drawn where they are smallest (1: no thinning; absent: ${INSTANCE_DENSITY_MIN_DEFAULT}).`, { min: 0, max: 1, step: 0.05 }),
  ]),
  add: { kind: 'tool', tool: 'instance brush or instance import' },
  handles: [],
  excludes: [
    ...['box', 'model', 'collider', 'controller', 'modelAnimation', 'playerSpawn', 'light'].map((c) => ({ component: c, reason: 'an instance set is one model placed many times, with nothing of its own' })),
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
  ],
  prefab: false,
};

export const materials: ComponentDescriptor = {
  name: 'materials',
  label: 'Materials',
  tooltip: 'Which project material each of the object\'s materials uses ("*": all of them).',
  category: 'Rendering',
  value: map('materials', 'Materials', 'Material slot → project material.', 'Slot', ref('*', 'Material', 'A project material.', 'material'), { keyFormat: 'materialSlot', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS }),
  add: { kind: 'pick', value: {}, pick: ['*'] },
  handles: [],
  requiresAnyOf: { components: ['model', 'box', 'instances'], reason: 'materials dress a model, a box or an instance set' },
  excludes: [],
  prefab: true,
};

// Per-object overrides of graph-material parameters (extends the material mapping).
export const materialParams: ComponentDescriptor = {
  name: 'materialParams',
  label: 'Material parameters',
  tooltip: 'This object\'s values for the public parameters of its graph materials (the materials keep their own values elsewhere).',
  category: 'Rendering',
  value: map(
    'materialParams',
    'Material parameters',
    'Graph material → its overridden parameters.',
    'Material',
    map('*', 'Parameters', 'Parameter → value (only public parameters).', 'Parameter', json('*', 'Value', 'A value of the parameter\'s type (number, 2–4 numbers, "#rrggbb" or a texture asset id).', { typedBy: 'materialParameter' }), { keyFormat: 'identifier', minEntries: 1, maxEntries: MAX_MATERIAL_PARAMETERS }),
    { keyRef: 'material', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS },
  ),
  add: { kind: 'tool', tool: 'the Materials section of the Inspector (override a public parameter)' },
  handles: [],
  requiresAnyOf: { components: ['model', 'box', 'instances'], reason: 'material parameters belong to the materials of a model, a box or an instance set' },
  excludes: [],
  prefab: true,
};

// A visual effect played from the entity.
export const effectComponent: ComponentDescriptor = {
  name: 'effect',
  label: 'Effect',
  tooltip: 'Plays a visual effect (particles) from this object. Visual only: it never changes the game simulation.',
  category: 'Rendering',
  value: obj('effect', 'Effect', 'The effect and this object\'s values for its public parameters.', [
    ref('effectId', 'Effect', 'The project effect.', 'effect', { required: true }),
    bool('playOnStart', 'Play on start', 'Starts when the scene starts (off: a trigger or script plays it).', { default: true, omitDefault: true }),
    map('params', 'Parameters', 'Values for the effect\'s public parameters (absent: the effect\'s defaults).', 'Parameter', json('*', 'Value', 'A value of the parameter\'s type (a number, 3 numbers or "#rrggbb").', { typedBy: 'effectParameter' }), { keyFormat: 'identifier', maxEntries: EFFECT_LIMITS.parameters }),
    // triggers.
    signal('signal', 'Play on signal', 'Starts (or restarts) the effect when this signal is sent (a switch, trigger or script).'),
    signal('stopSignal', 'Stop on signal', 'Stops spawning when this signal is sent; living particles finish.'),
  ]),
  add: { kind: 'pick', value: {}, pick: ['effectId'] },
  handles: [],
  excludes: [],
  prefab: true,
};

export const fogVolume: ComponentDescriptor = {
  name: 'fogVolume',
  label: 'Fog volume',
  tooltip: 'A box of fog (mist in a valley, smoke in a room).',
  category: 'Rendering',
  value: obj('fogVolume', 'Fog volume', 'A fog box.', [
    vec3('size', 'Size', 'Width, height and depth.', { required: true, min: 0, minExclusive: true, max: 1000, step: 0.5, unit: 'm', default: [6, 3, 4], labels: ['w', 'h', 'd'], handle: 'box3' }),
    num('density', 'Density', 'How thick the fog is.', { required: true, min: 0, max: 1, step: 0.01, default: 0.25 }),
    color('color', 'Colour', 'The fog colour.', { required: true, default: '#dfe7ef' }),
    num('falloff', 'Soft edges', '0: a hard box, 1: fades from the centre.', { min: 0, max: 1, step: 0.05, default: 0.5 }),
    num('heightFalloff', 'Height falloff', 'How fast the fog thins with height above the bottom (0: even).', { min: 0, max: 10, step: 0.05, unit: '1/m', default: 0 }),
  ]),
  // A room-sized 6 × 3 × 4 m box of light grey-blue haze at a quarter density with soft edges — visible
  // at once, easy to resize; no setting assumed (valley mist, room smoke, steam).
  add: { kind: 'menu', value: { size: [6, 3, 4], density: 0.25, color: '#dfe7ef', falloff: 0.5 } },
  create: [{ label: 'Fog volume', menu: 'Light' }],
  icon: 'fog',
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: false,
  rules: ['At most 16 fog volumes per scene.'],
};

export const probeVolume: ComponentDescriptor = {
  name: 'probeVolume',
  label: 'Probe volume',
  tooltip: 'A box the probe bake fills with light probes (Lighting window → Bake probes). Without any, the bake covers the static objects.',
  category: 'Rendering',
  value: obj('probeVolume', 'Probe volume', 'A box of light probes.', [
    vec3('size', 'Size', 'Width, height and depth (axis-aligned in the world).', { required: true, min: 0, minExclusive: true, max: 100000, step: 1, unit: 'm', default: [16, 6, 16], labels: ['w', 'h', 'd'], handle: 'box3' }),
    num('spacing', 'Spacing', 'Meters between probes horizontally (half that vertically near the bottom). Absent: the bake\'s spacing.', { min: PROBE_SPACING_MIN, max: PROBE_SPACING_MAX, step: 0.25, unit: 'm', default: DEFAULT_PROBE_SPACING }),
  ]),
  // A room-to-courtyard sized box: easy to see and resize over the part of a level that needs its own probes.
  add: { kind: 'menu', value: { size: [16, 6, 16] } },
  create: [{ label: 'Probe volume', menu: 'Light' }],
  icon: 'fog',
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: false,
};

// The behavior group an object's behavior belongs to (game modes tick groups).
export const behaviorGroupC: ComponentDescriptor = {
  name: 'behaviorGroup',
  label: 'Behavior group',
  tooltip: 'The group this object\'s behavior belongs to. A game mode lists the groups that tick while it is active; the others pause (their scripts do not run).',
  category: 'Scripting',
  value: obj('behaviorGroup', 'Behavior group', 'The group of this object\'s behavior.', [
    ref('group', 'Group', 'One of the project\'s behavior groups (Game modes panel).', 'behaviorGroup', { required: true }),
  ]),
  // The group is picked when the component is added (the project's first group as a start).
  add: { kind: 'pick', value: {}, pick: ['group'] },
  handles: [],
  excludes: [],
  prefab: true,
};

// One game mode (the Game modes panel edits it; setModes stores the whole list).
const MODE_TRANSITION_FIELDS: readonly FieldDescriptor[] = [
  enm('blend', 'Camera blend', 'How the view moves to the mode\'s camera (absent: the camera\'s own blend).', MODE_BLENDS),
  num('blendTime', 'Blend time', 'Seconds of the camera blend (absent: the camera\'s own).', { min: 0, max: MODE_LIMITS.blendTimeMax, step: 0.05, unit: 's' }),
  ref('fade', 'Fade document', 'A UI document shown from the switch for the fade time — its show and hide tweens are the fade.', 'uiDocument'),
  num('fadeTime', 'Fade time', 'Seconds the fade document stays.', { min: MODE_LIMITS.fadeTimeMin, max: MODE_LIMITS.fadeTimeMax, step: 0.05, unit: 's', default: MODE_DEFAULTS.fadeTime }),
];
export const MODE_ITEM: FieldDescriptor = obj('*', 'Game mode', 'One game mode.', [
  str('modeId', 'Id', 'Scripts (ctx.modes.switch) and UI mode actions name it.', { required: true, format: 'id', minLength: 1, maxLength: 64 }),
  str('name', 'Name', 'Shown in the editor and the Play toolbar.', { required: true, minLength: 1, maxLength: MODE_LIMITS.nameLength }),
  list('inputMaps', 'Input maps', 'The input maps active in the mode (absent: every map). Actions of other maps read as released.', ref('*', 'Map', 'gameplay, ui or one of the project\'s maps.', 'inputMap'), { maxItems: MODE_LIMITS.inputMaps, unique: true }),
  entity('camera', 'Camera', 'A virtual camera that is live while the mode is, over the priorities (absent: the priority rule).', { component: 'virtualCamera', anyScene: true }),
  list('ui', 'UI documents', 'Shown while the mode is active, hidden when it ends.', ref('*', 'Document', 'A UI document.', 'uiDocument'), { maxItems: MODE_LIMITS.ui, unique: true }),
  list('groups', 'Ticking groups', 'The behavior groups whose scripts run (absent: every group). The other groups pause.', ref('*', 'Group', 'A behavior group.', 'behaviorGroup'), { maxItems: MODE_LIMITS.groups, unique: true }),
  enm('ungrouped', 'Ungrouped behaviors', 'Behaviors of objects without a behavior group.', MODE_UNGROUPED, { default: MODE_DEFAULTS.ungrouped }),
  bool('pause', 'Pause allowed', 'The engine pause (the pause key, a pause button) may be used in this mode.', { default: MODE_DEFAULTS.pause }),
  ref('pauseScreen', 'Pause screen', 'A UI document drawn while the game is paused in this mode (absent: the engine\'s pause panel).', 'uiDocument'),
  num('timeScale', 'Time scale', 'Simulation speed: fewer or more fixed steps per second (each step unchanged).', { min: MODE_LIMITS.timeScaleMin, max: MODE_LIMITS.timeScaleMax, step: 0.05, default: MODE_DEFAULTS.timeScale }),
  enm('physics', 'Physics', 'Physics, the character, movers and triggers step (run) or stand still (hold).', MODE_PHYSICS, { default: MODE_DEFAULTS.physics }),
  obj('enter', 'Transition in', 'How entering this mode looks (a script\'s switch may pass its own).', MODE_TRANSITION_FIELDS),
]);

/** One bone of the look-at chain: its name (picked from this object's model) and its turn limits. */
const LOOK_BONE = (key: string, label: string, tooltip: string, required: boolean) =>
  obj(key, label, tooltip, [
    str('bone', 'Bone', 'A bone (node) of this object\'s model (the list shows its nodes).', { required: true, ...NAME, format: 'ownBone' }),
    num('yaw', 'Yaw limit', 'How far it turns left or right.', { required: true, min: 0, max: LOOK_AT_LIMITS.yawMax, step: 5, unit: 'deg', default: 45 }),
    num('pitch', 'Pitch limit', 'How far it tilts up or down.', { required: true, min: 0, max: LOOK_AT_LIMITS.pitchMax, step: 5, unit: 'deg', default: 30 }),
  ], required ? { required: true } : {});

export const animator: ComponentDescriptor = {
  name: 'animator',
  label: 'Animator',
  tooltip: 'Plays the model\'s animations with an animator controller (a state machine).',
  category: 'Animation',
  value: obj('animator', 'Animator', 'The controller and this object\'s starting parameter values.', [
    ref('controller', 'Controller', 'The animator controller.', 'animator', { required: true }),
    map('parameters', 'Parameters', 'Starting values for the controller\'s parameters (absent: the controller\'s defaults).', 'Parameter', json('*', 'Value', 'A number or true/false.', { typedBy: 'animatorParameter' }), { keyRef: 'animatorParameter', maxEntries: MAX_ANIMATOR_PARAMETERS }),
    num('startTime', 'Start time', 'Where the entry states start, in normalized time (0–1 of their length).', { min: 0, max: 1, step: 0.05, when: when('randomStart', false) }),
    bool('randomStart', 'Random start', 'Start at a random time from the game\'s seeded random numbers (the project\'s random seed and this object\'s id), so copies do not move in step and a replay starts them alike.', { default: false }),
    obj('lookAt', 'Look at', 'Turns the head (and the neck and chest) toward a target after the clips pose them; scripts set the target and the weight (ctx.animator(id)?.setLookTarget / setLookWeight).', [
      LOOK_BONE('head', 'Head', 'The head bone: it ends facing the target (within the limits).', true),
      LOOK_BONE('neck', 'Neck', 'An optional neck bone that takes part of the turn.', false),
      LOOK_BONE('chest', 'Chest', 'An optional chest bone that takes part of the turn.', false),
      entity('target', 'Target', 'The object looked at (its origin; none: the point, or nothing).', { anyScene: true }),
      vec3('point', 'Point', 'A world position looked at when there is no target object.', { min: -LOOK_AT_LIMITS.pointMax, max: LOOK_AT_LIMITS.pointMax, step: 0.1, unit: 'm' }),
      num('weight', 'Weight', 'How much of the turn applies (0: the clip pose alone).', { min: 0, max: 1, step: 0.05, default: 1 }),
      ref('weightParameter', 'Weight parameter', 'A float parameter of the controller (0–1) the weight is multiplied by.', 'animatorParameter', { paramTypes: ['float'] }),
      num('turnSpeed', 'Turn speed', 'How fast the head turns to a new target and back.', { min: LOOK_AT_LIMITS.turnSpeedMin, max: LOOK_AT_LIMITS.turnSpeedMax, step: 10, unit: 'deg/s', default: LOOK_AT_LIMITS.turnSpeedDefault }),
    ]),
  ]),
  add: { kind: 'pick', value: {}, pick: ['controller'] },
  handles: [],
  requiresAnyOf: { components: ['model'], reason: 'an animator plays the object\'s model' },
  excludes: [],
  prefab: true,
};

export const mover: ComponentDescriptor = {
  name: 'mover',
  label: 'Mover',
  tooltip: 'Moves the object along waypoints (a moving platform, a door); with a collider it carries the player.',
  category: 'Gameplay',
  value: obj('mover', 'Mover', 'Waypoint movement.', [
    list('waypoints', 'Waypoints', '1–16 points, as offsets from where the object is placed (the start is not listed).', vec3('*', 'Point', 'An offset [x, y, z].', { min: -1000, max: 1000, step: 0.1, unit: 'm' }), { required: true, minItems: 1, maxItems: 16, handle: 'path', default: [[4, 0, 0]] }), // 4 m: a few character widths, visibly a trip
    num('speed', 'Speed', 'Travel speed.', { required: true, min: 0.01, max: 50, step: 0.1, unit: 'm/s', default: 2 }),
    enm('mode', 'Mode', 'Loop back to the start, go back and forth, or move once.', MOVER_MODES, { required: true, default: 'pingpong', labels: { pingpong: 'Back and forth' } }),
    num('wait', 'Wait', 'Pause at each point.', { min: 0, max: 60, step: 0.1, unit: 's', default: 0 }),
    // Gravity — constant acceleration from each point (the stretch takes as long as at its speed).
    enm('easing', 'Easing', 'Constant speed, smooth starts and stops, or gravity: from rest at each point, speeding up evenly until the next (each stretch takes as long as at its speed).', MOVER_EASINGS, { default: 'linear' }),
    signal('startOn', 'Start on signal', 'Wait for this signal before moving (absent: moves from the start).'),
    num('maxPush', 'Max push', 'The fastest it shoves a player out of its way (a safety limit that keeps the player out of the platform).', { ...BL.maxPush, step: 1, unit: 'm/s', default: BD.maxPush }),
    // A held mover stays where it is (it still collides and carries) until a script switches it on.
    bool('active', 'Moving', 'Off: it holds where it is (still solid) until a script, its start signal or its toggle signal moves it.', { default: true, omitDefault: true }),
    // More signals (seen one step after they are sent, like startOn).
    signal('stopOn', 'Stop on signal', 'This signal holds it where it is (still solid); its start or toggle signal moves it again.'),
    signal('toggleOn', 'Toggle on signal', 'This signal moves it if it is held, and holds it if it moves.'),
    signal('reverseOn', 'Reverse on signal', 'This signal turns it around, back the way it came (a finished once-mover goes back to its start).'),
  ], { rules: ['startOn, stopOn and toggleOn name different signals.'] }),
  // A new mover goes 4 m sideways and back at 2 m/s (a brisk walk), pausing 0.5 s at each end (reads as a stop, not a bounce).
  add: { kind: 'menu', value: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong', wait: 0.5 } },
  // Placeholder boxes against the engine's default 1.8 m character: a 2 m platform to stand on and a 3 m door
  // to walk through (it rises 3 m when "open" is sent — the switch's default signal); each with its box collider.
  create: [
    { label: 'Moving platform', menu: 'Gameplay', box: { size: [2, 0.4, 2], color: '#c9a36a' }, with: { collider: { shape: { type: 'box', hx: 1, hy: 0.2 } } }, dimension: 2 },
    { label: 'Moving platform', menu: 'Gameplay', box: { size: [2, 0.4, 2], color: '#c9a36a' }, with: { collider: { shape: { type: 'box', hx: 1, hy: 0.2, hz: 1 } } }, dimension: 3 },
    { label: 'Door (opens on "open")', name: 'Door', menu: 'Gameplay', box: { size: [0.6, 3, 2], color: '#7a5230' }, value: { waypoints: [[0, 3, 0]], speed: 3, mode: 'once', startOn: 'open' }, with: { collider: { shape: { type: 'box', hx: 0.3, hy: 1.5 } } }, dimension: 2 },
    { label: 'Door (opens on "open")', name: 'Door', menu: 'Gameplay', box: { size: [0.6, 3, 2], color: '#7a5230' }, value: { waypoints: [[0, 3, 0]], speed: 3, mode: 'once', startOn: 'open' }, with: { collider: { shape: { type: 'box', hx: 0.3, hy: 1.5, hz: 1 } } }, dimension: 3 },
  ],
  icon: 'mover',
  handles: [{ kind: 'path', label: 'Waypoints', bind: { points: 'waypoints' }, space: 'local', loop: when('mode', 'loop') }],
  excludes: [{ component: 'controller', reason: 'the player moves by input, not along waypoints' }, { component: 'socketAttach', reason: 'a socket poses the object every step; a mover follows its waypoints' }, { component: 'patrol', reason: 'a mover and a patrol would both move it' }, { component: 'gravity', reason: 'a mover sets its position itself' }],
  prefab: true,
};

export const trigger: ComponentDescriptor = {
  name: 'trigger',
  label: 'Trigger',
  tooltip: 'Sends a signal when the player enters an area (a box or a circle; in a 3D project a box with a depth, a sphere or a capsule).',
  category: 'Gameplay',
  value: obj('trigger', 'Trigger', 'An area that emits signals.', [
    enm('shape', 'Shape', 'Box or circle (2D plane); box, sphere or capsule (3D project).', TRIGGER_SHAPES, { default: 'box' }),
    // The depth (d) is the third component, needed in a 3D project (a 2D plane ignores it).
    vec3('size', 'Size', 'Width and height of the box (and its depth in a 3D project).', { required: true, when: when('shape', 'box'), min: 0.05, max: 500, step: 0.1, unit: 'm', default: [2, 2], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    num('radius', 'Radius', 'Radius of the circle or sphere.', { required: true, when: when('shape', 'circle', 'sphere'), min: TRIGGER_RADIUS.min, max: TRIGGER_RADIUS.max, step: 0.05, unit: 'm', default: 1, handle: 'radius' }),
    num('radius', 'Radius', 'Radius of the capsule.', { required: true, when: when('shape', 'capsule'), min: TRIGGER_RADIUS.min, max: TRIGGER_RADIUS.max, step: 0.05, unit: 'm', default: 0.5, handle: 'capsule' }),
    num('height', 'Height', 'The capsule\'s total height along the object\'s Y (end caps included; at least twice the radius).', { required: true, when: when('shape', 'capsule'), min: TRIGGER_HEIGHT.min, max: TRIGGER_HEIGHT.max, step: 0.05, unit: 'm', default: 2, handle: 'capsule' }),
    signal('signal', 'Signal', 'Sent when the player enters.', { required: true, default: 'trigger' }),
    signal('exitSignal', 'Exit signal', 'Sent when the player leaves (absent: none).'),
    enm('mode', 'Mode', 'Enter: once per entry. Stay: every step while inside.', TRIGGER_MODES, { default: 'enter' }),
    bool('once', 'Once', 'Only the first time.', { default: false }),
    // The generic scene exit — a trigger that moves the character to another scene.
    obj('sceneTransition', 'Scene transition', 'Entering loads a scene and moves the character to a spawn in it (absent: no transition).', [
      scene('scene', 'Load scene', 'The scene loaded when the character enters.', { required: true }),
      entity('spawn', 'Arrive at', 'The player spawn the character is moved to once the scene is loaded (in that scene or this one; absent: it stays where it is).', { component: 'playerSpawn', anyScene: true }),
      list('unload', 'Unload scenes', 'Scenes unloaded once the loaded scene is in (they stay in view until then).', scene('*', 'Scene', 'A scene to unload.'), { maxItems: MAX_TRANSITION_UNLOADS, unique: true }),
      // An optional fade over the swap.
      num('fade', 'Fade', 'Seconds the view fades out before the swap and back in after it (absent or 0: no fade; the old scene stays in view until the new one is drawn).', { min: 0, max: MAX_TRANSITION_FADE, step: 0.05 }),
      color('fadeColor', 'Fade colour', 'The colour the view fades to (absent: black).'),
    ]),
  ]),
  // A 2 m square (the default 1.8 m character fits inside) sending the neutral signal name "trigger".
  add: { kind: 'menu', value: { size: [2, 2], signal: 'trigger' } },
  // 3D projects (a 2D plane keeps the single entry above): a 2 m cube, a 1 m sphere and a 2 m capsule — the default 1.8 m character fits in each.
  presets: [
    { label: 'Box (3D)', value: { size: [2, 2, 2], signal: 'trigger' }, dimension: 3 },
    { label: 'Sphere', value: { shape: 'sphere', radius: 1, signal: 'trigger' }, dimension: 3 },
    { label: 'Capsule', value: { shape: 'capsule', radius: 0.5, height: 2, signal: 'trigger' }, dimension: 3 },
  ],
  // An area, and an area that moves the character to another scene (its first spawn picked in the Inspector).
  create: [
    { label: 'Trigger', menu: 'Gameplay', dimension: 2 },
    { label: 'Trigger', menu: 'Gameplay', value: { size: [2, 2, 2], signal: 'trigger' }, dimension: 3 },
    { label: 'Scene transition', menu: 'Gameplay', value: { size: [2, 2], signal: 'transition', sceneTransition: { scene: '' } }, otherScene: ['sceneTransition/scene'], dimension: 2 },
    { label: 'Scene transition', menu: 'Gameplay', value: { size: [2, 2, 2], signal: 'transition', sceneTransition: { scene: '' } }, otherScene: ['sceneTransition/scene'], dimension: 3 },
  ],
  icon: 'sensor',
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', when: when('shape', 'box') },
    { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'circle') },
    // The 3D areas turn with the object (its own rotation; a trigger ignores scale).
    { kind: 'radius', label: 'Sphere radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'sphere'), follows: 'rotation' },
    { kind: 'capsule', label: 'Capsule', bind: { radius: 'radius', height: 'height' }, space: 'local', when: when('shape', 'capsule'), follows: 'rotation' },
  ],
  excludes: [],
  prefab: true,
};

export const switchC: ComponentDescriptor = {
  name: 'switch',
  label: 'Switch',
  tooltip: 'A lever or button (interact) or a pressure plate (stand) that sends a signal.',
  category: 'Gameplay',
  value: obj('switch', 'Switch', 'A switch.', [
    enm('mode', 'Mode', 'Interact: press its action nearby. Stand: step on it.', SWITCH_MODES, { required: true, default: 'interact' }),
    signal('signal', 'Signal', 'Sent when used.', { required: true, default: 'open' }),
    vec2('size', 'Size', 'The area the player must be in.', { required: true, min: 0.05, max: 100, step: 0.1, unit: 'm', default: [1, 1], labels: ['w', 'h'], handle: 'box2' }),
    bool('once', 'Once', 'Only the first time.', { default: false }),
    // The input action that works an interact switch (absent: interact).
    str('action', 'Action', 'The input action pressed nearby to use it.', { ...ACTION_NAME, when: when('mode', 'interact'), default: SWITCH_DEFAULT_ACTION }),
  ]),
  // A 1 m square pressed with the interact action, sending "open" (the door preset waits for it).
  add: { kind: 'menu', value: { mode: 'interact', signal: 'open', size: [1, 1] } },
  // A 0.6 m pad (2D plane only: a 3D project refuses switches).
  create: [{ label: 'Switch', menu: 'Gameplay', box: { size: [0.6, 0.2, 0.6], color: '#d9534f' }, dimension: 2 }],
  icon: 'switch',
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: true,
};

export const health: ComponentDescriptor = {
  name: 'health',
  label: 'Health',
  // Any object's health; scripts take and give it (ctx.health) and read its damaged/died events.
  tooltip: 'The object\'s health (any object): scripts damage and heal it and hear when it is damaged or reaches 0; a hitbox with damage takes some on contact.',
  category: 'Gameplay',
  value: obj('health', 'Health', 'Health.', [
    int('max', 'Maximum', 'The most health it can have.', { required: true, min: 1, max: 1000, default: 3 }),
    int('start', 'Start', 'Health at the start of a run (absent: the maximum).', { min: 1, max: 1000 }),
  ], { rules: ['start ≤ max'] }),
  // 3 hits (the common small health pool).
  add: { kind: 'menu', value: { max: 3 } },
  // A 1 m box that can be damaged (scripts or a hitbox with damage take its health).
  create: [{ label: 'Object with health', menu: 'Gameplay', box: { size: [1, 1, 1], color: '#b0b7c3' }, value: { max: 3 } }],
  icon: 'health',
  handles: [],
  excludes: [],
  prefab: true,
};

// ---- Generic primitives -------------------------------------------------

const PD = PRIMITIVE_DEFAULTS;
const PL = PRIMITIVE_LIMITS;

export const collectible: ComponentDescriptor = {
  name: 'collectible',
  label: 'Collectible',
  tooltip: 'The character touching it adds an amount to a named counter; it hides, sends a signal and may come back after a while.',
  category: 'Gameplay',
  value: obj('collectible', 'Collectible', 'Adds to a counter when touched.', [
    str('counter', 'Counter', 'The counter it adds to (any name: a letter or _, then letters, digits or _).', { required: true, format: 'counter', minLength: 1, maxLength: 32, default: 'items' }),
    num('amount', 'Amount', 'Added to the counter when collected (negative takes away).', { ...PL.amount, step: 1, default: PD.collectibleAmount }),
    // Its depth (d) counts in a 3D project (absent: the width); a 2D plane ignores it.
    vec3('size', 'Size', 'The area that collects it: width, height (and depth in a 3D project; absent: the width).', { min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [...PD.collectibleSize], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    signal('onCollect', 'On collect', 'A signal sent when it is collected (absent: none).'),
    num('respawn', 'Comes back after', 'Seconds until it comes back after being collected (0: never).', { ...PL.respawn, step: 0.5, unit: 's', default: 0 }),
  ]),
  // A neutral counter name; one of something over the default 1 m area.
  add: { kind: 'menu', value: { counter: 'items' } },
  // A 0.4 m token (small enough to read as an item next to the default 1.8 m character).
  create: [{ label: 'Collectible', menu: 'Gameplay', box: { size: [0.4, 0.4, 0.4], color: '#f2c230' } }],
  icon: 'collectible',
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [{ component: 'controller', reason: 'the character collects; it is not collected' }],
  prefab: true,
};

export const patrol: ComponentDescriptor = {
  name: 'patrol',
  label: 'Patrol',
  tooltip: 'Walks by itself: along waypoints, or straight ahead turning around at walls and ledges.',
  category: 'Gameplay',
  value: obj('patrol', 'Patrol', 'Walks by itself.', [
    enm('mode', 'Mode', 'Waypoints: along points placed from where it starts. Edges: straight ahead, turning at a wall or a ledge.', PATROL_MODES, { required: true, default: 'edges', labels: { waypoints: 'Waypoints', edges: 'Edge to edge' } }),
    list('waypoints', 'Waypoints', '1–16 points, as offsets from where the object is placed (the start is not listed).', vec3('*', 'Point', 'An offset [x, y, z].', { min: -1000, max: 1000, step: 0.1, unit: 'm' }), { required: true, when: when('mode', 'waypoints'), minItems: 1, maxItems: 16, handle: 'path', default: [[4, 0, 0]] }),
    bool('loop', 'Loop', 'From the last point straight back to the start (off: back and forth).', { when: when('mode', 'waypoints'), default: false }),
    num('speed', 'Speed', 'Walking speed.', { required: true, ...PL.speed, step: 0.1, unit: 'm/s', default: 1.5 }),
    num('wait', 'Wait', 'Pause at each waypoint, or after turning around.', { ...PL.wait, step: 0.1, unit: 's', default: 0 }),
    vec3('direction', 'Start direction', 'The way it starts walking (the 2D plane: any direction in the plane — with a y part it moves up or down and does not look for ledges; a 3D project: the direction along the ground).', { when: when('mode', 'edges'), min: -1, max: 1, step: 0.1, default: [...PD.patrolDirection], nonZero: true, handle: 'direction' }),
    vec3('size', 'Body', 'Its body, centred on its position: width, height (and depth in 3D); the probes look from its front and underside.', { when: when('mode', 'edges'), min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [...PD.patrolSize], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    num('wallProbe', 'Wall probe', 'How far past its front it looks for a wall to turn at.', { group: 'Probes', when: when('mode', 'edges'), ...PL.wallProbe, step: 0.01, unit: 'm', default: PD.wallProbe }),
    num('ledgeProbe', 'Ledge probe', 'How far down, from 0.1 m above its underside, it looks for floor just past its front (0.4: a drop deeper than 0.3 m is a ledge).', { group: 'Probes', when: when('mode', 'edges'), ...PL.ledgeProbe, step: 0.05, unit: 'm', default: PD.ledgeProbe }),
  ]),
  // 1.5 m/s: an unhurried walk; edge to edge needs no further setup.
  add: { kind: 'menu', value: { mode: 'edges', speed: 1.5 } },
  // A 0.8 m body walking edge to edge.
  create: [{ label: 'Patrolling object', menu: 'Gameplay', box: { size: [0.8, 0.8, 0.8], color: '#8e3fb0' } }],
  icon: 'patrol',
  presets: [
    { label: 'Edge to edge', value: { mode: 'edges', speed: 1.5 } },
    { label: 'Waypoints', value: { mode: 'waypoints', waypoints: [[4, 0, 0]], speed: 1.5 } },
  ],
  handles: [
    { kind: 'path', label: 'Waypoints', bind: { points: 'waypoints' }, space: 'local', when: when('mode', 'waypoints'), loop: when('loop', true) },
    { kind: 'box2', label: 'Body', bind: { size: 'size' }, space: 'local', when: when('mode', 'edges') },
    { kind: 'direction', label: 'Start direction', bind: { direction: 'direction' }, space: 'local', when: when('mode', 'edges') },
  ],
  excludes: [
    { component: 'controller', reason: 'the character moves by input, not by itself' },
    { component: 'mover', reason: 'a mover and a patrol would both move it' },
    { component: 'collider', reason: 'a patroller is not a physics body (give it a hitbox)' },
  ],
  prefab: true,
};

// ---- Climb volumes and gravity bodies --------------------------------

export const climbVolume: ComponentDescriptor = {
  name: 'climbVolume',
  label: 'Climb volume',
  tooltip: 'A box the character climbs in (a ladder, a vine, a net, a climbing wall): up/down moves it along the box\'s up axis, sideways across it, at its climb speed and without gravity; jump or moving out leaves.',
  category: 'Gameplay',
  value: obj('climbVolume', 'Climb volume', 'Climbed in.', [
    // Its depth (d) counts in a 3D project (absent: the width); a 2D plane ignores it. It turns with the object (its +Y is "up").
    vec3('size', 'Size', 'Width, height (and depth in a 3D project; absent: the width), centred on the object and turned with it.', { required: true, min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [1, 4], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
  ]),
  // 1 m wide and 4 m tall: a ladder up one storey (about 3 m) and a little over the top, for the default 1.8 m character.
  add: { kind: 'menu', value: { size: [1, 4] } },
  create: [
    { label: 'Climb volume', menu: 'Gameplay', dimension: 2 },
    { label: 'Climb volume', menu: 'Gameplay', value: { size: [1, 4, 1] }, dimension: 3 },
  ],
  icon: 'sensor',
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'rotation' }],
  excludes: [{ component: 'controller', reason: 'the character climbs in a climb volume; it is not one' }],
  prefab: true,
};

export const gravityC: ComponentDescriptor = {
  name: 'gravity',
  label: 'Gravity',
  tooltip: 'The object (not a character: a patroller, an item) falls under the project\'s gravity until its body rests on a collider below it, and falls again when the floor goes.',
  category: 'Gameplay',
  value: obj('gravity', 'Gravity', 'Falls onto colliders.', [
    num('scale', 'Scale', 'Multiplies the project gravity (0: it does not fall).', { ...GRAVITY_SCALE, step: 0.1, unit: '×', default: 1 }),
    vec3('size', 'Body', 'Its body, centred on its position: width, height (and depth in 3D); its underside rests on the floor.', { min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [...PD.patrolSize], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
  ]),
  // The project's gravity on a 1 m body (a patroller's default body).
  add: { kind: 'menu', value: {} },
  handles: [{ kind: 'box2', label: 'Body', bind: { size: 'size' }, space: 'local' }],
  excludes: [
    { component: 'controller', reason: 'the character falls under its own controller' },
    { component: 'mover', reason: 'a mover sets its position itself' },
    { component: 'collider', reason: 'a gravity body is not a physics body (give it a hitbox)' },
  ],
  prefab: true,
};

export const hitbox: ComponentDescriptor = {
  name: 'hitbox',
  label: 'Hitbox',
  tooltip: 'An area whose contacts with other hitboxes and the character are events for scripts (the other object and the contact normal); may take health on contact.',
  category: 'Gameplay',
  value: obj('hitbox', 'Hitbox', 'Contact events.', [
    enm('shape', 'Shape', 'A box, or a sphere (a circle on the 2D plane).', HITBOX_SHAPES, { default: 'box' }),
    vec3('size', 'Size', 'Width, height (and depth in a 3D project; absent: the width).', { required: true, when: when('shape', 'box'), min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [1, 1], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    num('radius', 'Radius', 'Radius of the sphere (or circle).', { required: true, when: when('shape', 'sphere'), ...PL.radius, step: 0.05, unit: 'm', default: 0.5, handle: 'radius' }),
    int('damage', 'Damage', 'Health a new contact takes from the other object (its own health, or its nearest parent\'s; 0: none).', { ...PL.damage, default: 0 }),
  ]),
  // A 1 m box: about a person-sized object's reach.
  add: { kind: 'menu', value: { size: [1, 1] } },
  create: [
    { label: 'Hitbox', menu: 'Gameplay', dimension: 2 },
    { label: 'Hitbox', menu: 'Gameplay', value: { size: [1, 1, 1] }, dimension: 3 },
  ],
  icon: 'hitbox',
  // The 2D plane's box has no depth; a 3D box a 1 m depth; a sphere (a circle on the 2D plane) fits both.
  presets: [
    { label: 'Box', value: { size: [1, 1] }, dimension: 2 },
    { label: 'Box', value: { size: [1, 1, 1] }, dimension: 3 },
    { label: 'Sphere', value: { shape: 'sphere', radius: 0.5 } },
  ],
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', when: when('shape', 'box') },
    { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'sphere') },
  ],
  excludes: [],
  prefab: true,
};

export const audioSource: ComponentDescriptor = {
  name: 'audioSource',
  label: 'Audio source',
  tooltip: 'A looping sound here, louder as the player comes near (along X), or panned around the camera (the project\'s Audio sources setting; 3D projects).',
  category: 'Audio',
  value: obj('audioSource', 'Audio source', 'A positional loop.', [
    asset('assetId', 'Sound', 'An audio asset (any length: short sounds, music, ambience).', ['audio'], { required: true }),
    num('volume', 'Volume', 'Volume at full strength.', { required: true, min: 0, max: 1, step: 0.05, default: 0.8 }),
    num('range', 'Range', 'Heard within this distance (full volume within a quarter of it). Panned: its max distance.', { required: true, min: 0.5, max: 500, step: 0.5, unit: 'm', default: 12, handle: 'radius' }),
    // The panner model's distance fade (the project's Audio sources setting; 3D projects by default).
    enm('distanceModel', 'Distance model', 'Panned: how the volume falls with distance — linear (silent at the range), inverse or exponential (natural falloff, quieter but never silent within the range).', ['linear', 'inverse', 'exponential'], { default: 'linear', group: 'Panned' }),
    num('refDistance', 'Full volume within', 'Panned: full volume within this distance (absent: a quarter of the range).', { min: 0.01, max: 500, step: 0.25, unit: 'm', default: 3, group: 'Panned' }),
    num('rolloff', 'Rolloff', 'Panned: how fast the volume falls (1: the model\'s natural rate).', { min: 0, max: 10, step: 0.1, default: 1, group: 'Panned' }),
  ]),
  // 0.8 volume (headroom under the effects) heard within 12 m (about a screen width at the default camera).
  add: { kind: 'pick', value: { volume: 0.8, range: 12 }, pick: ['assetId'] },
  icon: 'audio',
  handles: [{ kind: 'radius', label: 'Range', bind: { radius: 'range' }, space: 'local', along: 'x' }],
  excludes: [],
  prefab: true,
};

export const faceMovement: ComponentDescriptor = {
  name: 'faceMovement',
  label: 'Face movement',
  tooltip: 'Turns this model to face where its parent (or, at the top, itself) is going: to one of two yaws by the side it moves to, or toward its motion in any direction.',
  category: 'Animation',
  value: obj('faceMovement', 'Face movement', 'Yaw from the motion.', [
    // `velocity` faces the horizontal motion in any direction (3D too); `sides` (absent) picks one of two yaws by the sign of X.
    enm('mode', 'Mode', 'Sides: one yaw moving right, another moving left. Velocity: faces the way it moves, in any direction.', FACE_MOVEMENT_MODES, { default: 'sides', omitDefault: true, labels: { sides: 'Two sides', velocity: 'Face velocity' } }),
    num('yawRight', 'Yaw moving right', 'Rotation about +Y while the parent moves right.', { required: true, when: when('mode', 'sides'), min: -360, max: 360, step: 5, unit: 'deg', default: 90 }),
    num('yawLeft', 'Yaw moving left', 'Rotation about +Y while the parent moves left.', { required: true, when: when('mode', 'sides'), min: -360, max: 360, step: 5, unit: 'deg', default: -90 }),
    num('yawOffset', 'Yaw offset', 'Added to the motion\'s yaw (0: the model is authored facing +Z).', { when: when('mode', 'velocity'), min: -360, max: 360, step: 5, unit: 'deg', default: 0 }),
    num('turnSeconds', 'Turn time', 'Time to turn around (a half turn).', { min: 0, max: 5, step: 0.01, unit: 's', default: 0.12 }),
  ]),
  // A model authored facing +Z turns ±90° to face +X / −X, turning around in 0.12 s (quick, still visible).
  add: { kind: 'menu', value: { yawRight: 90, yawLeft: -90, turnSeconds: 0.12 } },
  presets: [
    { label: 'Two sides', value: { yawRight: 90, yawLeft: -90, turnSeconds: 0.12 } },
    // A model authored facing +Z faces its motion (a 3D walker, a top-down character).
    { label: 'Face velocity', value: { mode: 'velocity', turnSeconds: 0.12 } },
  ],
  handles: [],
  excludes: [],
  prefab: true,
};

// ---- the entity's own fields ------------------------------------------------------

export const ENTITY: ObjectFieldDescriptor = obj('entity', 'Object', 'An object in a scene.', [
  str('id', 'Id', 'The stable object id.', { ...ID, required: true, readOnly: true }),
  str('name', 'Name', 'The name shown in the Hierarchy.', NAME),
  entity('parentId', 'Parent', 'The parent object (none: a scene root).', { nullable: true, default: null }),
  bool('active', 'Active', 'Inactive objects are not in the game (an object a script switches off stays loaded but is not drawn, collides with nothing, fires no trigger and does not tick).', { default: true, omitDefault: true }),
  // The stored value is how the object starts; scripts, timelines and collectibles show and hide it while the game runs.
  bool('visible', 'Visible', 'Drawn (with its children, their lights and effects). Off: the object starts hidden until a script or a timeline shows it; it still collides, triggers and ticks while hidden.', { default: true, omitDefault: true }),
  bool('locked', 'Locked', 'Cannot be selected in the Scene view.', { default: false, omitDefault: true }),
  bool('static', 'Static', 'Never moves (baked lighting, cheaper rendering).', { default: false, omitDefault: true }),
  bool('keepLoaded', 'Keep loaded', 'Survives scene changes (with its children and scripts): loading, unloading or reloading its scene, or loading a save, never destroys it. On a root object (or one in folders).', { default: false, omitDefault: true }),
  int('tags', 'Tags', 'The tag bits (a 32-bit mask of the project\'s tags).', { min: 0, max: 0xffffffff, default: 0, omitDefault: true }),
  { type: 'components', key: 'components', label: 'Components', tooltip: 'What the object is and does.', required: true, allowed: [] },
]);
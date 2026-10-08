/**
 * The descriptor of the `spline` component (its own file, beside its
 * format). The registry (`descriptors.ts`) lists it with every other
 * component.
 *
 * Pure data.
 */
import { asset, bool, enm, int, json, list, num, obj, str, vec2, vec3, when, NAME } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import {
  SPLINE_FALLOFF_DEFAULT,
  SPLINE_LIMITS,
  SPLINE_MESH_KINDS,
  SPLINE_MESH_STEP_DEFAULT,
  SPLINE_SCATTER_MARGIN_DEFAULT,
  SPLINE_SURFACE_OFFSET_DEFAULT,
  SPLINE_TERRAIN_SHAPES,
  SPLINE_WATER_FLOW_DEFAULT,
  SPLINE_WATER_FOAM_DEFAULT,
  SPLINE_WIDTH_DEFAULT,
} from './spline';

const L = SPLINE_LIMITS;
const D = L.distanceMax;

// A new spline is a 40 m run along x: long enough to see a road's carve and paint, short enough to place by hand.
const POINTS_NEW = [{ at: [0, 0, 0] }, { at: [20, 0, 0] }, { at: [40, 0, 0] }];

export const spline: ComponentDescriptor = {
  name: 'spline',
  label: 'Spline',
  tooltip: 'A curve through points, each with its own width and roll: roads, paths and rivers carved and painted into terrain, meshes and models along it, and a path scripts read (ctx.splines).',
  category: 'Rendering',
  value: obj('spline', 'Spline', "A curve through points, as offsets from the object's position (its rotation and scale are not applied).", [
    list('points', 'Points', `${L.minPoints}-${L.maxPoints} points the curve passes through, in order.`, obj('*', 'Point', 'One point of the curve.', [
      vec3('at', 'At', 'Metres from the object.', { required: true, min: -L.coordinate, max: L.coordinate, step: 0.1, unit: 'm' }),
      vec3('tangent', 'Tangent', 'Direction and pull here (empty: smooth).', { min: -L.coordinate, max: L.coordinate, step: 0.1, unit: 'm' }),
      num('width', 'Width', 'Metres across here (empty: the spline\'s width).', { min: 0, max: L.widthMax, step: 0.1, unit: 'm' }),
      num('roll', 'Roll', 'Degrees the cross-section turns here, right side up.', { min: -L.rollMax, max: L.rollMax, step: 1, unit: 'deg' }),
    ]), { required: true, minItems: L.minPoints, maxItems: L.maxPoints, handle: 'spline', default: POINTS_NEW }),
    bool('closed', 'Closed', 'The curve runs back from the last point to the first (3 points or more).', { default: false, omitDefault: true }),
    num('width', 'Width', 'Metres across where a point names none.', { min: 0, max: L.widthMax, step: 0.1, unit: 'm', default: SPLINE_WIDTH_DEFAULT }),
    obj('terrain', 'Terrain', 'Shape and paint the terrains it crosses (never a block layer: it stops at its cells).', [
      enm('shape', 'Shape', 'Flatten the ground to it, only lower, only raise, or only paint.', SPLINE_TERRAIN_SHAPES, { default: 'flatten', labels: { none: 'Paint only' } }),
      num('falloff', 'Falloff', 'Metres past the half width the change fades over.', { min: 0, max: D, step: 0.5, unit: 'm', default: SPLINE_FALLOFF_DEFAULT }),
      num('depth', 'Depth', 'Metres the centre is cut below the points, shallowing to the edges (a channel).', { min: 0, max: D, step: 0.1, unit: 'm', default: 0 }),
      num('offset', 'Offset', 'Metres the whole width lies below the points (a road\'s bed).', { min: 0, max: D, step: 0.05, unit: 'm', default: 0 }),
      obj('paint', 'Paint', 'A layer painted along it, over the rules, under hand paint.', [
        int('layer', 'Layer', 'The material layer painted.', { required: true, min: 0, max: 255, default: 1 }),
        num('strength', 'Strength', 'How much of the layer at the centre (0-1].', { min: 0.01, max: 1, step: 0.05, default: 1 }),
        num('width', 'Width', 'Metres painted fully (empty: the width).', { min: 0, max: L.widthMax, step: 0.1, unit: 'm' }),
        num('falloff', 'Falloff', 'Metres it fades over (empty: the terrain falloff).', { min: 0, max: D, step: 0.5, unit: 'm' }),
      ]),
      int('order', 'Order', 'Where splines cross, the higher order wins.', { min: -1_000_000, max: 1_000_000, default: 0 }),
    ]),
    obj('scatter', 'Keep clear of scatter', 'No scatter rule places a copy within the band.', [
      num('margin', 'Margin', 'Metres past the half width kept clear.', { min: 0, max: D, step: 0.5, unit: 'm', default: SPLINE_SCATTER_MARGIN_DEFAULT }),
      list('rules', 'Rules', 'Only these scatter rules (empty: all).', str('*', 'Rule', 'A scatter rule id.', { minLength: 1, maxLength: 32 })),
    ]),
    obj('mesh', 'Mesh', 'A mesh along it with levels of detail: a profile swept along, or a river\'s water. It wears Materials slot "spline" (or "*").', [
      enm('kind', 'Kind', 'A swept profile, or water with flow and foam.', SPLINE_MESH_KINDS, { default: 'surface', labels: { surface: 'Surface', water: 'Water' } }),
      json('profile', 'Profile', `The cross-section, left to right: [[across, up], …], across in half widths (-1 to 1), up in metres; 2-${L.profilePoints} points (empty: flat).`),
      num('offset', 'Offset', `Metres above the points (empty: ${SPLINE_SURFACE_OFFSET_DEFAULT} for a surface, 0 for water).`, { min: -D, max: D, step: 0.01, unit: 'm' }),
      num('tiling', 'Tiling', 'Metres along one texture repeat covers (empty: the width).', { min: 0.01, max: D, step: 0.5, unit: 'm' }),
      num('step', 'Step', 'Metres between cross-sections.', { min: 0.05, max: 100, step: 0.05, unit: 'm', default: SPLINE_MESH_STEP_DEFAULT }),
      bool('collision', 'Collision', 'Colliders from the mesh (empty: a surface yes, water no).'),
      bool('castShadow', 'Casts shadows', 'Blocks the directional light.', { default: true }),
      bool('receiveShadow', 'Receives shadows', 'Shows the shadows falling on it.', { default: true }),
      num('flow', 'Flow', 'Water: its speed along the curve.', { min: 0, max: 100, step: 0.1, unit: 'm/s', default: SPLINE_WATER_FLOW_DEFAULT, when: when('kind', 'water') }),
      num('foam', 'Foam', 'Water: metres the foam reaches in from the banks.', { min: 0, max: L.widthMax, step: 0.1, unit: 'm', default: SPLINE_WATER_FOAM_DEFAULT, when: when('kind', 'water') }),
    ]),
    list('pieces', 'Pieces', `Models repeated along it (fences, posts, walls), at most ${L.pieces} kinds.`, obj('*', 'Piece', 'A model repeated along the curve.', [
      obj('asset', 'Asset', 'The model repeated.', [
        asset('assetId', 'Model', 'The model file.', ['model'], { required: true }),
        str('piece', 'Piece', 'A named piece of the file (empty: all of it).', NAME),
      ], { required: true }),
      num('spacing', 'Spacing', 'Metres between pieces along the curve.', { required: true, min: 0.05, max: D, step: 0.1, unit: 'm', default: 2 }),
      num('start', 'Start', 'Metres to the first piece.', { min: 0, max: L.coordinate, step: 0.1, unit: 'm', default: 0 }),
      vec2('offset', 'Offset', '[across, up] metres from the curve.', { min: -D, max: D, step: 0.05, unit: 'm', labels: ['across', 'up'] }),
      num('yaw', 'Turn', 'Degrees each piece turns about up.', { min: -360, max: 360, step: 1, unit: 'deg', default: 0 }),
      bool('upright', 'Upright', 'Upright (off: they lean with slope and roll).', { default: true }),
      bool('collide', 'Collides', 'Pieces carry their model\'s _COL colliders.', { default: true }),
      bool('castShadow', 'Casts shadows', 'Blocks the directional light.', { default: true }),
    ]), { maxItems: L.pieces }),
    str('data', 'Made', 'SHA-256 of the mesh and pieces made from it (written by the host).', { format: 'sha256', minLength: 64, maxLength: 64, readOnly: true }),
  ]),
  add: { kind: 'menu', value: { points: POINTS_NEW } },
  create: [
    { label: 'Spline', menu: 'Level', value: { points: POINTS_NEW }, dimension: 3 },
    // A two-lane road: flattened 0.1 m under its surface mesh, its verges painted layer 1, scatter kept 1 m clear.
    { label: 'Road', menu: 'Level', value: { points: POINTS_NEW, width: 8, terrain: { offset: 0.1, falloff: 6, paint: { layer: 1, falloff: 2 } }, scatter: {}, mesh: { tiling: 8 } }, dimension: 3 },
    // A river: a channel carved 2 m deep at its centre, water 0.3 m below its banks (they meet near the edges).
    { label: 'River', menu: 'Level', value: { points: POINTS_NEW, width: 10, terrain: { shape: 'carve', depth: 2, falloff: 6 }, scatter: { margin: 2 }, mesh: { kind: 'water', offset: -0.3 } }, dimension: 3 },
  ],
  handles: [{ kind: 'spline', label: 'Spline', bind: { points: 'points' }, space: 'local', loop: when('closed', true) }],
  excludes: ['blockLayer', 'terrain'].map((c) => ({ component: c, reason: 'a spline is its own object beside the level geometry it shapes' })),
  prefab: false,
};

/**
 * Phase 18.1: the material node catalogue (graph-kind data).
 *
 * Two graph kinds share one generic catalogue (never fitted to a demo):
 *
 * - `material`: a material's own graph (owner kind `material`, stored in
 *   `content.materials[].graph`) — inputs, exposed parameters, maths,
 *   vectors, textures, noise, utility, sub-graph calls and the outputs (PBR
 *   or Unlit surface, vertex offset, with the render flags as fields);
 * - `material-function`: a reusable sub-graph stored as its own content
 *   record (a standalone graph document, `content.graphs[]` with this kind):
 *   the same nodes minus the parameters and the outputs, plus Function input
 *   and Function output nodes that become the ports of every call.
 *
 * Port types are the four value widths and a texture reference. Every value
 * width converts to every other implicitly (a float splats to all
 * components, a wider vector keeps its leading components, a narrower one is
 * padded with 0 and w = 1), so any value wire connects; a texture feeds only
 * texture inputs. Maths nodes carry a `type` field that is `auto` by
 * default: their ports take the widest type among the wires into them (a
 * vec3 times a float is a vec3), or a fixed width when chosen.
 *
 * Every input has a default (a constant or a built-in source such as the
 * mesh's first UV set), so an unconnected input is always defined — the
 * rule "every output connected or defaulted" holds by construction; the
 * graph compiles to three.js TSL (three-adapter `material-graph.ts`, phase
 * 18.3; `default` strings name its built-in sources).
 */
import type { GraphFieldDef, GraphKindDef, GraphNodeDef, GraphPortDef, GraphValue } from './graph';

/** The value types in widening order (the `auto` rule picks the widest connected). */
export const MATERIAL_VALUE_TYPES = ['float', 'vec2', 'vec3', 'vec4'] as const;
/** The types an exposed material parameter may have (`color` is a vec3 edited as a colour). */
export const MATERIAL_PARAMETER_TYPES = ['float', 'vec2', 'vec3', 'vec4', 'color', 'texture'] as const;
export type MaterialParameterType = (typeof MATERIAL_PARAMETER_TYPES)[number];

/**
 * The built-in sources an unconnected input may default to (a port's
 * `default` string): the mesh's UV sets, positions and normals in world or
 * object space, the view direction, the screen position and the time.
 */
export const MATERIAL_BUILTIN_SOURCES = ['uv0', 'uv1', 'positionWorld', 'positionObject', 'normalWorld', 'normalObject', 'viewDirWorld', 'viewDirTangent', 'screenUV', 'time'] as const;

const TYPE_FIELD: GraphFieldDef = { key: 'type', label: 'Type', type: 'enum', options: ['auto', ...MATERIAL_VALUE_TYPES], default: 'auto' };
/** A texture asset (the id syntax of every asset; "" = none). */
const TEXTURE_FIELD: GraphFieldDef = { key: 'texture', label: 'Texture', type: 'string', default: '', maxLength: 64, pattern: '[a-z0-9][a-z0-9_-]{0,63}', asset: 'texture' };
const SPACE_FIELD = (options: readonly string[], d: string): GraphFieldDef => ({ key: 'space', label: 'Space', type: 'enum', options, default: d });
/** A parameter or interface name: an identifier (it becomes a label and a code name). */
const NAME_PATTERN = '[A-Za-z_][A-Za-z0-9_]{0,31}';

const port = (id: string, label: string, type: string, d?: GraphValue): GraphPortDef => ({ id, label, type, ...(d !== undefined ? { default: d } : {}) });
/** A port whose width follows the node's `type` field (auto: the widest wire in). */
const dyn = (id: string, label: string, d?: GraphValue): GraphPortDef => ({ id, label, type: 'float', typeFrom: { field: 'type' }, ...(d !== undefined ? { default: d } : {}) });

const unary = (type: string, label: string, description: string, d: GraphValue = 0): GraphNodeDef => ({
  type,
  label,
  category: 'Maths',
  description,
  inputs: [dyn('in', 'in', d)],
  outputs: [dyn('out', 'out')],
  fields: [TYPE_FIELD],
});
const binary = (type: string, label: string, description: string, a: GraphValue = 0, b: GraphValue = 0): GraphNodeDef => ({
  type,
  label,
  category: 'Maths',
  description,
  inputs: [dyn('a', 'a', a), dyn('b', 'b', b)],
  outputs: [dyn('out', 'out')],
  fields: [TYPE_FIELD],
});

/** Render flags of a surface output (fields). */
const SURFACE_FLAGS: readonly GraphFieldDef[] = [
  { key: 'doubleSided', label: 'Double-sided', type: 'boolean', default: false },
  { key: 'transparent', label: 'Transparent', type: 'boolean', default: false },
  { key: 'castShadows', label: 'Casts shadows', type: 'boolean', default: true },
];

const INPUT_NODES: readonly GraphNodeDef[] = [
  { type: 'float', label: 'Float', category: 'Inputs', description: 'A constant number.', inputs: [], outputs: [port('value', 'value', 'float')], fields: [{ key: 'value', label: 'Value', type: 'number', default: 0, min: -1e6, max: 1e6 }] },
  { type: 'vec2', label: 'Vector 2', category: 'Inputs', description: 'A constant two-component vector.', inputs: [], outputs: [port('value', 'value', 'vec2')], fields: [{ key: 'value', label: 'Value', type: 'vector', size: 2, default: [0, 0], min: -1e6, max: 1e6 }] },
  { type: 'vec3', label: 'Vector 3', category: 'Inputs', description: 'A constant three-component vector.', inputs: [], outputs: [port('value', 'value', 'vec3')], fields: [{ key: 'value', label: 'Value', type: 'vector', size: 3, default: [0, 0, 0], min: -1e6, max: 1e6 }] },
  { type: 'vec4', label: 'Vector 4', category: 'Inputs', description: 'A constant four-component vector.', inputs: [], outputs: [port('value', 'value', 'vec4')], fields: [{ key: 'value', label: 'Value', type: 'vector', size: 4, default: [0, 0, 0, 0], min: -1e6, max: 1e6 }] },
  {
    type: 'color',
    label: 'Colour',
    category: 'Inputs',
    description: 'A constant colour (sRGB, converted to linear) and an alpha.',
    inputs: [],
    outputs: [port('rgb', 'rgb', 'vec3'), port('alpha', 'alpha', 'float'), port('rgba', 'rgba', 'vec4')],
    fields: [
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
      { key: 'alpha', label: 'Alpha', type: 'number', default: 1, min: 0, max: 1 },
    ],
  },
  {
    type: 'parameter',
    label: 'Parameter',
    category: 'Inputs',
    description: 'An exposed parameter of the material (objects may override public ones); its type is the declaration\'s.',
    inputs: [],
    outputs: [{ id: 'value', label: 'value', type: 'float', typeFrom: { field: 'key', lookup: 'parameter' } }],
    fields: [{ key: 'key', label: 'Parameter', type: 'string', default: '', maxLength: 32, pattern: NAME_PATTERN }],
    titleField: 'key',
  },
  { type: 'time', label: 'Time', category: 'Inputs', description: 'Seconds since the game started (scaled by the game clock).', inputs: [], outputs: [port('time', 'time', 'float')] },
  { type: 'uv', label: 'UV', category: 'Inputs', description: 'A texture coordinate set of the mesh.', inputs: [], outputs: [port('uv', 'uv', 'vec2')], fields: [{ key: 'set', label: 'Set', type: 'enum', options: ['uv0', 'uv1'], default: 'uv0' }] },
  {
    type: 'vertexColor',
    label: 'Vertex colour',
    category: 'Inputs',
    description: 'The mesh\'s COLOR_0 attribute; a mesh without one reads white (a neutral tint) or zero with alpha 1 (vertex colours used as data, e.g. wind weights).',
    inputs: [],
    outputs: [port('rgba', 'rgba', 'vec4'), port('rgb', 'rgb', 'vec3'), port('alpha', 'alpha', 'float')],
    // Phase 18.2: white multiplies to no change (a tint); zero means "no effect" for data channels.
    fields: [{ key: 'absent', label: 'Without COLOR_0', type: 'enum', options: ['white', 'zero'], default: 'white' }],
  },
  { type: 'position', label: 'Position', category: 'Inputs', description: 'The surface position in object, world or view space.', inputs: [], outputs: [port('position', 'position', 'vec3')], fields: [SPACE_FIELD(['object', 'world', 'view'], 'world')] },
  { type: 'normal', label: 'Normal', category: 'Inputs', description: 'The surface normal in object, world or view space.', inputs: [], outputs: [port('normal', 'normal', 'vec3')], fields: [SPACE_FIELD(['object', 'world', 'view'], 'world')] },
  { type: 'viewDirection', label: 'View direction', category: 'Inputs', description: 'The direction from the surface to the camera (normalized).', inputs: [], outputs: [port('direction', 'direction', 'vec3')], fields: [SPACE_FIELD(['world', 'view'], 'world')] },
  {
    type: 'objectPosition',
    label: 'Object position',
    category: 'Inputs',
    description: 'The object\'s origin in world space (in an instance set, the drawn instance\'s own origin) — the same for every pixel of one piece.',
    inputs: [],
    outputs: [port('position', 'position', 'vec3')],
  },
  { type: 'cameraDistance', label: 'Camera distance', category: 'Inputs', description: 'Metres from the camera to the surface.', inputs: [], outputs: [port('distance', 'distance', 'float')] },
  { type: 'screenUV', label: 'Screen UV', category: 'Inputs', description: 'The position on the screen (0–1 in both axes).', inputs: [], outputs: [port('uv', 'uv', 'vec2')] },
  { type: 'instanceIndex', label: 'Instance index', category: 'Inputs', description: 'The index of the drawn instance in an instance set (0 for a single object).', inputs: [], outputs: [port('index', 'index', 'float')] },
  {
    type: 'wind',
    label: 'Global wind',
    category: 'Inputs',
    description: 'The project\'s wind (Environment): direction on the ground plane, the current strength with gusts, and turbulence.',
    inputs: [],
    outputs: [port('direction', 'direction', 'vec3'), port('strength', 'strength', 'float'), port('turbulence', 'turbulence', 'float')],
  },
];

const MATH_NODES: readonly GraphNodeDef[] = [
  binary('add', 'Add', 'a + b.'),
  binary('subtract', 'Subtract', 'a − b.'),
  binary('multiply', 'Multiply', 'a × b (per component).', 1, 1),
  binary('divide', 'Divide', 'a ÷ b (per component).', 1, 1),
  binary('min', 'Minimum', 'The smaller of a and b (per component).'),
  binary('max', 'Maximum', 'The larger of a and b (per component).'),
  binary('power', 'Power', 'a raised to b (per component).', 1, 1),
  { type: 'dot', label: 'Dot product', category: 'Maths', description: 'a · b.', inputs: [dyn('a', 'a', 0), dyn('b', 'b', 0)], outputs: [port('out', 'out', 'float')], fields: [TYPE_FIELD] },
  { type: 'cross', label: 'Cross product', category: 'Maths', description: 'a × b (three components).', inputs: [port('a', 'a', 'vec3', [1, 0, 0]), port('b', 'b', 'vec3', [0, 1, 0])], outputs: [port('out', 'out', 'vec3')] },
  unary('normalize', 'Normalize', 'The vector scaled to length 1.'),
  { type: 'length', label: 'Length', category: 'Maths', description: 'The length of a vector (the absolute value of a number).', inputs: [dyn('in', 'in', 0)], outputs: [port('out', 'out', 'float')], fields: [TYPE_FIELD] },
  { type: 'lerp', label: 'Lerp', category: 'Maths', description: 'Blends a to b by t (t = 0: a, t = 1: b).', inputs: [dyn('a', 'a', 0), dyn('b', 'b', 1), dyn('t', 't', 0.5)], outputs: [dyn('out', 'out')], fields: [TYPE_FIELD] },
  { type: 'clamp', label: 'Clamp', category: 'Maths', description: 'Limits the value to [min, max].', inputs: [dyn('in', 'in', 0), dyn('min', 'min', 0), dyn('max', 'max', 1)], outputs: [dyn('out', 'out')], fields: [TYPE_FIELD] },
  unary('saturate', 'Saturate', 'Limits the value to [0, 1].'),
  { type: 'smoothstep', label: 'Smoothstep', category: 'Maths', description: 'A smooth 0→1 ramp of x between edge0 and edge1.', inputs: [dyn('edge0', 'edge0', 0), dyn('edge1', 'edge1', 1), dyn('x', 'x', 0.5)], outputs: [dyn('out', 'out')], fields: [TYPE_FIELD] },
  { type: 'step', label: 'Step', category: 'Maths', description: '0 where x < edge, else 1.', inputs: [dyn('edge', 'edge', 0.5), dyn('x', 'x', 0)], outputs: [dyn('out', 'out')], fields: [TYPE_FIELD] },
  unary('abs', 'Absolute', 'The value without its sign.'),
  unary('floor', 'Floor', 'Rounds down to a whole number.'),
  unary('fract', 'Fraction', 'The part after the decimal point (x − floor x).'),
  unary('sin', 'Sine', 'sin(x), x in radians.'),
  unary('cos', 'Cosine', 'cos(x), x in radians.'),
  unary('oneMinus', 'One minus', '1 − x.'),
  {
    type: 'remap',
    label: 'Remap',
    category: 'Maths',
    description: 'Maps the value from [inMin, inMax] to [outMin, outMax].',
    inputs: [dyn('in', 'in', 0), dyn('inMin', 'in min', 0), dyn('inMax', 'in max', 1), dyn('outMin', 'out min', 0), dyn('outMax', 'out max', 1)],
    outputs: [dyn('out', 'out')],
    fields: [TYPE_FIELD],
  },
];

const VECTOR_NODES: readonly GraphNodeDef[] = [
  {
    type: 'split',
    label: 'Split',
    category: 'Vectors',
    description: 'The components of a vector (a narrower vector pads with 0 and w = 1).',
    inputs: [port('in', 'in', 'vec4', [0, 0, 0, 0])],
    outputs: [port('x', 'x', 'float'), port('y', 'y', 'float'), port('z', 'z', 'float'), port('w', 'w', 'float')],
  },
  {
    type: 'combine',
    label: 'Combine',
    category: 'Vectors',
    description: 'A vector from components.',
    inputs: [port('x', 'x', 'float', 0), port('y', 'y', 'float', 0), port('z', 'z', 'float', 0), port('w', 'w', 'float', 1)],
    outputs: [port('xyzw', 'xyzw', 'vec4'), port('xyz', 'xyz', 'vec3'), port('xy', 'xy', 'vec2')],
  },
  {
    type: 'swizzle',
    label: 'Swizzle',
    category: 'Vectors',
    description: 'Picks and reorders components by a mask (x y z w or r g b a, 1–4 letters); the result has the mask\'s width.',
    inputs: [port('in', 'in', 'vec4', [0, 0, 0, 0])],
    outputs: [{ id: 'out', label: 'out', type: 'vec3', typeFrom: { field: 'mask', byLength: [...MATERIAL_VALUE_TYPES] } }],
    fields: [{ key: 'mask', label: 'Mask', type: 'string', default: 'xyz', maxLength: 4, pattern: '[xyzw]{1,4}|[rgba]{1,4}' }],
  },
];

const SAMPLER_FIELDS: readonly GraphFieldDef[] = [
  TEXTURE_FIELD,
  { key: 'wrap', label: 'Wrap', type: 'enum', options: ['repeat', 'clamp', 'mirror'], default: 'repeat' },
  { key: 'filter', label: 'Filter', type: 'enum', options: ['linear', 'nearest'], default: 'linear' },
  // sRGB for colour images, linear for data (masks, heights, roughness).
  { key: 'colorSpace', label: 'Colour space', type: 'enum', options: ['srgb', 'linear'], default: 'srgb' },
];
const TEX_IN = port('tex', 'texture', 'texture');
const SAMPLE_OUTPUTS: readonly GraphPortDef[] = [port('rgba', 'rgba', 'vec4'), port('rgb', 'rgb', 'vec3'), port('r', 'r', 'float'), port('g', 'g', 'float'), port('b', 'b', 'float'), port('a', 'a', 'float')];

const TEXTURE_NODES: readonly GraphNodeDef[] = [
  {
    type: 'sampleTexture',
    label: 'Sample texture',
    category: 'Textures',
    description: 'Reads a texture (its field, or a texture wire such as a parameter) at a UV.',
    inputs: [TEX_IN, port('uv', 'uv', 'vec2', 'uv0')],
    outputs: SAMPLE_OUTPUTS,
    fields: SAMPLER_FIELDS,
  },
  {
    type: 'normalMap',
    label: 'Normal map',
    category: 'Textures',
    description: 'Reads a tangent-space normal map and scales its strength (feeds a surface normal).',
    inputs: [TEX_IN, port('uv', 'uv', 'vec2', 'uv0'), port('strength', 'strength', 'float', 1)],
    outputs: [port('normal', 'normal', 'vec3')],
    fields: [TEXTURE_FIELD, SAMPLER_FIELDS[1]!, SAMPLER_FIELDS[2]!],
  },
  {
    type: 'triplanar',
    label: 'Triplanar',
    category: 'Textures',
    description: 'Projects a texture along the three axes and blends by the normal (no UVs needed).',
    inputs: [TEX_IN, port('position', 'position', 'vec3', 'positionWorld'), port('normal', 'normal', 'vec3', 'normalWorld'), port('scale', 'scale', 'float', 1), port('sharpness', 'sharpness', 'float', 4)],
    outputs: [port('rgba', 'rgba', 'vec4'), port('rgb', 'rgb', 'vec3')],
    fields: SAMPLER_FIELDS,
  },
  {
    type: 'flipbook',
    label: 'Flipbook',
    category: 'Textures',
    description: 'The UV of one frame of a grid of frames (connect Time × frames per second to play it).',
    inputs: [port('uv', 'uv', 'vec2', 'uv0'), port('frame', 'frame', 'float', 0)],
    outputs: [port('uv', 'uv', 'vec2')],
    fields: [
      { key: 'columns', label: 'Columns', type: 'number', default: 4, min: 1, max: 64 },
      { key: 'rows', label: 'Rows', type: 'number', default: 4, min: 1, max: 64 },
    ],
  },
  {
    type: 'noise',
    label: 'Noise',
    category: 'Textures',
    description: 'Procedural noise: value, gradient (Perlin-like) or Voronoi (distance to the nearest cell, and a random value per cell).',
    inputs: [port('uv', 'uv', 'vec2', 'uv0'), port('scale', 'scale', 'float', 10)],
    outputs: [port('value', 'value', 'float'), port('cell', 'cell', 'float')],
    fields: [{ key: 'noise', label: 'Noise', type: 'enum', options: ['value', 'gradient', 'voronoi'], default: 'gradient' }],
  },
  {
    type: 'gradient',
    label: 'Gradient',
    category: 'Textures',
    description: 'A 0–1 ramp over the UV: linear (along u), radial (from the centre) or angular (around the centre).',
    inputs: [port('uv', 'uv', 'vec2', 'uv0')],
    outputs: [port('value', 'value', 'float')],
    fields: [{ key: 'shape', label: 'Shape', type: 'enum', options: ['linear', 'radial', 'angular'], default: 'linear' }],
  },
  {
    type: 'colorRamp',
    label: 'Colour ramp',
    category: 'Textures',
    description: 'Maps t (0–1) to a colour between two colours.',
    inputs: [port('t', 't', 'float', 0.5)],
    outputs: [port('rgb', 'rgb', 'vec3')],
    fields: [
      { key: 'from', label: 'From', type: 'color', default: '#000000' },
      { key: 'to', label: 'To', type: 'color', default: '#ffffff' },
      { key: 'interpolation', label: 'Interpolation', type: 'enum', options: ['linear', 'smooth', 'constant'], default: 'linear' },
    ],
  },
];

const UTILITY_NODES: readonly GraphNodeDef[] = [
  {
    type: 'fresnel',
    label: 'Fresnel',
    category: 'Utility',
    description: '(1 − n·v)^power: bright where the surface turns away from the camera.',
    inputs: [port('normal', 'normal', 'vec3', 'normalWorld'), port('view', 'view dir', 'vec3', 'viewDirWorld'), port('power', 'power', 'float', 5)],
    outputs: [port('out', 'out', 'float')],
  },
  {
    type: 'rim',
    label: 'Rim',
    category: 'Utility',
    description: 'A soft band at the silhouette: width is how far it reaches in, softness how smooth its inner edge is.',
    inputs: [port('normal', 'normal', 'vec3', 'normalWorld'), port('view', 'view dir', 'vec3', 'viewDirWorld'), port('width', 'width', 'float', 0.3), port('softness', 'softness', 'float', 0.1)],
    outputs: [port('out', 'out', 'float')],
  },
  { type: 'posterize', label: 'Posterize', category: 'Utility', description: 'Quantizes the value to a number of steps.', inputs: [dyn('in', 'in', 0), dyn('steps', 'steps', 4)], outputs: [dyn('out', 'out')], fields: [TYPE_FIELD] },
  {
    type: 'dither',
    label: 'Dither',
    category: 'Utility',
    description: '1 where the value beats an ordered (Bayer) threshold at the screen position, else 0 — fades without transparency.',
    inputs: [port('in', 'in', 'float', 0.5), port('screen', 'screen uv', 'vec2', 'screenUV')],
    outputs: [port('out', 'out', 'float')],
    fields: [{ key: 'pattern', label: 'Pattern', type: 'enum', options: ['bayer4', 'bayer8'], default: 'bayer4' }],
  },
  {
    type: 'worldUV',
    label: 'World-aligned UV',
    category: 'Utility',
    description: 'A UV from the world position on a plane, so a texture flows across separate pieces.',
    inputs: [port('position', 'position', 'vec3', 'positionWorld'), port('scale', 'scale', 'float', 1)],
    outputs: [port('uv', 'uv', 'vec2')],
    fields: [{ key: 'plane', label: 'Plane', type: 'enum', options: ['xz', 'xy', 'zy'], default: 'xz' }],
  },
  {
    type: 'parallax',
    label: 'Parallax',
    category: 'Utility',
    description: 'Simple parallax offset: shifts the UV along the view direction by height × scale.',
    inputs: [port('uv', 'uv', 'vec2', 'uv0'), port('height', 'height', 'float', 0), port('scale', 'scale', 'float', 0.05), port('view', 'view dir (tangent)', 'vec3', 'viewDirTangent')],
    outputs: [port('uv', 'uv', 'vec2')],
  },
  {
    type: 'displace',
    label: 'Vertex displacement',
    category: 'Utility',
    description: 'An offset along a direction (the object normal by default) by height × scale — feed a Vertex offset output.',
    inputs: [port('height', 'height', 'float', 0), port('scale', 'scale', 'float', 1), port('direction', 'direction', 'vec3', 'normalObject')],
    outputs: [port('offset', 'offset', 'vec3')],
  },
  {
    type: 'alphaClip',
    label: 'Alpha clip',
    category: 'Utility',
    description: 'Discards the pixel where alpha is below the threshold; passes alpha on.',
    inputs: [port('alpha', 'alpha', 'float', 1), port('threshold', 'threshold', 'float', 0.5)],
    outputs: [port('alpha', 'alpha', 'float')],
  },
];

/** A material-function graph id (the standalone graph document id syntax). */
const FUNCTION_FIELD: GraphFieldDef = { key: 'function', label: 'Function', type: 'string', default: '', maxLength: 64, pattern: '[a-z0-9][a-z0-9_-]{0,63}' };

const CALL_NODE: GraphNodeDef = {
  type: 'call',
  label: 'Function call',
  category: 'Functions',
  description: 'Runs a material function; its ports are the function\'s inputs and outputs (unconnected inputs use the function\'s defaults).',
  inputs: [],
  outputs: [],
  fields: [FUNCTION_FIELD],
  portsFrom: { field: 'function', kind: 'material-function' },
  titleField: 'function',
};

const OUTPUT_NODES: readonly GraphNodeDef[] = [
  {
    type: 'pbr',
    label: 'PBR output',
    category: 'Output',
    description: 'A lit, physically based surface. Normal is tangent space; alpha clip > 0 discards pixels below it.',
    inputs: [
      port('baseColor', 'base colour', 'vec3', [1, 1, 1]),
      port('metalness', 'metalness', 'float', 0),
      // 0.8: a matte surface — the engine's standard material default.
      port('roughness', 'roughness', 'float', 0.8),
      port('normal', 'normal', 'vec3', [0, 0, 1]),
      port('emissive', 'emissive', 'vec3', [0, 0, 0]),
      port('ao', 'ambient occlusion', 'float', 1),
      port('opacity', 'opacity', 'float', 1),
      port('alphaClip', 'alpha clip', 'float', 0),
    ],
    outputs: [],
    fields: SURFACE_FLAGS,
    required: true,
    exclusive: 'surface',
  },
  {
    type: 'unlit',
    label: 'Unlit output',
    category: 'Output',
    description: 'A surface that ignores lights (its colour is what you see).',
    inputs: [port('color', 'colour', 'vec3', [1, 1, 1]), port('opacity', 'opacity', 'float', 1), port('alphaClip', 'alpha clip', 'float', 0)],
    outputs: [],
    fields: SURFACE_FLAGS,
    exclusive: 'surface',
  },
  {
    type: 'vertexOffset',
    label: 'Vertex offset',
    category: 'Output',
    description: 'Moves the mesh\'s vertices (the vertex stage), in object or world space.',
    inputs: [port('offset', 'offset', 'vec3', [0, 0, 0])],
    outputs: [],
    fields: [SPACE_FIELD(['object', 'world'], 'object')],
    max: 1,
  },
];

const PORT_TYPES: GraphKindDef['portTypes'] = [
  { id: 'float', label: 'float', color: '#8fb4ff' },
  { id: 'vec2', label: 'vec2', color: '#7ed491' },
  { id: 'vec3', label: 'vec3', color: '#f2b544' },
  { id: 'vec4', label: 'vec4', color: '#e67e9b' },
  { id: 'texture', label: 'texture', color: '#c792ea' },
];

function conversions(): GraphKindDef['conversions'] {
  const out: { from: string; to: string; label: string }[] = [];
  const width = (t: string): number => MATERIAL_VALUE_TYPES.indexOf(t as (typeof MATERIAL_VALUE_TYPES)[number]) + 1;
  const comps = 'xyzw';
  for (const from of MATERIAL_VALUE_TYPES) {
    for (const to of MATERIAL_VALUE_TYPES) {
      if (from === to) continue;
      const a = width(from);
      const b = width(to);
      const label =
        a === 1
          ? `${from} → ${to} (every component)`
          : b < a
            ? `${from} → ${to} (${b === 1 ? 'x' : comps.slice(0, b)})`
            : `${from} → ${to} (pad ${comps.slice(a, b).split('').map((c) => (c === 'w' ? 'w = 1' : `${c} = 0`)).join(', ')})`;
      out.push({ from, to, label });
    }
  }
  return out;
}

const SHARED_NODES: readonly GraphNodeDef[] = [...INPUT_NODES.filter((n) => n.type !== 'parameter'), ...MATH_NODES, ...VECTOR_NODES, ...TEXTURE_NODES, ...UTILITY_NODES, CALL_NODE];

/** A material's graph (owner kind `material`). */
export const MATERIAL_GRAPH_KIND: GraphKindDef = {
  kind: 'material',
  label: 'Material graph',
  portTypes: PORT_TYPES,
  conversions: conversions(),
  categories: ['Inputs', 'Maths', 'Vectors', 'Textures', 'Utility', 'Functions', 'Output'],
  nodes: [INPUT_NODES.find((n) => n.type === 'parameter')!, ...SHARED_NODES, ...OUTPUT_NODES],
  // A shader is a data flow: a value never depends on itself.
  allowCycles: false,
  // 512: the plan's bound for one material (compile time and shader size stay small).
  maxNodes: 512,
  sinks: ['pbr', 'unlit', 'vertexOffset'],
  owner: 'material',
};

/** A reusable material sub-graph (a standalone graph document); calls see its inputs and outputs as ports. */
export const MATERIAL_FUNCTION_GRAPH_KIND: GraphKindDef = {
  kind: 'material-function',
  label: 'Material function',
  portTypes: PORT_TYPES,
  conversions: conversions(),
  categories: ['Interface', 'Inputs', 'Maths', 'Vectors', 'Textures', 'Utility', 'Functions'],
  nodes: [
    {
      type: 'functionInput',
      label: 'Function input',
      category: 'Interface',
      description: 'An input of the function (a port of every call); its default is used when a call leaves the port unconnected.',
      inputs: [],
      outputs: [{ id: 'value', label: 'value', type: 'float', typeFrom: { field: 'type' } }],
      fields: [
        { key: 'name', label: 'Name', type: 'string', default: '', maxLength: 32, pattern: NAME_PATTERN },
        { key: 'type', label: 'Type', type: 'enum', options: [...MATERIAL_VALUE_TYPES, 'texture'], default: 'float' },
        { key: 'default', label: 'Default', type: 'vector', size: 4, default: [0, 0, 0, 0], min: -1e6, max: 1e6 },
      ],
      titleField: 'name',
    },
    {
      type: 'functionOutput',
      label: 'Function output',
      category: 'Interface',
      description: 'An output of the function (a port of every call).',
      inputs: [{ id: 'value', label: 'value', type: 'float', typeFrom: { field: 'type' }, default: 0 }],
      outputs: [],
      fields: [
        { key: 'name', label: 'Name', type: 'string', default: '', maxLength: 32, pattern: NAME_PATTERN },
        { key: 'type', label: 'Type', type: 'enum', options: [...MATERIAL_VALUE_TYPES], default: 'float' },
      ],
      titleField: 'name',
    },
    ...SHARED_NODES,
  ],
  allowCycles: false,
  // The same bound as a material graph.
  maxNodes: 512,
  sinks: ['functionOutput'],
  interface: { input: 'functionInput', output: 'functionOutput', labelField: 'name', typeField: 'type' },
};

/**
 * Phase 20.1: the visual-effects node catalogue (graph-kind data).
 *
 * One graph kind, `effect` (owner kind `effect`): the graph of ONE particle
 * system of an effect (`content.effects[].systems[].graph`, owner id
 * `<effectId>/<systemId>`). Every system graph holds the four contexts as
 * fixed nodes — Spawn, Initialize, Update and Output — and each context runs
 * a chain of blocks: the context's `then` output feeds the first block, each
 * block's `then` feeds the next (one wire in, one wire out), so the chain is
 * the execution order (like a visual script's exec wires). A chain's port
 * type is its context's (`spawn`, `init`, `update`, `render`), so a block
 * only connects where it means something: forces only in Update, renderers
 * only in Output. Blocks not on a chain do nothing (a diagnostic).
 *
 * Block parameters are node fields; every number, 3-vector and colour field
 * also has an input port with the field's key — a wired input replaces the
 * field (per particle in Initialize/Update/Output, once per step in Spawn).
 * Value nodes (constants, exposed parameters, random ranges, age curves and
 * gradients, particle attributes, time, maths) feed those inputs. Value
 * types: `float`, `vec3` and `color` (linear RGBA); a float splats to a
 * vector or a grey colour, a vector becomes a colour with alpha 1 and a
 * colour a vector (its RGB).
 *
 * Semantics (the CPU reference evaluator, package `@thirdlight/effects`, and
 * the WebGPU compute executor of phase 20.2 implement the same):
 * - positions of shapes are added to the particle's base position (the
 *   effect origin, or the source particle for an event spawn), velocities
 *   to its base velocity (zero, or the inherited share of the source's);
 * - forces change the velocity in chain order; after the chain the position
 *   is integrated (explicit Euler) and then collisions and kill volumes run
 *   (in chain order); a particle dies when its age reaches its lifetime;
 * - size and colour are recomputed every step from their initial values and
 *   the Update blocks that scale them (over-life curves and gradients).
 *
 * Effects are visual only: nothing here feeds back into the deterministic
 * game simulation. Every default carries its genre-neutral reason.
 */
import type { GraphFieldDef, GraphKindDef, GraphNodeDef, GraphPortDef, GraphValue } from './graph';

/** Engine limits of one system graph (not tuning values). */
export const EFFECT_GRAPH_LIMITS = {
  /** Nodes per system graph: a rich system uses ~40; keeps the per-particle interpreter bounded. */
  nodes: 256,
} as const;

/** The value port types (widening order: float → vec3 → color). */
export const EFFECT_VALUE_TYPES = ['float', 'vec3', 'color'] as const;
export type EffectValueType = (typeof EFFECT_VALUE_TYPES)[number];
/** The flow port type of each context's chain. */
export const EFFECT_CONTEXT_FLOWS = { spawn: 'spawn', initialize: 'init', update: 'update', output: 'render' } as const;
export type EffectContext = keyof typeof EFFECT_CONTEXT_FLOWS;
export const EFFECT_CONTEXTS = Object.keys(EFFECT_CONTEXT_FLOWS) as readonly EffectContext[];

/** The events a particle can raise for other systems (`spawn.event`). */
export const EFFECT_EVENTS = ['death', 'birth', 'collision'] as const;
/** The particle attributes a graph can read (`value.attribute`). */
export const EFFECT_ATTRIBUTES = ['position', 'velocity', 'age', 'normalizedAge', 'lifetime', 'size', 'color', 'mass', 'speed', 'random'] as const;
export const EFFECT_ATTRIBUTE_TYPES: Readonly<Record<(typeof EFFECT_ATTRIBUTES)[number], EffectValueType>> = {
  position: 'vec3',
  velocity: 'vec3',
  age: 'float',
  normalizedAge: 'float',
  lifetime: 'float',
  size: 'float',
  color: 'color',
  mass: 'float',
  speed: 'float',
  random: 'float',
};
export const EFFECT_BLEND_MODES = ['alpha', 'additive', 'premultiplied', 'multiply', 'opaque'] as const;
/** Lighting of an output: built-in unlit/lit particle materials, or a project material (a material graph, phase 18). */
export const EFFECT_SHADING = ['unlit', 'lit', 'material'] as const;

// ---- builders -----------------------------------------------------------------------------

/** A position or offset in metres (±10 km: far beyond any effect). */
const POS = 1e4;
/** A speed / acceleration bound (m/s, m/s²). */
const SPEED = 1e4;
/** Particles per second / per burst. */
const COUNT = 1e5;

const ID_PATTERN = '[a-z0-9][a-z0-9_-]{0,63}';
const NAME_PATTERN = '[A-Za-z_][A-Za-z0-9_]{0,31}';

const num = (key: string, label: string, d: number, min: number, max: number): GraphFieldDef => ({ key, label, type: 'number', default: d, min, max });
const vec3 = (key: string, label: string, d: [number, number, number], bound = POS): GraphFieldDef => ({ key, label, type: 'vector', size: 3, default: d, min: -bound, max: bound });
const bool = (key: string, label: string, d: boolean): GraphFieldDef => ({ key, label, type: 'boolean', default: d });
const enm = (key: string, label: string, options: readonly string[], d: string): GraphFieldDef => ({ key, label, type: 'enum', options, default: d });
const color = (key: string, label: string, d: string): GraphFieldDef => ({ key, label, type: 'color', default: d });
const curve = (key: string, label: string, d: number[], min: number, max: number): GraphFieldDef => ({ key, label, type: 'curve', default: d, min, max });
const gradient = (key: string, label: string, d: number[]): GraphFieldDef => ({ key, label, type: 'gradient', default: d });
const asset = (key: string, label: string, kind: string): GraphFieldDef => ({ key, label, type: 'string', default: '', maxLength: 64, pattern: ID_PATTERN, asset: kind });
/** A field that takes no input port (enums, flags, assets, curves…, and numbers marked `fixed`). */
const fixed = (f: GraphFieldDef): GraphFieldDef & { fixedField: true } => ({ ...f, fixedField: true });

const vport = (id: string, label: string, type: EffectValueType): GraphPortDef => ({ id, label, type });

/** The value input a field gets: number → float, 3-vector → vec3, colour → color. */
function fieldPort(f: GraphFieldDef): GraphPortDef | null {
  if ((f as { fixedField?: true }).fixedField === true) return null;
  if (f.type === 'number') return vport(f.key, f.label.toLowerCase(), 'float');
  if (f.type === 'vector' && f.size === 3) return vport(f.key, f.label.toLowerCase(), 'vec3');
  if (f.type === 'color') return vport(f.key, f.label.toLowerCase(), 'color');
  return null;
}
const strip = (f: GraphFieldDef): GraphFieldDef => {
  const { fixedField: _f, ...rest } = f as GraphFieldDef & { fixedField?: true };
  return rest;
};

/** A block of a context chain: flow in/out of the context's type, value ports from its fields. */
function block(context: EffectContext, type: string, label: string, category: string, description: string, fields: readonly GraphFieldDef[]): GraphNodeDef {
  const flow = EFFECT_CONTEXT_FLOWS[context];
  const inputs: GraphPortDef[] = [{ id: 'in', label: 'in', type: flow }];
  for (const f of fields) {
    const p = fieldPort(f);
    if (p !== null) inputs.push(p);
  }
  return { type, label, category, description, inputs, outputs: [{ id: 'then', label: 'then', type: flow, single: true }], fields: fields.map(strip) };
}

function contextNode(context: EffectContext, label: string, description: string): GraphNodeDef {
  return { type: context, label, category: 'Contexts', description, inputs: [], outputs: [{ id: 'then', label: 'then', type: EFFECT_CONTEXT_FLOWS[context], single: true }], max: 1, required: true, fixed: true };
}

// ---- shared fields --------------------------------------------------------------------------

const CENTER = vec3('center', 'Centre', [0, 0, 0]);
/** 0.5 m: a hand-sized to person-sized emitter, adjusted per effect. */
const RADIUS = num('radius', 'Radius', 0.5, 0, POS);
const AXIS = fixed(enm('axis', 'Axis', ['x', 'y', 'z'], 'y'));
/** Up (+Y): the engine's up axis. */
const PLANE_NORMAL = vec3('normal', 'Normal', [0, 1, 0], 1);
const BLEND = fixed(enm('blend', 'Blending', EFFECT_BLEND_MODES, 'alpha'));
const SHADING = fixed(enm('shading', 'Shading', EFFECT_SHADING, 'unlit'));
/** A project material (used when shading is `material`): its graph (phase 18) shades the particles. */
const MATERIAL: GraphFieldDef = { key: 'material', label: 'Material', type: 'string', default: '', maxLength: 64, pattern: ID_PATTERN };
const SOFT = fixed(bool('soft', 'Soft particles', false));
/** 0.25 m: fades a quad over a quarter metre where it meets geometry. */
const SOFT_DISTANCE = num('softDistance', 'Soft distance (m)', 0.25, 0.001, 100);
const FLIPBOOK = [
  fixed(enm('flipbook', 'Flipbook', ['none', 'overLife', 'fps'], 'none')),
  fixed(num('columns', 'Columns', 1, 1, 64)),
  fixed(num('rows', 'Rows', 1, 1, 64)),
  /** 12 frames/s: a common hand-drawn animation rate. */
  fixed(num('fps', 'Frames/s', 12, 0.01, 240)),
];
/** A fade-out: full at birth, gone at death (works for sparks, smoke, dust alike). */
const FADE_CURVE = [0, 1, 1, 0];
/** White, fading from opaque to transparent over the life. */
const FADE_GRADIENT = [0, 1, 1, 1, 1, 1, 1, 1, 1, 0];

// ---- contexts -------------------------------------------------------------------------------

const CONTEXT_NODES: readonly GraphNodeDef[] = [
  contextNode('spawn', 'Spawn', 'How many particles are born each step: the sum of its blocks (rates, bursts, distance, events).'),
  contextNode('initialize', 'Initialize', 'Runs once for each new particle, in chain order: where it starts, how it moves, how long it lives, how it looks.'),
  contextNode('update', 'Update', 'Runs every step for each living particle, in chain order: forces, then the position moves, then collisions and kills.'),
  contextNode('output', 'Output', 'How the particles are drawn: every renderer on the chain draws them (in chain order).'),
];

// ---- spawn ----------------------------------------------------------------------------------

const SPAWN_NODES: readonly GraphNodeDef[] = [
  block('spawn', 'spawn.rate', 'Constant rate', 'Spawn', 'Particles per second while the effect plays (fractions carry over to the next step).', [
    /** 10/s: a visible, light stream. */
    num('rate', 'Rate (/s)', 10, 0, COUNT),
  ]),
  block('spawn', 'spawn.burst', 'Burst', 'Spawn', 'A number of particles at once at a time of the effect; repeated `cycles` times every `interval` seconds (0 cycles: forever).', [
    /** 20: a small puff. */
    num('count', 'Count', 20, 0, COUNT),
    num('time', 'Time (s)', 0, 0, 3600),
    fixed(num('cycles', 'Cycles', 1, 0, 10000)),
    fixed(num('interval', 'Interval (s)', 1, 0.001, 3600)),
  ]),
  block('spawn', 'spawn.distance', 'Over distance', 'Spawn', 'Particles per metre the effect moves (trails behind moving objects); spread along the path.', [
    /** 5/m: a dotted trail at walking speed. */
    num('perMeter', 'Per metre', 5, 0, COUNT),
  ]),
  block('spawn', 'spawn.event', 'From event', 'Spawn', 'Particles born where particles of another system of this effect die, are born or collide; they may inherit its velocity and colour.', [
    { key: 'system', label: 'System', type: 'string', default: '', maxLength: 64, pattern: ID_PATTERN },
    fixed(enm('event', 'Event', EFFECT_EVENTS, 'death')),
    /** 1: one particle per event. */
    fixed(num('count', 'Per event', 1, 0, 64)),
    fixed(num('inheritVelocity', 'Inherit velocity', 0, 0, 1)),
    fixed(bool('inheritColor', 'Inherit colour', false)),
  ]),
];

// ---- initialize -----------------------------------------------------------------------------

const SHAPE = 'Position';
const INIT_NODES: readonly GraphNodeDef[] = [
  block('initialize', 'init.position.point', 'Point', SHAPE, 'Starts at one point (offset from the base). Direction: up.', [vec3('offset', 'Offset', [0, 0, 0])]),
  block('initialize', 'init.position.sphere', 'Sphere', SHAPE, 'A random point in a sphere (or on its surface). Direction: outward.', [CENTER, RADIUS, fixed(bool('surface', 'Surface only', false))]),
  block('initialize', 'init.position.box', 'Box', SHAPE, 'A random point in a box (or on its faces). Direction: up.', [CENTER, vec3('size', 'Size', [1, 1, 1]), fixed(bool('surface', 'Surface only', false))]),
  block('initialize', 'init.position.circle', 'Circle', SHAPE, 'A random point in a disc (or on its edge) around an axis. Direction: outward in the disc.', [CENTER, RADIUS, AXIS, fixed(bool('edge', 'Edge only', false))]),
  block('initialize', 'init.position.cone', 'Cone', SHAPE, 'A random point on the base disc of a cone; the direction spreads within the cone angle around the axis.', [
    CENTER,
    num('radius', 'Base radius', 0, 0, POS),
    /** 25°: a moderate spray. */
    num('angle', 'Angle (deg)', 25, 0, 89),
    AXIS,
  ]),
  block('initialize', 'init.position.line', 'Line', SHAPE, 'A random point on a segment. Direction: up.', [vec3('start', 'Start', [0, 0, 0]), vec3('end', 'End', [1, 0, 0])]),
  block('initialize', 'init.position.mesh', 'Mesh surface', SHAPE, 'A random point on the surface of a model asset (triangles weighted by area). Direction: the surface normal.', [
    fixed(asset('model', 'Model', 'model')),
    num('scale', 'Scale', 1, 0, 1000),
  ]),
  block('initialize', 'init.velocity', 'Velocity', 'Initialize', 'Adds a random velocity between min and max (per axis).', [
    /** Straight up at 1 m/s: a gentle rise, the neutral start of most effects. */
    vec3('min', 'Min', [0, 1, 0], SPEED),
    vec3('max', 'Max', [0, 1, 0], SPEED),
  ]),
  block('initialize', 'init.velocity.direction', 'Velocity from direction', 'Initialize', 'Adds a velocity along the direction the position block chose, with a random speed between min and max.', [
    num('speedMin', 'Speed min', 1, 0, SPEED),
    num('speedMax', 'Speed max', 2, 0, SPEED),
  ]),
  block('initialize', 'init.lifetime', 'Lifetime', 'Initialize', 'How long the particle lives: random between min and max seconds.', [
    /** 1 s: short enough to recycle, long enough to read. */
    num('min', 'Min (s)', 1, 0.001, 3600),
    num('max', 'Max (s)', 1, 0.001, 3600),
  ]),
  block('initialize', 'init.size', 'Size', 'Initialize', 'The particle size in metres: random between min and max.', [
    /** 0.1 m: a visible mote at a few metres. */
    num('min', 'Min (m)', 0.1, 0, POS),
    num('max', 'Max (m)', 0.1, 0, POS),
  ]),
  block('initialize', 'init.color', 'Colour', 'Initialize', 'The particle colour and opacity.', [color('color', 'Colour', '#ffffff'), fixed(num('alpha', 'Alpha', 1, 0, 1))]),
  block('initialize', 'init.color.gradient', 'Colour from gradient', 'Initialize', 'A random colour picked along a gradient.', [fixed(gradient('gradient', 'Gradient', [0, 1, 1, 1, 1, 1, 1, 1, 1, 1]))]),
  block('initialize', 'init.rotation', 'Rotation', 'Initialize', 'The particle angle (degrees, around its facing axis) and its spin (degrees per second), each random between min and max.', [
    num('angleMin', 'Angle min', 0, -360, 360),
    num('angleMax', 'Angle max', 0, -360, 360),
    num('spinMin', 'Spin min', 0, -3600, 3600),
    num('spinMax', 'Spin max', 0, -3600, 3600),
  ]),
  block('initialize', 'init.mass', 'Mass', 'Initialize', 'The particle mass in kg (forces other than gravity accelerate lighter particles more): random between min and max.', [
    num('min', 'Min (kg)', 1, 0.0001, 1e6),
    num('max', 'Max (kg)', 1, 0.0001, 1e6),
  ]),
];

// ---- update ---------------------------------------------------------------------------------

const UPDATE_NODES: readonly GraphNodeDef[] = [
  block('update', 'update.gravity', 'Gravity', 'Forces', 'A constant acceleration in world space (independent of mass).', [
    /** -9.81 m/s² on Y: Earth gravity. */
    vec3('acceleration', 'Acceleration', [0, -9.81, 0], SPEED),
  ]),
  block('update', 'update.drag', 'Drag', 'Forces', 'Slows the particle: velocity × e^(−coefficient × dt / mass).', [
    /** 1/s: loses ~63 % of its speed per second at 1 kg. */
    num('coefficient', 'Coefficient', 1, 0, 1000),
  ]),
  block('update', 'update.wind', 'Wind', 'Forces', 'Pushes the particle toward the project\'s global wind velocity (Environment → Wind, with its gusts).', [
    /** 1: follows the wind fully in about a second at 1 kg. */
    num('influence', 'Influence', 1, 0, 100),
  ]),
  block('update', 'update.vortex', 'Vortex', 'Forces', 'Swirls around an axis through a centre (tangential acceleration) and pulls toward the axis.', [
    CENTER,
    vec3('axis', 'Axis', [0, 1, 0], 1),
    num('strength', 'Strength', 2, -SPEED, SPEED),
    num('pull', 'Pull', 0, -SPEED, SPEED),
  ]),
  block('update', 'update.turbulence', 'Turbulence', 'Forces', 'Curl-noise acceleration: a divergence-free swirl field that scrolls over time (per effect seed).', [
    /** 1 m: eddies about a metre across. */
    num('frequency', 'Frequency (1/m)', 1, 0.001, 100),
    num('strength', 'Strength', 1, 0, SPEED),
    fixed(num('octaves', 'Octaves', 1, 1, 4)),
    num('speed', 'Scroll (/s)', 0.5, 0, 100),
  ]),
  block('update', 'update.attractor', 'Attractor', 'Forces', 'Accelerates toward a point (negative strength repels); radius 0 reaches everywhere, else only within the radius.', [
    vec3('position', 'Position', [0, 0, 0]),
    num('strength', 'Strength', 5, -SPEED, SPEED),
    num('radius', 'Radius', 0, 0, POS),
  ]),
  block('update', 'update.collide.plane', 'Collide with plane', 'Collision', 'Bounces off an infinite plane (after the position moves): bounce keeps that share of the normal speed, friction removes that share of the tangential speed.', [
    vec3('point', 'Point', [0, 0, 0]),
    PLANE_NORMAL,
    /** 0.5: a soft bounce. */
    num('bounce', 'Bounce', 0.5, 0, 1),
    num('friction', 'Friction', 0.1, 0, 1),
    fixed(num('lifetimeLoss', 'Lifetime loss', 0, 0, 1)),
    fixed(bool('kill', 'Kill on hit', false)),
  ]),
  block('update', 'update.collide.depth', 'Collide with scene (depth)', 'Collision', 'Bounces off whatever the camera sees, using the depth buffer — honoured only by the WebGPU executor; the CPU fallback (WebGL 2) ignores it.', [
    num('bounce', 'Bounce', 0.5, 0, 1),
    num('friction', 'Friction', 0.1, 0, 1),
    /** 0.1 m: surfaces are treated as this thick. */
    fixed(num('thickness', 'Thickness (m)', 0.1, 0.001, 10)),
    fixed(bool('kill', 'Kill on hit', false)),
  ]),
  block('update', 'update.size.curve', 'Size over life', 'Over life', 'Multiplies the initial size by a curve of the normalized age (0 at birth, 1 at death).', [fixed(curve('curve', 'Curve', FADE_CURVE, 0, 100))]),
  block('update', 'update.color.gradient', 'Colour over life', 'Over life', 'Multiplies (or replaces) the initial colour by a gradient of the normalized age.', [fixed(gradient('gradient', 'Gradient', FADE_GRADIENT)), fixed(enm('mode', 'Mode', ['multiply', 'set'], 'multiply'))]),
  block('update', 'update.velocity.curve', 'Speed limit over life', 'Over life', 'Caps the speed at a curve of the normalized age (m/s).', [fixed(curve('curve', 'Max speed', [0, 10, 1, 10], 0, SPEED))]),
  block('update', 'update.kill.plane', 'Kill behind plane', 'Kill', 'Kills particles on the far side of a plane (against its normal).', [vec3('point', 'Point', [0, 0, 0]), PLANE_NORMAL]),
  block('update', 'update.kill.sphere', 'Kill sphere', 'Kill', 'Kills particles inside (or outside) a sphere.', [CENTER, num('radius', 'Radius', 1, 0, POS), fixed(enm('mode', 'Kill', ['inside', 'outside'], 'inside'))]),
  block('update', 'update.kill.box', 'Kill box', 'Kill', 'Kills particles inside (or outside) a box.', [CENTER, vec3('size', 'Size', [1, 1, 1]), fixed(enm('mode', 'Kill', ['inside', 'outside'], 'outside'))]),
  block('update', 'update.kill.speed', 'Kill when slow', 'Kill', 'Kills particles slower than a speed (m/s) — e.g. debris that came to rest.', [num('speed', 'Below (m/s)', 0.05, 0, SPEED)]),
];

// ---- output ---------------------------------------------------------------------------------

const OUTPUT_NODES: readonly GraphNodeDef[] = [
  block('output', 'output.billboard', 'Billboard', 'Output', 'A textured quad per particle: facing the camera, aligned with its velocity, or turning around a fixed axis.', [
    fixed(enm('orient', 'Orientation', ['camera', 'velocity', 'axis'], 'camera')),
    vec3('axis', 'Fixed axis', [0, 1, 0], 1),
    fixed(asset('texture', 'Texture', 'texture')),
    ...FLIPBOOK,
    BLEND,
    SOFT,
    SOFT_DISTANCE,
    SHADING,
    MATERIAL,
  ]),
  block('output', 'output.mesh', 'Mesh particles', 'Output', 'A model asset drawn per particle (scaled by its size, turned by its rotation).', [fixed(asset('model', 'Model', 'model')), BLEND, SHADING, MATERIAL]),
  block('output', 'output.ribbon', 'Ribbon / trail', 'Output', 'Trail: each particle draws a strip through its recent positions. Ribbon: one strip joins the particles in birth order.', [
    fixed(enm('mode', 'Mode', ['trail', 'ribbon'], 'trail')),
    /** 0.5 s of history: a readable streak. */
    fixed(num('trailLength', 'Trail length (s)', 0.5, 0.01, 10)),
    fixed(num('segments', 'Segments', 16, 2, 64)),
    num('width', 'Width (× size)', 1, 0, 100),
    fixed(asset('texture', 'Texture', 'texture')),
    BLEND,
    SHADING,
    MATERIAL,
  ]),
  block('output', 'output.light', 'Lights', 'Output', 'A point light at up to `max lights` particles (the oldest living ones), coloured by the particle.', [
    /** 4: point lights are costly; a few give the glow. */
    fixed(num('maxLights', 'Max lights', 4, 1, 16)),
    /** 1 cd per particle, 2 m range: a small glow. */
    num('intensity', 'Intensity (cd)', 1, 0, 1000),
    num('range', 'Range (m)', 2, 0.01, 1000),
  ]),
];

// ---- values and maths -----------------------------------------------------------------------

const TYPE_FIELD: GraphFieldDef = { key: 'type', label: 'Type', type: 'enum', options: ['auto', ...EFFECT_VALUE_TYPES], default: 'auto' };
/** A port whose type follows the node's `type` field (auto: the widest wire in); `d` is what it reads unwired. */
const dyn = (id: string, label: string, d: number): GraphPortDef => ({ id, label, type: 'float', typeFrom: { field: 'type' }, default: d });
const dport = (id: string, label: string, type: EffectValueType, d: GraphValue): GraphPortDef => ({ id, label, type, default: d });
const SOURCE_FIELD = enm('input', 'Input', ['age', 'effectTime', 'random'], 'age');

const VALUE_NODES: readonly GraphNodeDef[] = [
  { type: 'value.float', label: 'Float', category: 'Values', description: 'A constant number.', inputs: [], outputs: [vport('value', 'value', 'float')], fields: [num('value', 'Value', 0, -1e6, 1e6)] },
  { type: 'value.vec3', label: 'Vector', category: 'Values', description: 'A constant 3-vector.', inputs: [], outputs: [vport('value', 'value', 'vec3')], fields: [vec3('value', 'Value', [0, 0, 0], 1e6)] },
  { type: 'value.color', label: 'Colour', category: 'Values', description: 'A constant colour and alpha.', inputs: [], outputs: [vport('value', 'value', 'color')], fields: [color('color', 'Colour', '#ffffff'), num('alpha', 'Alpha', 1, 0, 1)] },
  {
    type: 'value.parameter',
    label: 'Parameter',
    category: 'Values',
    description: 'An exposed parameter of the effect (objects may override public ones); its type is the declaration\'s.',
    inputs: [],
    outputs: [{ id: 'value', label: 'value', type: 'float', typeFrom: { field: 'key', lookup: 'parameter' } }],
    fields: [{ key: 'key', label: 'Parameter', type: 'string', default: '', maxLength: 32, pattern: NAME_PATTERN }],
    titleField: 'key',
  },
  { type: 'value.random', label: 'Random', category: 'Values', description: 'A random number between min and max: per particle (fixed for its life) or per step in Spawn.', inputs: [], outputs: [vport('value', 'value', 'float')], fields: [num('min', 'Min', 0, -1e6, 1e6), num('max', 'Max', 1, -1e6, 1e6)] },
  { type: 'value.randomVec3', label: 'Random vector', category: 'Values', description: 'A random 3-vector between min and max (per axis).', inputs: [], outputs: [vport('value', 'value', 'vec3')], fields: [vec3('min', 'Min', [-1, -1, -1], 1e6), vec3('max', 'Max', [1, 1, 1], 1e6)] },
  {
    type: 'value.curve',
    label: 'Curve',
    category: 'Values',
    description: 'A curve read at the particle\'s normalized age (in Spawn: the effect time), the effect\'s normalized time, or a per-particle random position.',
    inputs: [],
    outputs: [vport('value', 'value', 'float')],
    fields: [curve('curve', 'Curve', FADE_CURVE, -1e6, 1e6), SOURCE_FIELD],
  },
  {
    type: 'value.gradient',
    label: 'Gradient',
    category: 'Values',
    description: 'A gradient read at the particle\'s normalized age (in Spawn: the effect time), the effect\'s normalized time, or a per-particle random position.',
    inputs: [],
    outputs: [vport('value', 'value', 'color')],
    fields: [gradient('gradient', 'Gradient', FADE_GRADIENT), SOURCE_FIELD],
  },
  {
    type: 'value.attribute',
    label: 'Particle attribute',
    category: 'Values',
    description: 'A value of the particle (not in Spawn): position, velocity, age, normalized age, lifetime, size, colour, mass, speed or its fixed random number.',
    inputs: [],
    outputs: [{ id: 'value', label: 'value', type: 'float', typeFrom: { field: 'attribute', map: EFFECT_ATTRIBUTE_TYPES } }],
    fields: [enm('attribute', 'Attribute', EFFECT_ATTRIBUTES, 'age')],
    titleField: 'attribute',
  },
  { type: 'value.time', label: 'Effect time', category: 'Values', description: 'Seconds since the effect (re)started, and that time over the duration (0–1).', inputs: [], outputs: [vport('time', 'time', 'float'), vport('normalized', 'normalized', 'float')] },
  // Unwired inputs read their port default (0, or 1 for the factor of a product or quotient).
  ...(
    [
      ['math.add', 'Add', 'a + b.', 0, 0],
      ['math.subtract', 'Subtract', 'a − b.', 0, 0],
      ['math.multiply', 'Multiply', 'a × b (per component).', 1, 1],
      ['math.divide', 'Divide', 'a ÷ b (per component; ÷ 0 gives 0).', 1, 1],
      ['math.min', 'Minimum', 'The smaller of a and b (per component).', 0, 0],
      ['math.max', 'Maximum', 'The larger of a and b (per component).', 0, 0],
    ] as const
  ).map(([type, label, description, a, b]): GraphNodeDef => ({ type, label, category: 'Maths', description, inputs: [dyn('a', 'a', a), dyn('b', 'b', b)], outputs: [dyn('out', 'out', 0)], fields: [TYPE_FIELD] })),
  { type: 'math.lerp', label: 'Lerp', category: 'Maths', description: 'a + (b − a) × t.', inputs: [dyn('a', 'a', 0), dyn('b', 'b', 1), dport('t', 't', 'float', 0.5)], outputs: [dyn('out', 'out', 0)], fields: [TYPE_FIELD] },
  { type: 'math.oneMinus', label: 'One minus', category: 'Maths', description: '1 − x (per component).', inputs: [dyn('in', 'in', 0)], outputs: [dyn('out', 'out', 0)], fields: [TYPE_FIELD] },
  { type: 'math.sine', label: 'Sine', category: 'Maths', description: 'sin(x) (radians).', inputs: [dport('in', 'in', 'float', 0)], outputs: [vport('out', 'out', 'float')] },
  { type: 'math.length', label: 'Length', category: 'Maths', description: 'The length of a vector.', inputs: [dport('in', 'in', 'vec3', [0, 0, 0])], outputs: [vport('out', 'out', 'float')] },
  { type: 'math.normalize', label: 'Normalize', category: 'Maths', description: 'The vector scaled to length 1 (0 stays 0).', inputs: [dport('in', 'in', 'vec3', [0, 0, 0])], outputs: [vport('out', 'out', 'vec3')] },
  { type: 'math.combine', label: 'Combine', category: 'Maths', description: 'Three numbers into a vector.', inputs: [dport('x', 'x', 'float', 0), dport('y', 'y', 'float', 0), dport('z', 'z', 'float', 0)], outputs: [vport('out', 'out', 'vec3')] },
  { type: 'math.split', label: 'Split', category: 'Maths', description: 'A vector into its three numbers.', inputs: [dport('in', 'in', 'vec3', [0, 0, 0])], outputs: [vport('x', 'x', 'float'), vport('y', 'y', 'float'), vport('z', 'z', 'float')] },
];

/** A particle system's graph (owner kind `effect`, owner id `<effectId>/<systemId>`). */
export const EFFECT_GRAPH_KIND: GraphKindDef = {
  kind: 'effect',
  label: 'Particle system',
  portTypes: [
    { id: 'spawn', label: 'spawn chain', color: '#f0a35e' },
    { id: 'init', label: 'initialize chain', color: '#7ed491' },
    { id: 'update', label: 'update chain', color: '#7fb3ff' },
    { id: 'render', label: 'output chain', color: '#d59bf0' },
    { id: 'float', label: 'float', color: '#c8c8c8' },
    { id: 'vec3', label: 'vec3', color: '#ffc46b' },
    { id: 'color', label: 'colour', color: '#ff7f9e' },
  ],
  conversions: [
    { from: 'float', to: 'vec3', label: 'float → vec3 (all components)' },
    { from: 'float', to: 'color', label: 'float → colour (grey, alpha 1)' },
    { from: 'vec3', to: 'color', label: 'vec3 → colour (alpha 1)' },
    { from: 'color', to: 'vec3', label: 'colour → vec3 (RGB)' },
  ],
  categories: ['Contexts', 'Spawn', 'Position', 'Initialize', 'Forces', 'Collision', 'Over life', 'Kill', 'Output', 'Values', 'Maths'],
  nodes: [...CONTEXT_NODES, ...SPAWN_NODES, ...INIT_NODES, ...UPDATE_NODES, ...OUTPUT_NODES, ...VALUE_NODES],
  // Chains and value flows never loop.
  allowCycles: false,
  maxNodes: EFFECT_GRAPH_LIMITS.nodes,
  owner: 'effect',
};

/** Where the four fixed context nodes of a new system graph sit (columns left to right). */
export const EFFECT_CONTEXT_LAYOUT: Readonly<Record<EffectContext, [number, number]>> = {
  spawn: [0, 0],
  initialize: [0, 200],
  update: [0, 400],
  output: [0, 600],
};

/** A new system's graph: the four contexts, no blocks. Node ids are the context names. */
export function newEffectSystemGraph(): { nodes: { id: string; type: string; position: [number, number] }[]; edges: [] } {
  return { nodes: EFFECT_CONTEXTS.map((c) => ({ id: c, type: c, position: [...EFFECT_CONTEXT_LAYOUT[c]] as [number, number] })), edges: [] };
}

/** The value a field of a node type defaults to (the catalogue's). */
export function effectFieldDefault(type: string, key: string): GraphValue | undefined {
  return EFFECT_GRAPH_KIND.nodes.find((n) => n.type === type)?.fields?.find((f) => f.key === key)?.default;
}

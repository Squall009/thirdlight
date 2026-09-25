/**
 * Phase 21.0: the deterministic benchmark generator. A pure function of the
 * class and the seed: the same inputs give the same plan (every value comes
 * from a seeded PRNG, never Math.random or the clock), so two runs measure the
 * same project. The plan is data only; `build.ts` applies it through the real
 * command API. Nothing here is tuned to a demo: a neutral platformer lane with
 * a floor, platforms, background blocks, props of one generated model kit,
 * scripted objects, effects and instanced scatter.
 */
import { CLASS_SPECS, type BenchClass, type ClassSpec } from './classes';

/** Bump when the generated content changes (it keys the cached projects and the baseline). */
export const GENERATOR_VERSION = 1;
export const DEFAULT_SEED = 21;

/** One entity value for `pasteEntities` (ids are local; the backend assigns real ones). */
export interface EntityValue {
  id: string;
  name: string;
  parentId?: string;
  components: Record<string, unknown>;
}

export interface BehaviorPlan {
  behaviorId: string;
  displayName: string;
  source: string;
  ownedTransforms: string[];
  declaration: { properties: Record<string, unknown>[] };
}

export interface BufferPlan {
  key: string;
  count: number;
  /** 10 float32 per copy: position xyz, quaternion xyzw, scale xyz. */
  floats: Float32Array;
}

export interface ScenePlan {
  sceneId: string;
  name: string;
  /** Pasted in order; a batch holds whole groups (a parent with its children). */
  batches: EntityValue[][];
}

export interface BenchPlan {
  generatorVersion: number;
  className: BenchClass;
  seed: number;
  spec: ClassSpec;
  /** Every scene starts (the class measures everything it holds at once). */
  scenes: ScenePlan[];
  materials: Record<string, unknown>[];
  effects: Record<string, unknown>[];
  behaviors: BehaviorPlan[];
  buffers: BufferPlan[];
  /** The model kit: pieces with LODs and collision boxes (tests/e2e/multi-piece-glb.ts builds the GLB). */
  model: { assetId: string; displayName: string; pieces: { name: string; lods: [number, number, number][]; col?: [number, number, number] }[] };
  /** The fixed objects made with createEntity in the first scene (their ids feed the game block). */
  player: { position: [number, number, number]; size: [number, number, number] };
  spawn: [number, number, number];
  goal: [number, number, number];
  camera: { position: [number, number, number]; far: number };
  /** Entity counts by kind (the whole project, built-ins included). */
  counts: Record<string, number>;
}

/** mulberry32: a tiny, well-mixed 32-bit PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const T = (x: number, y: number, z: number, yawDeg = 0, s: [number, number, number] = [1, 1, 1]): Record<string, unknown> => {
  // A unit quaternion to 1e-6 (the model checks |q| within 1e-4).
  const h = (yawDeg * Math.PI) / 360;
  const qy = Math.round(Math.sin(h) * 1e6) / 1e6;
  const qw = Math.round(Math.cos(h) * 1e6) / 1e6;
  return { position: [round3(x), round3(y), round3(z)], rotation: [0, qy, 0, qw], scale: s.map(round3) };
};
const hex = (n: number): string => `#${Math.floor(n).toString(16).padStart(6, '0').slice(-6)}`;

/** The built-ins every new project has (camera, sun, ambient) plus player, spawn and goal. */
const FIXED_ENTITIES = 6;
/** One group parent per this many children (a flat but realistic hierarchy). */
const GROUP_CHILDREN = 15;
/** Width of one scene's section of the lane (m). */
const SCENE_WIDTH = 120;
/**
 * Colliders over all start scenes: the model allows 256 in a scene and in
 * the merged start set (Play and the export refuse more), so a class keeps
 * 200 over its scenes.
 */
const COLLIDERS_TOTAL = 200;
/**
 * Scripts that move their object do it on one step in four (their slot from
 * the entity id): the runtime lets one behavior commit at most 64 intents per
 * step over all its instances, so hundreds of moving instances are staggered.
 */
const HASH_SLOT = '  instantiate(_p: unknown, inst: any) { let h = 0; for (const c of inst.entityId) h = (h * 31 + c.charCodeAt(0)) | 0; return { slot: Math.abs(h) % 4, yaw: 0, y0: null as number | null }; },';
/** Id numbers per prefix (the backend numbers `<prefix>-0001..9999`). */
const ID_MAX = 9999;
/** Most entities one pasteEntities creates (commands' PASTE_ENTITIES_MAX). */
const PASTE_MAX = 256;

/** The generic scripts: a spinner and a bobber (own their transform), a counter, a prober, a messenger. */
export const BENCH_BEHAVIORS: readonly BehaviorPlan[] = [
  {
    behaviorId: 'bench-spin',
    displayName: 'Bench spin',
    ownedTransforms: ['@self'],
    declaration: { properties: [{ key: 'speed', label: 'Degrees per second', type: 'number', default: 90, min: -720, max: 720, step: 1 }] },
    source: [
      'export default {',
      HASH_SLOT,
      '  step(state: { slot: number; yaw: number }, ctx: any) {',
      "    if (ctx.phase !== 'transform' || ctx.stepIndex % 4 !== state.slot) return;",
      '    state.yaw = (state.yaw + (ctx.properties.speed * 4) / 120) % 360;',
      "    ctx.emit({ kind: 'pose', entityId: ctx.entityId, rotation: { yaw: state.yaw } });",
      '  },',
      '};',
      '',
    ].join('\n'),
  },
  {
    behaviorId: 'bench-bob',
    displayName: 'Bench bob',
    ownedTransforms: ['@self'],
    declaration: { properties: [{ key: 'height', label: 'Height (m)', type: 'number', default: 0.5, min: 0, max: 10, step: 0.1 }] },
    source: [
      'export default {',
      HASH_SLOT,
      '  step(state: { slot: number; y0: number | null }, ctx: any) {',
      "    if (ctx.phase !== 'transform' || ctx.stepIndex % 4 !== state.slot) return;",
      '    const me = ctx.world.transform(ctx.entityId);',
      '    if (me === undefined) return;',
      '    if (state.y0 === null) state.y0 = me.position[1];',
      "    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { y: state.y0 + Math.sin(ctx.stepIndex / 60) * ctx.properties.height } });",
      '  },',
      '};',
      '',
    ].join('\n'),
  },
  {
    behaviorId: 'bench-count',
    displayName: 'Bench count',
    ownedTransforms: [],
    declaration: { properties: [{ key: 'every', label: 'Seconds between counts', type: 'number', default: 0.5, min: 0.05, max: 60, step: 0.05 }] },
    source: [
      'export default {',
      "  instantiate() { return { started: false }; },",
      '  step(state: { started: boolean }, ctx: any) {',
      "    if (!state.started) { ctx.timers.every('tick', ctx.properties.every); state.started = true; }",
      "    if (ctx.timers.fired('tick')) { ctx.game?.add('ticks', 1); ctx.signals?.emit('pulse'); }",
      '  },',
      '};',
      '',
    ].join('\n'),
  },
  {
    behaviorId: 'bench-probe',
    displayName: 'Bench probe',
    ownedTransforms: [],
    declaration: { properties: [{ key: 'reach', label: 'Ray length (m)', type: 'number', default: 4, min: 0.1, max: 100, step: 0.1 }] },
    source: [
      'export default {',
      '  instantiate(_p: unknown, inst: any) { let h = 0; for (const c of inst.entityId) h = (h * 31 + c.charCodeAt(0)) | 0; return { slot: Math.abs(h) % 16, hits: 0 }; },',
      '  step(state: { slot: number; hits: number }, ctx: any) {',
      '    if (ctx.stepIndex % 16 !== state.slot) return;',
      '    const me = ctx.world.transform(ctx.entityId);',
      '    if (me === undefined) return;',
      '    const hit = ctx.physics.raycast?.({ x: me.position[0], y: me.position[1] }, { x: 0, y: -1 }, ctx.properties.reach);',
      '    if (hit) state.hits += 1;',
      '  },',
      '};',
      '',
    ].join('\n'),
  },
  {
    behaviorId: 'bench-talk',
    displayName: 'Bench talk',
    ownedTransforms: [],
    declaration: { properties: [{ key: 'period', label: 'Steps between messages', type: 'number', default: 60, min: 1, max: 10000, step: 1 }] },
    source: [
      'export default {',
      '  instantiate() { return { heard: 0 }; },',
      '  step(state: { heard: number }, ctx: any) {',
      "    state.heard += ctx.messages?.received('hello').length ?? 0;",
      "    if (ctx.stepIndex % ctx.properties.period === 0) ctx.messages?.send('hello', state.heard);",
      '  },',
      '};',
      '',
    ].join('\n'),
  },
];

/** The kit: three pieces with two LODs and a collision box each (generic props: a block, a slab, a post). */
const KIT: BenchPlan['model'] = {
  assetId: 'bench-kit',
  displayName: 'Bench kit',
  pieces: [
    { name: 'block', lods: [[1, 1, 1], [1, 0.95, 1]], col: [1, 1, 1] },
    { name: 'slab', lods: [[2, 0.4, 1], [2, 0.38, 1]], col: [2, 0.4, 1] },
    { name: 'post', lods: [[0.3, 2, 0.3], [0.3, 1.9, 0.3]], col: [0.3, 2, 0.3] },
  ],
};

function effectDef(i: number, capacity: number, rnd: () => number): Record<string, unknown> {
  const lifetime = 2;
  const color = hex(0x404040 + rnd() * 0xbfbfbf);
  return {
    effectId: `bench-fx-${String(i + 1).padStart(3, '0')}`,
    name: `Bench effect ${i + 1}`,
    duration: 2,
    loop: true,
    seed: i + 1,
    bounds: { center: [0, 2, 0], size: [6, 6, 6] },
    systems: [
      {
        systemId: 'main',
        name: 'Main',
        maxParticles: capacity,
        space: 'world',
        graph: {
          nodes: [
            { id: 'spawn', type: 'spawn', position: [0, 0] },
            { id: 'initialize', type: 'initialize', position: [0, 200] },
            { id: 'update', type: 'update', position: [0, 400] },
            { id: 'output', type: 'output', position: [0, 600] },
            // rate × lifetime = capacity: the system runs full.
            { id: 'rate', type: 'spawn.rate', position: [300, 0], data: { rate: capacity / lifetime } },
            { id: 'shape', type: 'init.position.sphere', position: [300, 200], data: { radius: 0.5 } },
            { id: 'vel', type: 'init.velocity', position: [300, 260], data: { min: [-1, 2, -1], max: [1, 4, 1] } },
            { id: 'life', type: 'init.lifetime', position: [300, 320], data: { min: lifetime, max: lifetime } },
            { id: 'col', type: 'init.color', position: [300, 380], data: { color } },
            { id: 'grav', type: 'update.gravity', position: [300, 400] },
            { id: 'drag', type: 'update.drag', position: [300, 460] },
            { id: 'bb', type: 'output.billboard', position: [300, 600] },
          ],
          edges: [
            { id: 'e1', from: { node: 'spawn', port: 'then' }, to: { node: 'rate', port: 'in' } },
            { id: 'e2', from: { node: 'initialize', port: 'then' }, to: { node: 'shape', port: 'in' } },
            { id: 'e3', from: { node: 'shape', port: 'then' }, to: { node: 'vel', port: 'in' } },
            { id: 'e4', from: { node: 'vel', port: 'then' }, to: { node: 'life', port: 'in' } },
            { id: 'e5', from: { node: 'life', port: 'then' }, to: { node: 'col', port: 'in' } },
            { id: 'e6', from: { node: 'update', port: 'then' }, to: { node: 'grav', port: 'in' } },
            { id: 'e7', from: { node: 'grav', port: 'then' }, to: { node: 'drag', port: 'in' } },
            { id: 'e8', from: { node: 'output', port: 'then' }, to: { node: 'bb', port: 'in' } },
          ],
        },
      },
    ],
  };
}

/** A scatter of `count` copies on a grid behind the lane (upright, random turn and size). */
function scatter(count: number, x0: number, rnd: () => number): Float32Array {
  const f = new Float32Array(count * 10);
  const cols = Math.ceil(Math.sqrt(count * 2));
  const spacing = 0.9;
  for (let i = 0; i < count; i += 1) {
    const cx = i % cols;
    const cz = Math.floor(i / cols);
    const yaw = rnd() * Math.PI * 2;
    const s = 0.5 + rnd() * 0.7;
    f.set([x0 + cx * spacing + rnd() * 0.4, 0, -6 - cz * spacing - rnd() * 0.4, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2), s, s, s], i * 10);
  }
  return f;
}

/**
 * The plan for one class. Every scene gets a floor strip and platforms with
 * colliders, background blocks, kit props, scripted boxes, effect emitters,
 * point lights and instance sets, spread in proportion; groups of
 * GROUP_CHILDREN objects sit under a parent group.
 */
export function generate(className: BenchClass, seed = DEFAULT_SEED): BenchPlan {
  const spec = CLASS_SPECS[className];
  const rnd = prng(seed * 7919 + spec.entities);
  const materials = Array.from({ length: spec.materials }, (_, i) => ({
    materialId: `bench-mat-${String(i + 1).padStart(3, '0')}`,
    name: `Bench material ${i + 1}`,
    shader: 'standard',
    params: { color: hex(0x303030 + rnd() * 0xcfcfcf), roughness: round3(0.3 + rnd() * 0.7), metalness: round3(rnd() < 0.2 ? 0.8 : 0) },
    textures: {},
  }));
  const effects = Array.from({ length: spec.effects }, (_, i) => effectDef(i, spec.particlesPerEffect, rnd));
  const behaviors = BENCH_BEHAVIORS.map((b) => ({ ...b, ownedTransforms: [...b.ownedTransforms], declaration: { properties: b.declaration.properties.map((p) => ({ ...p })) } }));

  // Deal every object to a scene, round robin, in a fixed kind order; the
  // background blocks fill up to the class's exact entity count.
  type Kind = 'block' | 'model' | 'script' | 'effect' | 'light' | 'instances';
  const deal = (blocks: number): Kind[][] => {
    const perScene: Kind[][] = Array.from({ length: spec.scenes }, () => []);
    let cursor = 0;
    const add = (kind: Kind, count: number): void => {
      for (let n = 0; n < count; n += 1) perScene[cursor++ % spec.scenes]!.push(kind);
    };
    add('instances', spec.instanceSets);
    add('light', spec.pointLights);
    add('effect', spec.effects);
    add('script', spec.scriptInstances);
    add('model', spec.models);
    add('block', blocks);
    return perScene;
  };
  const parentsOf = (perScene: Kind[][]): number => perScene.reduce((a, l) => a + Math.ceil(l.length / GROUP_CHILDREN), 0);
  const totalOf = (perScene: Kind[][]): number => FIXED_ENTITIES + perScene.reduce((a, l) => a + l.length, 0) + parentsOf(perScene);
  const special = spec.instanceSets + spec.effects + spec.scriptInstances + spec.models + spec.pointLights;
  let blocks = spec.entities - FIXED_ENTITIES - special;
  while (blocks > 0 && totalOf(deal(blocks)) > spec.entities) blocks -= 1;
  const perScene = deal(blocks);
  if (totalOf(perScene) > spec.entities) throw new Error(`class ${className}: the special objects do not fit in ${spec.entities} entities`);

  const buffers: BufferPlan[] = [];
  const counts: Record<string, number> = { camera: 1, directional: 1, ambient: 1, player: 1, spawn: 1, goal: 1, block: 0, collider: 0, model: 0, script: 0, effect: 0, light: 0, instances: 0, group: 0, copies: 0 };
  let effectIndex = 0;
  const scenes: ScenePlan[] = perScene.map((list, s) => {
    const sceneId = s === 0 ? 'scene-main' : `scene-bench-${String(s).padStart(2, '0')}`;
    const x0 = s * SCENE_WIDTH;
    const values: EntityValue[] = [];
    let colliders = 0;
    let floors = 0;
    let local = 0;
    for (const kind of list) {
      const id = `${kind}-${values.length}`;
      const x = x0 - 10 + rnd() * (SCENE_WIDTH - 5);
      const matId = materials.length > 0 ? materials[(counts.block! + counts.model! + counts.script!) % materials.length]!.materialId : undefined;
      const mat = matId !== undefined ? { materials: { '*': matId } } : {};
      switch (kind) {
        case 'block': {
          counts.block! += 1;
          // Along the lane: floor strips and platforms carry colliders (up to the per-scene cap); behind it: scenery.
          if (colliders < Math.floor(COLLIDERS_TOTAL / spec.scenes) && rnd() < 0.35) {
            colliders += 1;
            counts.collider! += 1;
            const floor = colliders % 3 === 1;
            let px: number;
            let py: number;
            let pz = 0;
            const w = floor ? 6 : round3(1.5 + rnd() * 3);
            const h = floor ? 1 : 0.4;
            if (floor) {
              // Floor strips run along the section; later rounds sit deeper (visual only: physics is 2D).
              const along = floors * 6;
              px = x0 - 10 + (along % SCENE_WIDTH);
              pz = -2.5 * Math.floor(along / SCENE_WIDTH);
              py = -0.5;
              floors += 1;
            } else {
              px = x;
              py = round3(1.2 + rnd() * 5);
              // Keep the player's start clear.
              if (s === 0 && Math.abs(px) < 4) px += 8;
            }
            values.push({ id, name: floor ? `Floor ${counts.block}` : `Platform ${counts.block}`, components: { transform: T(px, py, pz), box: { size: [w, h, 2], material: { color: '#6f7a86' } }, collider: { shape: { type: 'box', hx: w / 2, hy: h / 2 } }, ...mat } });
          } else {
            const sz: [number, number, number] = [0.5 + rnd() * 3, 0.5 + rnd() * 4, 0.5 + rnd() * 3];
            values.push({ id, name: `Block ${counts.block}`, components: { transform: T(x, sz[1] / 2, -3 - rnd() * 40, rnd() * 360), box: { size: sz.map(round3), material: { color: '#8a8f96' } }, ...mat } });
          }
          break;
        }
        case 'model': {
          counts.model! += 1;
          const piece = KIT.pieces[counts.model! % KIT.pieces.length]!.name;
          values.push({ id, name: `Prop ${counts.model}`, components: { transform: T(x, 0, -2 - rnd() * 30, rnd() * 360), model: { asset: { assetId: KIT.assetId }, piece }, ...mat } });
          break;
        }
        case 'script': {
          counts.script! += 1;
          const b = behaviors[counts.script! % behaviors.length]!;
          const prop = b.declaration.properties[0]! as { key: string; default: number };
          values.push({ id, name: `Scripted ${counts.script}`, components: { transform: T(x, 1 + rnd() * 3, -1.5 - rnd() * 6), box: { size: [0.5, 0.5, 0.5], material: { color: '#c08040' } }, behavior: { behaviorId: b.behaviorId, values: { [prop.key]: prop.default } }, ...mat } });
          break;
        }
        case 'effect': {
          counts.effect! += 1;
          const fx = effects[effectIndex++]!;
          values.push({ id, name: `Emitter ${counts.effect}`, components: { transform: T(x, 0.5, -2 - rnd() * 6), effect: { effectId: fx['effectId'] } } });
          break;
        }
        case 'light': {
          if (local >= 16) throw new Error('more than 16 point lights in one scene');
          local += 1;
          counts.light! += 1;
          values.push({ id, name: `Lamp ${counts.light}`, components: { transform: T(x, 3, 2), light: { type: 'point', color: '#ffd0a0', intensity: 20, range: 12, decay: 2 } } });
          break;
        }
        case 'instances': {
          counts.instances! += 1;
          counts.copies! += spec.copiesPerSet;
          const key = `set-${counts.instances}`;
          buffers.push({ key, count: spec.copiesPerSet, floats: scatter(spec.copiesPerSet, x0 - 10, rnd) });
          const piece = KIT.pieces[(counts.instances! + 1) % KIT.pieces.length]!.name;
          values.push({ id, name: `Scatter ${counts.instances}`, components: { transform: T(0, 0, 0), instances: { asset: { assetId: KIT.assetId, piece }, buffer: `$buffer:${key}`, count: spec.copiesPerSet } } });
          break;
        }
      }
    }
    // Groups: a parent group (at the origin, identity) over up to GROUP_CHILDREN objects; batches hold whole groups.
    const batches: EntityValue[][] = [];
    let batch: EntityValue[] = [];
    const push = (group: EntityValue[]): void => {
      if (batch.length + group.length > PASTE_MAX) {
        batches.push(batch);
        batch = [];
      }
      batch.push(...group);
    };
    const group = (g: string): EntityValue => {
      counts.group! += 1;
      return { id: `group-${s}-${g}`, name: `Group ${counts.group}`, components: { transform: T(0, 0, 0) } };
    };
    // Physics-bearing objects (colliders) must be roots: they stay ungrouped.
    const roots = values.filter((v) => v.components['collider'] !== undefined);
    const grouped = values.filter((v) => v.components['collider'] === undefined);
    for (let i = 0; i < roots.length; i += GROUP_CHILDREN) push(roots.slice(i, i + GROUP_CHILDREN));
    for (let i = 0; i < grouped.length; i += GROUP_CHILDREN) {
      const parent = group(String(i));
      push([parent, ...grouped.slice(i, i + GROUP_CHILDREN).map((c) => ({ ...c, parentId: parent.id }))]);
    }
    if (batch.length > 0) batches.push(batch);
    return { sceneId, name: s === 0 ? 'Main' : `Bench ${String(s).padStart(2, '0')}`, batches };
  });

  // The group estimate above is an upper bound (colliders stay ungrouped): empty groups fill the exact count.
  const made = (): number => scenes.reduce((a, sc) => a + sc.batches.reduce((b, x) => b + x.length, 0), 0) + FIXED_ENTITIES;
  const last = scenes[scenes.length - 1]!;
  for (let k = 0; made() < spec.entities; k += 1) {
    counts.group! += 1;
    const empty: EntityValue = { id: `group-empty-${k}`, name: `Group ${counts.group}`, components: { transform: T(0, 0, 0) } };
    const tail = last.batches[last.batches.length - 1];
    if (tail !== undefined && tail.length < PASTE_MAX) tail.push(empty);
    else last.batches.push([empty]);
  }

  // Id prefixes are numbered 1..9999 across the project.
  const prefix: Record<string, number> = { box: 1 + counts.block! + counts.script!, model: counts.model!, group: counts.group! + counts.effect!, instances: counts.instances!, light: 2 + counts.light! };
  for (const [p, n] of Object.entries(prefix)) if (n > ID_MAX) throw new Error(`class ${className}: ${n} ids with prefix ${p} (at most ${ID_MAX})`);
  const total = scenes.reduce((a, s) => a + s.batches.reduce((b, x) => b + x.length, 0), 0) + FIXED_ENTITIES;
  if (total !== spec.entities) throw new Error(`class ${className}: generated ${total} entities, expected ${spec.entities}`);
  counts.total = total;
  return {
    generatorVersion: GENERATOR_VERSION,
    className,
    seed,
    spec,
    scenes,
    materials,
    effects,
    behaviors,
    buffers,
    model: KIT,
    player: { position: [0, 1, 0], size: [0.6, 1.8, 0.6] },
    spawn: [0, 1, 0],
    goal: [spec.scenes * SCENE_WIDTH - 20, 1, 0],
    camera: { position: [0, 4, 14], far: 300 },
    counts,
  };
}

/** A short digest of the plan's identity (class, seed, generator version) for cache keys. */
export function planKey(plan: Pick<BenchPlan, 'className' | 'seed' | 'generatorVersion'>): string {
  return `${plan.className}-s${plan.seed}-g${plan.generatorVersion}`;
}

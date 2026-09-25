/**
 * Phase 20.2: the effect executors harness (browser code, bundled by
 * `effects-gpu.e2e.ts`). One case per page load:
 *
 *   index.html?backend=webgl2|webgpu&case=parity|render
 *
 * - `parity` (WebGPU): neutral effect graphs run on the CPU reference
 *   (`EffectInstance`) and on the WebGPU compute executor with the same steps
 *   and origins; the GPU buffers are read back and compared particle by
 *   particle (by serial number): `window.__fx = { ok, cases: [{name, cpu,
 *   gpu, matched, maxPosError, meanPosError, maxColorError, maxSizeError}] }`.
 * - `render`: the effect player (the one Play and exports use) draws a burst
 *   of magenta additive billboards and a green alpha-blended cloud in front
 *   of a dark backdrop: `window.__fx = { ok, backend, diagnostics }` and the
 *   canvas shows them.
 */
import * as THREE from 'three/webgpu';

import { EffectInstance } from '@thirdlight/effects';
import { newEffectSystemGraph, type EffectDef, type GraphData, type GraphValue } from '@thirdlight/project-model';
import { createEffectsPlayer, createRenderer, GPU_STATE_FIELDS, GPU_STATE_STRIDE, GpuEffectExecutor, type RendererPreference } from '@thirdlight/three-adapter';

const q = new URLSearchParams(location.search);
const backend = (q.get('backend') ?? 'auto') as RendererPreference;
const which = q.get('case') ?? 'render';

type Block = { type: string; data?: Record<string, GraphValue>; id?: string };
type Wire = { from: string; port?: string; to: string; input: string };

function graph(chains: Partial<Record<'spawn' | 'initialize' | 'update' | 'output', Block[]>>, values: Block[] = [], wires: Wire[] = []): GraphData {
  const g = newEffectSystemGraph() as GraphData;
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks ?? []) {
      const id = b.id ?? `b${n++}`;
      g.nodes.push({ id, type: b.type, position: [200 * n, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      g.edges.push({ id: `e${g.edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  for (const v of values) g.nodes.push({ id: v.id!, type: v.type, position: [0, 900], ...(v.data !== undefined ? { data: v.data } : {}) });
  for (const w of wires) g.edges.push({ id: `e${g.edges.length}`, from: { node: w.from, port: w.port ?? 'value' }, to: { node: w.to, port: w.input } });
  return g;
}

function effect(id: string, systems: { graph: GraphData; space?: 'local' | 'world'; maxParticles?: number }[], extra: Partial<EffectDef> = {}): EffectDef {
  return {
    effectId: id,
    name: id,
    duration: 2,
    loop: true,
    seed: 7,
    bounds: { center: [0, 0, 0], size: [20, 20, 20] },
    systems: systems.map((s, i) => ({ systemId: `s${i}`, name: `S${i}`, maxParticles: s.maxParticles ?? 2000, space: s.space ?? 'local', graph: s.graph })),
    ...extra,
  };
}

/** The parity graphs: every GPU-supported block and value node at least once. */
const PARITY: { def: EffectDef; origin?: (t: number) => { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] } }[] = [
  {
    def: effect('fountain', [
      {
        graph: graph({
          spawn: [{ type: 'spawn.rate', data: { rate: 120 } }, { type: 'spawn.burst', data: { count: 40 } }],
          initialize: [{ type: 'init.position.sphere', data: { radius: 0.3 } }, { type: 'init.velocity.direction', data: { speedMin: 1, speedMax: 3 } }, { type: 'init.lifetime', data: { min: 0.8, max: 1.6 } }, { type: 'init.color.gradient' }, { type: 'init.size', data: { min: 0.05, max: 0.2 } }, { type: 'init.rotation', data: { angleMin: -90, angleMax: 90, spinMin: -60, spinMax: 60 } }],
          update: [{ type: 'update.gravity' }, { type: 'update.drag', data: { coefficient: 0.5 } }, { type: 'update.size.curve' }, { type: 'update.color.gradient' }, { type: 'update.collide.plane', data: { point: [0, -1, 0] } }],
          output: [{ type: 'output.billboard' }],
        }),
      },
    ]),
  },
  {
    def: effect('shapes', [
      {
        graph: graph({
          spawn: [{ type: 'spawn.rate', data: { rate: 90 } }],
          initialize: [{ type: 'init.position.box', data: { size: [2, 1, 3], surface: true } }, { type: 'init.velocity', data: { min: [-1, 0, -1], max: [1, 2, 1] } }, { type: 'init.lifetime', data: { min: 1, max: 2 } }, { type: 'init.mass', data: { min: 0.5, max: 2 } }],
          update: [{ type: 'update.vortex', data: { strength: 3, pull: 1 } }, { type: 'update.attractor', data: { position: [0, 2, 0], strength: 4, radius: 5 } }, { type: 'update.velocity.curve', data: { curve: [0, 3, 1, 1] } }, { type: 'update.kill.sphere', data: { center: [0, 0, 0], radius: 6, mode: 'outside' } }],
          output: [{ type: 'output.billboard' }],
        }),
      },
      {
        graph: graph({
          spawn: [{ type: 'spawn.burst', data: { count: 60, cycles: 0, interval: 0.5 } }],
          initialize: [{ type: 'init.position.cone', data: { radius: 0.2, angle: 30, axis: 'x' } }, { type: 'init.velocity.direction', data: { speedMin: 2, speedMax: 2 } }, { type: 'init.position.circle', data: { radius: 0.5, axis: 'z' } }, { type: 'init.position.line', data: { start: [0, 0, 0], end: [0, 1, 0] } }, { type: 'init.lifetime', data: { min: 1.2, max: 1.2 } }],
          update: [{ type: 'update.wind', data: { influence: 2 } }, { type: 'update.kill.box', data: { size: [4, 4, 4], mode: 'outside' } }, { type: 'update.kill.plane', data: { point: [0, -2, 0] } }, { type: 'update.kill.speed', data: { speed: 0.01 } }],
          output: [{ type: 'output.billboard' }],
        }),
      },
    ]),
  },
  {
    // World space, a moving origin (spawn over distance), turbulence, values wired into inputs, a parameter.
    def: effect(
      'trail-world',
      [
        {
          space: 'world',
          graph: graph(
            {
              spawn: [{ type: 'spawn.distance', data: { perMeter: 40 } }, { type: 'spawn.rate', data: { rate: 30 } }],
              initialize: [{ id: 'pt', type: 'init.position.point' }, { id: 'vel', type: 'init.velocity' }, { id: 'life', type: 'init.lifetime' }, { id: 'col', type: 'init.color' }, { id: 'size', type: 'init.size' }],
              update: [{ type: 'update.turbulence', data: { strength: 1.5, frequency: 0.7, octaves: 2 } }, { id: 'grav', type: 'update.gravity' }],
              output: [{ type: 'output.billboard' }],
            },
            [
              { id: 'rnd', type: 'value.random', data: { min: 0.5, max: 1.5 } },
              { id: 'rv', type: 'value.randomVec3', data: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] } },
              { id: 'curve', type: 'value.curve', data: { input: 'random' } },
              { id: 'grad', type: 'value.gradient', data: { input: 'effectTime' } },
              { id: 'mul', type: 'math.multiply' },
              { id: 'tint', type: 'value.parameter', data: { key: 'tint' } },
              { id: 'lerp', type: 'math.lerp' },
              { id: 'k', type: 'value.float', data: { value: 0.3 } },
              { id: 'attr', type: 'value.attribute', data: { attribute: 'position' } },
              { id: 'split', type: 'math.split' },
              { id: 'comb', type: 'math.combine' },
              { id: 'div', type: 'math.divide' },
              { id: 'len', type: 'math.length' },
              { id: 'time', type: 'value.time' },
              { id: 'sin', type: 'math.sine' },
              { id: 'one', type: 'math.oneMinus' },
              { id: 'vmax', type: 'math.max' },
              { id: 'nrm', type: 'math.normalize' },
            ],
            [
              { from: 'rnd', to: 'life', input: 'max' },
              { from: 'rv', to: 'vel', input: 'max' },
              { from: 'curve', to: 'mul', input: 'a' },
              { from: 'k', to: 'mul', input: 'b' },
              { from: 'mul', port: 'out', to: 'size', input: 'max' },
              { from: 'grad', to: 'lerp', input: 'a' },
              { from: 'tint', to: 'lerp', input: 'b' },
              { from: 'k', to: 'lerp', input: 't' },
              { from: 'lerp', port: 'out', to: 'col', input: 'color' },
              { from: 'attr', to: 'split', input: 'in' },
              { from: 'split', port: 'y', to: 'comb', input: 'x' },
              { from: 'time', port: 'normalized', to: 'sin', input: 'in' },
              { from: 'sin', port: 'out', to: 'one', input: 'in' },
              { from: 'one', port: 'out', to: 'comb', input: 'y' },
              { from: 'comb', port: 'out', to: 'div', input: 'a' },
              { from: 'rnd', to: 'div', input: 'b' },
              { from: 'div', port: 'out', to: 'nrm', input: 'in' },
              { from: 'nrm', port: 'out', to: 'vmax', input: 'a' },
              { from: 'vmax', port: 'out', to: 'grav', input: 'acceleration' },
              { from: 'attr', to: 'len', input: 'in' },
              { from: 'len', port: 'out', to: 'pt', input: 'offset' },
            ],
          ),
        },
      ],
      { parameters: [{ key: 'tint', type: 'color', default: '#20c0ff' }], seed: 1234 },
    ),
    origin: (t) => ({ position: [Math.sin(t * 2) * 3, 1 + t * 0.5, Math.cos(t * 2)], rotation: [0, Math.sin(t / 2), 0, Math.cos(t / 2)], scale: [1, 1, 1] }),
  },
];

const DT = 1 / 60;
const STEPS = 90;

async function readVec4(r: THREE.WebGPURenderer, node: { value: THREE.BufferAttribute }): Promise<Float32Array> {
  return new Float32Array(await r.getArrayBufferAsync(node.value as never));
}

async function parity(r: THREE.WebGPURenderer): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of PARITY) {
    const cpu = new EffectInstance(c.def, {});
    const gpu = new GpuEffectExecutor(c.def, { capacityLimit: 1 << 18, sortedSystems: new Set() });
    for (let k = 0; k < STEPS; k++) {
      const t = (k + 1) * DT;
      const input = c.origin !== undefined ? { origin: c.origin(t) } : {};
      cpu.step(DT, input);
      gpu.step(r, DT, input);
    }
    for (let si = 0; si < c.def.systems.length; si++) {
      const s = cpu.systems[si]!;
      const g = gpu.systems[si]!;
      // The interleaved state: 6 vec4 per slot (posAge, velLife, colour, initial colour, sizeRot, massRand).
      const state = await readVec4(r, g.buffers.state);
      const field = (k: number): Float32Array => {
        const out = new Float32Array(g.capacity * 4);
        for (let i = 0; i < g.capacity; i++) out.set(state.subarray((i * GPU_STATE_STRIDE + k) * 4, (i * GPU_STATE_STRIDE + k) * 4 + 4), i * 4);
        return out;
      };
      const posAge = field(GPU_STATE_FIELDS.posAge);
      const color = field(GPU_STATE_FIELDS.color);
      const sizeRot = field(GPU_STATE_FIELDS.sizeRot);
      const massRand = field(GPU_STATE_FIELDS.massRand);
      const serial = new Uint32Array(await r.getArrayBufferAsync(g.buffers.serial.value as never));
      const gpuBySerial = new Map<number, number>();
      for (let i = 0; i < g.capacity; i++) if (massRand[i * 4 + 2]! > 0.5) gpuBySerial.set(serial[i]!, i);
      let matched = 0;
      let maxPos = 0;
      let sumPos = 0;
      let maxCol = 0;
      let maxSize = 0;
      let within = 0;
      for (let i = 0; i < s.count; i++) {
        const j = gpuBySerial.get(s.serial[i]!);
        if (j === undefined) continue;
        matched += 1;
        const dp = Math.hypot(posAge[j * 4]! - s.position[i * 3]!, posAge[j * 4 + 1]! - s.position[i * 3 + 1]!, posAge[j * 4 + 2]! - s.position[i * 3 + 2]!);
        maxPos = Math.max(maxPos, dp);
        sumPos += dp;
        if (dp < 1e-2) within += 1;
        for (let a = 0; a < 4; a++) maxCol = Math.max(maxCol, Math.abs(color[j * 4 + a]! - s.color[i * 4 + a]!));
        maxSize = Math.max(maxSize, Math.abs(sizeRot[j * 4]! - s.size[i]!));
      }
      out.push({ name: `${c.def.effectId}/${si}`, cpu: s.count, gpu: gpuBySerial.size, matched, within, maxPosError: maxPos, meanPosError: matched > 0 ? sumPos / matched : 0, maxColorError: maxCol, maxSizeError: maxSize });
    }
    gpu.dispose();
  }
  return out;
}

/** A burst of magenta additive billboards (left) and a green alpha cloud (right), 10 s lifetimes, no forces. */
const RENDER_FX: EffectDef[] = [
  effect('burst', [
    {
      graph: graph({
        spawn: [{ type: 'spawn.burst', data: { count: 300 } }],
        initialize: [{ type: 'init.position.sphere', data: { radius: 1.2 } }, { type: 'init.lifetime', data: { min: 10, max: 10 } }, { type: 'init.color', data: { color: '#ff00ff' } }, { type: 'init.size', data: { min: 0.25, max: 0.35 } }],
        output: [{ type: 'output.billboard', data: { blend: 'additive' } }],
      }),
    },
  ], { loop: false, duration: 1 }),
  effect('cloud', [
    {
      graph: graph({
        spawn: [{ type: 'spawn.burst', data: { count: 200 } }],
        initialize: [{ type: 'init.position.box', data: { size: [2, 2, 2] } }, { type: 'init.lifetime', data: { min: 10, max: 10 } }, { type: 'init.color', data: { color: '#00ff40' } }, { type: 'init.size', data: { min: 0.3, max: 0.3 } }],
        output: [{ type: 'output.billboard', data: { blend: 'alpha', orient: 'velocity' } }],
      }),
    },
  ], { loop: false, duration: 1 }),
];

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const result: Record<string, unknown> = {};
(async () => {
  try {
    const handle = createRenderer({ canvas: canvas as never, preference: backend, source: 'default', antialias: false, clearColor: 0x101418, clearAlpha: 1 } as never);
    await handle.whenReady();
    const r = handle.current() as unknown as THREE.WebGPURenderer;
    result.backend = handle.info().api;
    if (which === 'debug') {
      const def = effect('dbg', [{ graph: graph({ spawn: [{ type: 'spawn.rate', data: { rate: 60 } }], initialize: [{ type: 'init.lifetime', data: { min: 10, max: 10 } }], output: [{ type: 'output.billboard' }] }) }]);
      const gpu = new GpuEffectExecutor(def, { capacityLimit: 64, sortedSystems: new Set() });
      const log: unknown[] = [];
      for (let k = 0; k < 30; k++) gpu.step(r, DT, {});
      for (let k = 0; k < 1; k++) {
        const g = gpu.systems[0]!;
        const serial = Array.from(new Uint32Array(await r.getArrayBufferAsync(g.buffers.serial.value as never))).slice(0, 12);
        const dc = new Int32Array(await r.getArrayBufferAsync(g.buffers.deadCount.value as never))[0];
        log.push({ plan: gpu.planner.plans()[0], serial, dc });
      }
      result.log = log;
    } else if (which === 'parity') {
      result.cases = await parity(r);
    } else {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#101418');
      const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 100);
      camera.position.set(0, 0, 9);
      camera.lookAt(0, 0, 0);
      const player = createEffectsPlayer({ scene, defs: RENDER_FX, loadTexture: async () => null });
      player.setRenderer(r, handle.info().api === 'webgpu' ? 'webgpu' : 'webgl2');
      const objectOf = (): undefined => undefined;
      player.request({ op: 'play', effectId: 'burst', handle: 1, entityId: null, position: [-2, 0, 0], params: null, source: 'script' }, objectOf);
      player.request({ op: 'play', effectId: 'cloud', handle: 2, entityId: null, position: [2, 0, 0], params: null, source: 'script' }, objectOf);
      player.request({ op: 'play', effectId: 'missing', handle: 3, entityId: null, position: [0, 0, 0], params: null, source: 'script' }, objectOf);
      for (let f = 0; f < 6; f++) {
        player.update(1 / 30, camera);
        r.render(scene, camera);
      }
      // The GPU particle count is read back every half second (asynchronously): wait for it.
      for (let tries = 0; tries < 40 && player.diagnostics().particles < 500; tries++) {
        for (let f = 0; f < 5; f++) player.update(1 / 30, camera);
        r.render(scene, camera);
        await new Promise((ok) => setTimeout(ok, 250));
      }
      result.diagnostics = player.diagnostics();
      result.probes = { burst: [Math.round(canvas.width * 0.3), Math.round(canvas.height / 2)], cloud: [Math.round(canvas.width * 0.72), Math.round(canvas.height / 2)] };
    }
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = String((e as Error)?.stack ?? e);
  }
  (window as unknown as { __fx: unknown }).__fx = result;
})();

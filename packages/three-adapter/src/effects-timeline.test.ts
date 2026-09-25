/**
 * Phase 20.3: the Effect tab's timeline (no GPU: the CPU executor draws into
 * node materials; the WebGPU executor's passes are recorded by a stub
 * renderer) — fixed steps, deterministic seek, restart, counters, disposal
 * (including the compute-only storage buffers). Neutral fixtures.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';

import type { EffectDefLike } from './effects-player';
import { GpuEffectExecutor } from './effects-gpu';
import { EffectTimeline } from './effects-timeline';

type Block = { type: string; data?: Record<string, unknown> };
function graph(chains: Partial<Record<'spawn' | 'initialize' | 'update' | 'output', Block[]>>): EffectDefLike['systems'][number]['graph'] {
  const nodes: { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }[] = ['spawn', 'initialize', 'update', 'output'].map((c) => ({ id: c, type: c, position: [0, 0] }));
  const edges: { id: string; from: { node: string; port: string }; to: { node: string; port: string } }[] = [];
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks ?? []) {
      const id = `b${n++}`;
      nodes.push({ id, type: b.type, position: [0, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  return { nodes, edges } as never;
}
/** 40 per second, 1.5 s lives, random positions in a sphere and random velocities (so determinism is not trivial). */
const STREAM: EffectDefLike = {
  effectId: 'stream',
  name: 'Stream',
  duration: 2,
  loop: true,
  seed: 7,
  bounds: { center: [0, 0, 0], size: [10, 10, 10] },
  systems: [
    {
      systemId: 'motes',
      name: 'Motes',
      maxParticles: 500,
      space: 'local',
      graph: graph({
        spawn: [{ type: 'spawn.rate', data: { rate: 40 } }],
        initialize: [{ type: 'init.position.sphere', data: { radius: 1 } }, { type: 'init.lifetime', data: { min: 1.5, max: 1.5 } }, { type: 'init.velocity', data: { min: [-1, 0, -1], max: [1, 2, 1] } }],
        update: [{ type: 'update.gravity' }],
        output: [{ type: 'output.billboard', data: { blend: 'additive' } }],
      }),
    },
  ],
};

function stubRenderer(): { r: THREE.WebGPURenderer; computes: unknown[]; freed: unknown[] } {
  const computes: unknown[] = [];
  const freed: unknown[] = [];
  const r = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    compute: (node: unknown) => void computes.push(node),
    getArrayBufferAsync: async () => new Int32Array([0]).buffer,
    // three's private attribute map (what `releaseStorage` frees compute-only buffers through).
    _attributes: { delete: (a: unknown) => void freed.push(a) },
  } as unknown as THREE.WebGPURenderer;
  return { r, computes, freed };
}
const camera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  c.position.set(0, 0, 20);
  c.lookAt(0, 0, 0);
  return c;
};
const make = (api: 'webgl2' | 'webgpu' = 'webgl2') => {
  const scene = new THREE.Scene();
  const stub = stubRenderer();
  const tl = new EffectTimeline({ scene, renderer: stub.r, api, def: STREAM, loadTexture: async () => null });
  return { scene, tl, ...stub };
};
const positions = (tl: EffectTimeline): number[] => [...((tl as unknown as { parts: { cpu: { systems: { position: Float32Array; count: number }[] } } }).parts.cpu.systems[0]!.position.slice(0, 40 * 3))];

describe('effect timeline (CPU executor)', () => {
  it('advances in fixed 1/60 s steps (the remainder carries), capped per call', () => {
    const { tl } = make();
    expect(tl.executor).toBe('cpu');
    expect(tl.advance(0.01)).toBe(0);
    expect(tl.advance(0.01)).toBe(1); // 0.02 s carried: one step
    expect(tl.advance(1)).toBe(8); // capped: a slow frame slows the preview
    expect(tl.stepCount).toBe(9);
    expect(tl.time).toBeCloseTo(9 / 60, 12);
  });

  it('seek re-simulates from the seed: the same t gives the same particles and counters, whatever came before', () => {
    const { tl } = make();
    tl.seek(1);
    expect(tl.stepCount).toBe(60);
    expect(tl.counters()).toEqual([{ systemId: 'motes', name: 'Motes', spawned: 40, living: 40 }]);
    const at1 = positions(tl);
    tl.seek(0.5);
    expect(tl.counters()[0]).toMatchObject({ spawned: 20, living: 20 });
    // Played there in uneven frames: the same state as a seek.
    tl.restart();
    for (const dt of [0.03, 0.05, 0.1, 0.017, 0.2, 0.3, 0.1, 0.2]) tl.advance(dt, 100);
    tl.advance(Math.max(0, 1 - tl.time + 1e-6), 100);
    expect(tl.stepCount).toBe(60);
    expect(positions(tl)).toEqual(at1);
    tl.seek(1);
    expect(positions(tl)).toEqual(at1);
    // Restart: time 0, nothing born.
    tl.restart();
    expect(tl.counters()[0]).toMatchObject({ spawned: 0, living: 0 });
    expect(tl.time).toBe(0);
    // Past the lifetime: born keeps counting, living settles at rate × lifetime (± the particle dying on this step's boundary).
    tl.seek(3);
    expect(tl.counters()[0]!.spawned).toBe(120);
    expect(Math.abs(tl.counters()[0]!.living! - 60)).toBeLessThanOrEqual(1);
  });

  it('draws into its scene and removes everything on dispose', () => {
    const { scene, tl } = make();
    tl.seek(1);
    tl.draw(camera());
    const group = scene.children.find((o) => o.name === 'effect stream');
    expect(group).toBeDefined();
    const mesh = group!.children[0] as THREE.Mesh;
    expect(mesh.count).toBe(40);
    tl.dispose();
    expect(scene.children.find((o) => o.name === 'effect stream')).toBeUndefined();
  });
});

describe('effect timeline (WebGPU executor, stub renderer)', () => {
  it('seek restarts the buffers and re-runs the compute passes; counters come from the reference planner', () => {
    const { tl, computes } = make('webgpu');
    expect(tl.executor).toBe('webgpu');
    tl.seek(1);
    // One reset pass, then per step an update pass and (40/s at 60 Hz: 2 of 3 steps) a spawn pass.
    expect(computes.length).toBe(1 + 60 + 40);
    expect(tl.counters()[0]).toMatchObject({ spawned: 40, living: null });
    computes.length = 0;
    tl.seek(0);
    expect(computes.length).toBe(1); // cleared at once: nothing of the old run is drawn at time 0
    expect(tl.counters()[0]!.spawned).toBe(0);
  });

  it('dispose frees the compute-only storage buffers on its renderer (three frees only buffers a geometry drew)', () => {
    const { r, freed } = stubRenderer();
    const gpu = new GpuEffectExecutor(STREAM, { capacityLimit: 1000, sortedSystems: new Set() });
    gpu.dispose(r);
    // Per system: state, serial numbers, free list, its count, 4 draw buffers; plus the shared noise table.
    expect(freed.filter((x) => x !== null && x !== undefined).length).toBe(9);
  });
});

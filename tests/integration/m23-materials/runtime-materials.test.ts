/**
 * Material parameters scripts set per object, through the
 * production game host in the page and in the simulation worker.
 *
 * A neutral scene: two boxes wear one graph material (a colour, a float and
 * a 4 × 4 data parameter). A script changes the first box's colour, the
 * second box's float and writes cells of the first box's grid at different
 * steps, then resets the colour. The values are simulation state: page and
 * worker give identical step digests, the digests move from the first write
 * on (and not before), and the renderer receives the same changes from both.
 */
import { describe, expect, it } from 'vitest';

import { materialCatalogOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
/** After the host's start steps (mount runs a few before the first digested step). */
const FIRST_WRITE = 42;

const MATERIALS = [
  {
    materialId: 'overlay',
    name: 'Overlay',
    shader: 'unlit',
    params: {},
    textures: {},
    parameters: [
      { key: 'tint', type: 'color', default: '#00ff00' },
      { key: 'amount', type: 'float', default: 0, min: 0, max: 1 },
      { key: 'cells', type: 'data', default: [0, 0, 0, 0], size: [4, 4] },
    ],
    graph: { nodes: [{ id: 'out', type: 'unlit', position: [0, 0] }], edges: [] },
  },
];

const PAINTER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const m = ctx.materials;
    const s = ctx.stepIndex;
    if (s < ${FIRST_WRITE} || s > 235) return;
    if (s % 7 === 0 && s < 200) m.set('box-a', 'tint', s % 14 === 0 ? '#ff0000' : '#0000ff');
    if (s === ${FIRST_WRITE}) m.set('box-b', 'tint', '#123456');
    if (s % 5 === 0) m.set('box-b', 'amount', (s % 50) / 50);
    if (s % 11 === 0) m.setData('box-a', 'cells', s % 4, (s >> 2) % 4, 1, 1, [s % 256, 0, 255 - (s % 256), 255]);
    if (s === 200) m.reset('box-a', 'tint');
  },
};
`;
const IDLE = 'export default { instantiate() { return {}; }, step() {} };';

function snapshot(): Any {
  const box = { size: [1, 1, 0.02], material: { color: '#ffffff' } };
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 0, 6]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 100 } } },
    { id: 'box-a', components: { transform: T([-1, 0, 0]), box, materials: { '*': 'overlay' } } },
    { id: 'box-b', components: { transform: T([1, 0, 0]), box, materials: { '*': 'overlay' } } },
    { id: 'painter-0001', components: { transform: T([0, -3, 0]), behavior: { behaviorId: 'painter', values: {} } } },
  ];
  return {
    snapshotId: 'mat@r1',
    projectId: 'mat',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
    materialCatalog: materialCatalogOf(MATERIALS as Any, []),
  };
}

async function run(mode: Mode, source: string, steps: number): Promise<{ h: Harness; digests: string[]; changes: Any[] }> {
  const mod = behaviorModule('painter', source);
  const h = await startHarness(mode, { snapshot: snapshot(), settings: SETTINGS, physics: null, digestSteps: true, behaviors: [mod] });
  const changes: Any[] = [];
  let now = 10;
  let i = 0;
  while (h.digests.length < steps) {
    const n = [1, 2, 0, 3, 1][i++ % 5]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
    // As the adapter does each frame: take what changed.
    for (const c of (h.rt as Any).takeMaterialChanges?.() ?? []) changes.push(c.op === 'data' ? { ...c, bytes: [...c.bytes] } : c);
  }
  const d = h.rt.getDiagnostics();
  if (d.ok && d.diagnostics.errors.length > 0) throw new Error(JSON.stringify(d.diagnostics.errors));
  return { h, digests: [...h.digests], changes };
}

/** The latest change per object, material and parameter (what the renderer ends up showing). */
function latest(changes: Any[]): Record<string, Any> {
  const out: Record<string, Any> = {};
  for (const c of changes) out[`${c.entityId}|${c.materialId}|${c.key}`] = c;
  return out;
}

describe('material parameters in the running game (page and worker)', () => {
  it('scripts set values per object; page and worker agree step by step and send the renderer the same changes', async () => {
    const STEPS = 240;
    const idle = await run('single', IDLE, STEPS);
    const page = await run('single', PAINTER, STEPS);
    const worker = await run('worker', PAINTER, STEPS);
    try {
      // The values are in the digest: identical before the first write, different from it on.
      const firstDiff = page.digests.findIndex((d, k) => d !== idle.digests[k]);
      // The step of the first digest (single mode: the last step minus the digested steps).
      const firstStep = (page.h.rt as Any).getDiagnostics().diagnostics.stepIndex - page.digests.length + 1;
      expect(firstStep).toBeLessThan(FIRST_WRITE);
      // ctx.stepIndex is the last committed step: a write at ctx.stepIndex n lands in step n + 1.
      expect(firstDiff).toBe(FIRST_WRITE + 1 - firstStep);
      // Page and worker agree at every step.
      const n = Math.min(page.digests.length, worker.digests.length);
      expect(n).toBeGreaterThanOrEqual(STEPS);
      expect(worker.digests.slice(0, n)).toEqual(page.digests.slice(0, n));
      // The renderer's view: the same final values from both, and none without the script.
      expect(idle.changes).toEqual([]);
      const a = latest(page.changes);
      const b = latest(worker.changes);
      expect(b).toEqual(a);
      // The colour was reset at step 200 (back to the authored value), the float is the last one set,
      // and the grid carries every written cell (16 cells × RGBA).
      expect(a['box-a|overlay|tint'].op).toBe('clear');
      expect(a['box-b|overlay|amount']).toMatchObject({ op: 'set', value: (235 % 50) / 50 });
      const grid = a['box-a|overlay|cells'];
      expect(grid.op).toBe('data');
      expect(grid.size).toEqual([4, 4]);
      expect(grid.bytes.length).toBe(64);
      const s = 231; // the last multiple of 11 before step 240
      const at = (((s >> 2) % 4) * 4 + (s % 4)) * 4;
      expect(grid.bytes.slice(at, at + 4)).toEqual([s % 256, 0, 255 - (s % 256), 255]);
      // box-b's colour was set once, its grid never.
      expect(a['box-b|overlay|tint']).toMatchObject({ op: 'set', value: '#123456' });
      expect(a['box-b|overlay|cells']).toBeUndefined();
      // The page runtime's own state (the worker keeps it in the worker).
      expect((page.h.rt as Any).materialState()).toContain('box-a|overlay|cells#');
    } finally {
      await idle.h.dispose();
      await page.h.dispose();
      await worker.h.dispose();
    }
  }, 180_000);
});

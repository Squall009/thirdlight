/**
 * Lit particles as bench data (`--particles` in light-shots, `--particles N` in headroom): the smallest lit particle
 * effects, made in the project before Play and deleted after, as the lamps are; nothing in the generators.
 *
 * - **The lit panel**: one grey billboard 1.2 m across, opaque, `shading: lit`, standing still: light-shots puts one
 *   2.5 m in front of each of the four near cameras (street at noon, the room, the cave, night with lamps), so the
 *   picture's middle is the panel and its colour is how the panel is lit there (`panelLight`).
 * - **The lit smoke**: a puff of grey billboards (30 a second, 4 s lives, 0.5–0.8 m, alpha blended, `shading: lit`)
 *   in a 0.8 m ball: headroom puts N of them in a cluster round the town square 20 m up, in front of its orbiting
 *   camera, for the `effects` pass's cost.
 *
 * Engine-owned test data for measuring, not a product feature.
 */
import type { LightingCamera } from './lighting-cameras';

export const BENCH_PANEL_EFFECT = 'bench-lit-panel';
export const BENCH_SMOKE_EFFECT = 'bench-lit-smoke';
/** Bench particle objects' names start with this (a run's leftovers are found by it). */
export const BENCH_PARTICLE_PREFIX = 'BFX ';
/** Metres in front of a camera its panel stands. */
const PANEL_AHEAD_M = 2.5;

type Block = { type: string; data?: Record<string, unknown> };
/** A system graph of the four contexts, each a chain of blocks. */
function graph(chains: Record<string, Block[]>): { nodes: unknown[]; edges: unknown[] } {
  const nodes: { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }[] = ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] }));
  const edges: unknown[] = [];
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks) {
      const id = `b${n++}`;
      nodes.push({ id, type: b.type, position: [250 * n, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  return { nodes, edges };
}

/** The two effects (`setEffect` values). */
export const BENCH_PARTICLE_EFFECTS: readonly Record<string, unknown>[] = Object.freeze([
  {
    effectId: BENCH_PANEL_EFFECT,
    name: 'Bench lit panel',
    duration: 2,
    loop: true,
    seed: 3,
    bounds: { center: [0, 0, 0], size: [2, 2, 2] },
    systems: [{ systemId: 'panel', name: 'Panel', maxParticles: 1, space: 'local', graph: graph({ spawn: [{ type: 'spawn.burst', data: { count: 1 } }], initialize: [{ type: 'init.lifetime', data: { min: 1000, max: 1000 } }, { type: 'init.color', data: { color: '#a0a0a0' } }, { type: 'init.size', data: { min: 1.2, max: 1.2 } }], output: [{ type: 'output.billboard', data: { blend: 'opaque', shading: 'lit' } }] }) }],
  },
  {
    effectId: BENCH_SMOKE_EFFECT,
    name: 'Bench lit smoke',
    duration: 4,
    loop: true,
    seed: 5,
    bounds: { center: [0, 0, 0], size: [3, 3, 3] },
    systems: [{ systemId: 'smoke', name: 'Smoke', maxParticles: 160, space: 'local', graph: graph({ spawn: [{ type: 'spawn.rate', data: { rate: 30 } }], initialize: [{ type: 'init.position.sphere', data: { radius: 0.8 } }, { type: 'init.lifetime', data: { min: 4, max: 4 } }, { type: 'init.color', data: { color: '#b4b4b4' } }, { type: 'init.size', data: { min: 0.5, max: 0.8 } }], output: [{ type: 'output.billboard', data: { blend: 'alpha', shading: 'lit' } }] }) }],
  },
]);

/** Where a camera's panel stands: `PANEL_AHEAD_M` along its view (yaw 0 looks along −z, pitch down). */
export function panelPlace(c: Pick<LightingCamera, 'eye' | 'yaw' | 'pitch'>): [number, number, number] {
  const h = Math.cos(c.pitch) * PANEL_AHEAD_M;
  return [c.eye[0] - Math.sin(c.yaw) * h, c.eye[1] - Math.sin(c.pitch) * PANEL_AHEAD_M, c.eye[2] - Math.cos(c.yaw) * h];
}

/** The smoke cluster of headroom's `--particles N`: N puffs within 3 m of the town square's column, 17–21 m up. */
export function smokePlaces(n: number): Array<[number, number, number]> {
  return Array.from({ length: n }, (_, i) => [((0.5 + i * 0.819172513) % 1) * 6 - 3, 17 + ((0.5 + i * 0.549700478) % 1) * 4, ((0.5 + i * 0.671043607) % 1) * 6 - 3]);
}

/** Entity values (for `pasteEntities`) of an effect at each place. */
export function particleEntities(effectId: string, places: readonly (readonly [number, number, number])[], tag: string): Record<string, unknown>[] {
  return places.map((p, i) => ({ id: `bench-fx-${tag}-${i}`, name: `${BENCH_PARTICLE_PREFIX}${tag} ${i + 1}`, components: { transform: { position: [...p], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, effect: { effectId } } }));
}

/** Makes the effects and puts the objects in the project (taking out any a stopped run left); gives back what takes them out. */
export async function placeBenchParticles(entities: Record<string, unknown>[], command: (op: string, args: Record<string, unknown>) => Promise<void>, scene: () => Array<{ id: string; name: string }>): Promise<() => Promise<void>> {
  const clear = async (): Promise<number> => {
    const ids = scene().filter((x) => x.name.startsWith(BENCH_PARTICLE_PREFIX)).map((e) => e.id);
    if (ids.length > 0) await command('deleteEntity', { entityId: ids[0]!, ...(ids.length > 1 ? { entityIds: ids.slice(1) } : {}) });
    return ids.length;
  };
  await clear();
  for (const e of BENCH_PARTICLE_EFFECTS) await command('setEffect', { effect: e });
  await command('pasteEntities', { entities, sceneId: 'scene-main' });
  console.log(`bench particles: ${entities.length} placed`);
  return async () => {
    const n = await clear();
    for (const e of BENCH_PARTICLE_EFFECTS) await command('deleteEffect', { effectId: e['effectId'] }).catch((err: unknown) => console.error(`${String(e['effectId'])} not deleted: ${String(err)}`));
    console.log(`bench particles: ${n} taken out`);
  };
}

/** The mean colour (0–255) of a picture's middle `size` × `size` pixels: what the panel in front of the camera shows. */
export function middleColour(img: { width: number; height: number; pixel(x: number, y: number): [number, number, number, number] }, size = 40): { r: number; g: number; b: number; lum: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const x0 = (img.width - size) >> 1;
  const y0 = (img.height - size) >> 1;
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) {
    const p = img.pixel(x, y);
    r += p[0];
    g += p[1];
    b += p[2];
  }
  const n = size * size;
  const f = (v: number): number => Number((v / n).toFixed(2));
  return { r: f(r), g: f(g), b: f(b), lum: f(0.2126 * r + 0.7152 * g + 0.0722 * b) };
}

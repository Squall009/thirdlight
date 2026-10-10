/**
 * Opt-in (TL_PERF=1): what a run's start costs the 3D physics port on a large
 * world, without a browser. Every run, the first included, rebuilds the
 * world from the colliders the port holds (`restartWorld`), so its time is
 * paid at the first step and at every restart, and the port keeps what it
 * needs to rebuild for the life of the world.
 *
 *   TL_PERF=1 node --expose-gc node_modules/vitest/vitest.mjs run tests/perf/run-start.test.ts
 *
 * The world: a block layer of 512 × 6 × 512 one-metre cells with stepped hills
 * (1,024 chunks, one triangle mesh each, as the runtime's grid builds them) and a
 * 4 × 4 terrain of 257² tiles at 1 m (16 heightfields), all at once (a streamed
 * world holds only its collision ring's share), made as the runtime makes it
 * (`physics3DConfigOf`). Measured: the port's creation, the first run's start
 * (the first build), a restart (median of 5), and the JS heap the port keeps
 * once the caller let go of its colliders. The numbers go to
 * ~/.cache/thirdlight-perf/run-start.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, collisionMeshChunk, type BlockType } from '@thirdlight/project-model';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier/3d';
import { physics3DConfigOf, terrainColliderPieces } from '@thirdlight/runtime';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'run-start.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
type Any = any;
const gc = (globalThis as { gc?: () => void }).gc;
const heapMiB = (): number => {
  gc?.();
  gc?.();
  return Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;
};

const SIDE = 512;
const TYPES = new Map<string, BlockType>([['rock', { blockId: 'rock', name: 'Rock', shape: 'full', variants: [{ color: '#808080' }] } as unknown as BlockType]]);

/** The block layer's chunk meshes as the runtime's grid adds them. */
function blockColliders(): Any[] {
  const layer = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [SIDE, 6, SIDE] } };
  const g = new BlockGrid(layer as Any);
  const edits: Any[] = [];
  for (let x = 0; x < SIDE; x += 8) for (let z = 0; z < SIDE; z += 8) edits.push({ kind: 'fill', box: [x, 0, z, x + 8, 1 + ((x * 7 + z * 13) >> 5) % 5, z + 8], cell: { block: 'rock' } });
  applyBlockEdits(g, edits, { types: TYPES as Any, stamps: new Map() });
  const out: Any[] = [];
  for (let cx = 0; cx < SIDE / 16; cx++)
    for (let cz = 0; cz < SIDE / 16; cz++)
      collisionMeshChunk(g, cx, cz, TYPES as Any).forEach((p, i) => out.push({ entityId: `blocks-0001#${cx},${cz}#${i}`, shape: { type: 'mesh', vertices: p.vertices, indices: p.indices }, position: { x: 600, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }));
  return out;
}

/** The terrain's tiles as the runtime's terrain colliders add them. */
function terrainColliders(): Any[] {
  const out: Any[] = [];
  const s = 257;
  for (let tx = 0; tx < 4; tx++)
    for (let tz = 0; tz < 4; tz++) {
      const heights = new Uint16Array(s * s);
      for (let z = 0; z < s; z++) for (let x = 0; x < s; x++) heights[z * s + x] = Math.round(20000 + 8000 * Math.sin((tx * 256 + x) / 37) * Math.cos((tz * 256 + z) / 53));
      terrainColliderPieces({ samples: s, heights, holes: null }, 1, [-64, 192]).forEach((p, i) => out.push({ entityId: `terrain-0001#${tx},${tz}#${i}`, shape: p.shape, position: { x: tx * 256 + p.x, y: 0, z: tz * 256 + p.z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }));
    }
  return out;
}

describe.skipIf(!ON)('run start on a large 3D world', () => {
  it('measures the rebuild and what the port keeps for it', async () => {
    const base = heapMiB();
    let statics: Any[] | null = [...blockColliders(), ...terrainColliders()];
    const triangles = statics.filter((s) => s.shape.type === 'mesh').reduce((n, s) => n + s.shape.indices.length / 3, 0);
    const withSpecs = heapMiB();
    let t0 = performance.now();
    const player = { id: 'player-0001', components: { transform: { position: [10, 40, 10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, controller: {} } };
    const made = await createPhysicsPort3D({ ...(physics3DConfigOf([player] as Any, { physics_dimension: 3, gravity_y: -20, run_speed: 4, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 }) as Any), statics });
    const create = performance.now() - t0;
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const port = made.port;
    const colliders = statics.length;
    statics = null;
    // The first run's start: a world made for a run builds its statics here, once.
    t0 = performance.now();
    port.restartWorld();
    const firstStart = performance.now() - t0;
    const kept = heapMiB();
    const rebuilds: number[] = [];
    for (let i = 0; i < 5; i++) {
      t0 = performance.now();
      port.restartWorld();
      rebuilds.push(performance.now() - t0);
    }
    rebuilds.sort((a, b) => a - b);
    const afterRebuilds = heapMiB();
    const line = JSON.stringify({ colliders, triangles, specsMiB: Math.round((withSpecs - base) * 10) / 10, createMs: Math.round(create), firstStartMs: Math.round(firstStart), restartMs: Math.round(rebuilds[2]!), restartMinMs: Math.round(rebuilds[0]!), portKeepsMiB: Math.round((kept - base) * 10) / 10, afterRestartsMiB: Math.round((afterRebuilds - base) * 10) / 10, gc: gc !== undefined });
    record(line);
    expect(rebuilds.length).toBe(5);
    port.dispose();
  }, 600_000);
});

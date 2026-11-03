/**
 * The voxel world page's inspection hooks for the assembly and collision
 * proof: what a cell is (its stored voxel, the class the assembly rules
 * resolve for it, and what every consumer of its chunk's derived data
 * received), the derived results around a chunk and whether any is stale
 * against a fresh derive of the store, the region files' tags, and bodies
 * dropped and swept against the page's physics, drawn where they stop.
 */
import * as THREE from 'three';
import { crc32 } from '@thirdlight/shared';
import {
  ASSEMBLY_CLASS,
  buildApron,
  cellOutputs,
  chunkOf,
  CLASS_MASK,
  deriveSectionFromStore,
  encodeDerived,
  jobRadius,
  localOf,
  WORLD_RULES,
  resolvedClassAt,
  RUN_X,
  RUN_Z,
  voxel,
  VOXEL_SIZE_M,
  type ChunkGrid,
  type FloatingOrigin,
  type VoxelStreamer,
} from '@thirdlight/voxel';
import type { VoxelCollision } from './collision';

type Cell = [number, number, number];

const CLASS_NAMES = new Map<number, string>(Object.entries(ASSEMBLY_CLASS).map(([name, k]) => [k, name]));

/** A resolved cell byte as a name: wall, ground, beam, rail, post, liquid, empty. */
function className(r: number): string {
  const k = r & CLASS_MASK;
  if (k === ASSEMBLY_CLASS.rail && (r & RUN_X) !== 0 && (r & RUN_Z) !== 0) return 'post';
  return CLASS_NAMES.get(k) ?? `class ${k}`;
}

export interface ProbeContext {
  readonly streamer: VoxelStreamer;
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  readonly collision: VoxelCollision | null;
  readonly scene: THREE.Scene;
  /** Region files by name → tag, as the page knows them now. */
  readonly files: ReadonlyMap<string, string | null>;
}

export function assemblyProbes(ctx: ProbeContext): Record<string, (...args: never[]) => unknown> {
  const { streamer, grid, origin, collision } = ctx;
  /** Derived results are per section: windows, hashes and cells are read in section coordinates. */
  const sections = streamer.sections;
  const per = grid.edge / sections.edge;
  const v = voxel();
  const markers = new THREE.Group();
  ctx.scene.add(markers);

  /**
   * A section derived afresh in this thread from the store as it is now,
   * as the streamer's hash would be (0: in an air chunk with only air
   * around, which a derive skips). Compared with the streamer's result, it
   * shows whether that result is stale.
   */
  function freshHash(sx: number, sy: number, sz: number): number {
    const store = streamer.overlay;
    const [cx, cy, cz] = [Math.floor(sx / per), Math.floor(sy / per), Math.floor(sz / per)];
    if (store.chunkForm(cx, cy, cz) === 'absent') {
      const apron = buildApron(store, cx, cy, cz, jobRadius(WORLD_RULES));
      if (apron.dense.every((d, k) => d === 0 && apron.uniform[k] === 0)) return 0;
    }
    return crc32(encodeDerived(deriveSectionFromStore(store, sections, sx, sy, sz, WORLD_RULES)));
  }

  /** The derived sections within `r` sections of (cx, cy, cz) (section coordinates): their hashes by "x,y,z" (null: not derived). */
  function windowHashes(cx: number, cy: number, cz: number, r: number): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) out[`${cx + dx},${cy + dy},${cz + dz}`] = streamer.derivedOf(cx + dx, cy + dy, cz + dz)?.hash ?? null;
    return out;
  }

  function marker(geo: THREE.BufferGeometry, colour: number, at: readonly number[]): void {
    const o = origin.origin;
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: colour }));
    m.position.set((at[0]! - o.x) * VOXEL_SIZE_M, (at[1]! - o.y) * VOXEL_SIZE_M, (at[2]! - o.z) * VOXEL_SIZE_M);
    markers.add(m);
  }

  function physics(): VoxelCollision {
    if (collision === null) throw new Error('collision is off (?collision=0)');
    return collision;
  }

  return {
    /** Starts the body add/remove timings afresh (a measured run's own churn, without the cold fill's). */
    clearCollisionTimes(): void {
      physics().addMs.clear();
      physics().removeMs.clear();
    },
    /** What a cell is: its stored voxel, the class the assembly resolves for it, and what every consumer received (null: chunk not derived). */
    cellAt(x: number, y: number, z: number): Record<string, unknown> {
      streamer.voxelAt(x, y, z, v);
      const d = streamer.derivedOf(chunkOf(sections, x), chunkOf(sections, y), chunkOf(sections, z))?.assembly ?? null;
      return {
        voxel: { material: v.material, role: v.role, shape: v.shape, wetness: v.wetness },
        resolved: className(resolvedClassAt(streamer.overlay, WORLD_RULES, x, y, z)),
        outputs: d === null ? null : cellOutputs(d, localOf(sections, x), localOf(sections, y), localOf(sections, z)),
      };
    },
    windowHashes,
    /** Sections within `r` of (cx, cy, cz) (section coordinates) whose derived result differs from a fresh derive of the store now (stale ones). */
    staleAgainstFresh(cx: number, cy: number, cz: number, r: number): { checked: number; stale: string[] } {
      const stale: string[] = [];
      let checked = 0;
      for (const [k, h] of Object.entries(windowHashes(cx, cy, cz, r))) {
        if (h === null) continue;
        const [a, b, c] = k.split(',').map(Number) as Cell;
        checked++;
        if (freshHash(a, b, c) !== h) stale.push(k);
      }
      return { checked, stale };
    },
    /** The region files and their tags now. */
    files(): Record<string, string | null> {
      return Object.fromEntries(ctx.files);
    },
    /** Drops a capsule (metres) with its lowest point at `feet` (cells); where it rests is marked. */
    drop(feet: Cell, radiusM: number, halfHeightM: number): unknown {
      const r = physics().dropCapsule(feet, radiusM, halfHeightM);
      marker(new THREE.CapsuleGeometry(radiusM, halfHeightM * 2, 4, 12), 0xf0a020, [r.feet[0], r.feet[1] + (radiusM + halfHeightM) / VOXEL_SIZE_M, r.feet[2]]);
      return r;
    },
    /** Sweeps a sphere (radius metres) from `from` (cells) along `dir` up to `maxM`; where it stops is marked. */
    sweep(from: Cell, dir: Cell, radiusM: number, maxM: number): unknown {
      const r = physics().castSphere(from, dir, radiusM, maxM);
      const len = Math.hypot(...dir);
      const end = r?.centre ?? from.map((f, a) => f + (dir[a]! / len) * (maxM / VOXEL_SIZE_M));
      marker(new THREE.SphereGeometry(radiusM, 16, 12), r === null ? 0x30c0f0 : 0xe04040, end);
      return r;
    },
    clearMarkers(): void {
      for (const m of [...markers.children] as THREE.Mesh[]) {
        markers.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}

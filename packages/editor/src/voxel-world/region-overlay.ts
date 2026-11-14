/**
 * The voxel world page's open regions (open-region-stitch.ts, stitched on
 * this page's thread where its streamer runs) and a tint overlay to see
 * them: the surfaces round each enclosed region in a hue of its own, those
 * round a region that is not complete and not under sky in grey, and the
 * faces of each portal (door and window openings) in cyan. Outdoors is not
 * tinted. The overlay is built from the stitch within a box of chunks round
 * the camera's target when it is on and the regions changed, at most twice a
 * second, and drawn as one unlit mesh slightly inside the open cells.
 * `?regions=1` starts with the overlay on. The stitching runs in a frame
 * callback of its own, from every chunk already derived when it is made.
 */
import * as THREE from 'three';
import { frameSliceMs } from '@thirdlight/shared';
import { OpenRegionStitch, VOXEL_SIZE_M, type ChunkGrid, type FloatingOrigin, type VoxelStreamer } from '@thirdlight/voxel';

/** Chunks round the target the overlay covers (each way, horizontally; vertically half that). */
const OVERLAY_CHUNKS = 3;
/** The least ms between two overlay builds. */
const OVERLAY_REBUILD_MS = 500;
/** How far inside the open cell a tinted face is drawn (metres), so it sits in front of the surface it tints. */
const OVERLAY_INSET_M = 0.02;

/** Unit quads per face direction (−x, +x, −y, +y, −z, +z): four corners in the cell's [0, 1]³. */
const FACE_QUADS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
  [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]],
  [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]],
];
const FACE_DIRS: ReadonlyArray<readonly [number, number, number]> = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

/** An enclosed region's colour: warm hues apart by id (a golden-ratio step), so neighbouring rooms differ. */
function regionColour(id: number, out: THREE.Color): THREE.Color {
  const h = (0.02 + ((id * 0.618034) % 1) * 0.3) % 1;
  return out.setHSL(h, 0.85, 0.5);
}

export interface PageRegions {
  readonly stitch: OpenRegionStitch;
  /** The page hooks: counts, a cell's region, the overlay switch and what it drew. */
  hooks(): Record<string, unknown>;
}

type Cells = { readonly x: number; readonly y: number; readonly z: number };

export function pageRegions(opts: { readonly streamer: VoxelStreamer; readonly grid: ChunkGrid; readonly origin: FloatingOrigin; readonly scene: THREE.Scene; readonly target: Cells; readonly on: boolean }): PageRegions {
  const { streamer, grid, origin, scene } = opts;
  const stitch = new OpenRegionStitch(streamer);
  streamer.on((e) => {
    if (e.type === 'unloaded' || (e.type === 'chunk' && !e.shaderOnly && !e.reliefOnly)) stitch.touch(e.cx, e.cy, e.cz);
  });
  // What was derived before the stitching was made: its chunks, once each.
  const per = grid.edge / streamer.sections.edge;
  for (const d of streamer.derivedChunks()) stitch.touch(Math.floor(d.cx / per), Math.floor(d.cy / per), Math.floor(d.cz / per));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene.add(mesh);
  let on = opts.on;
  let builtAt = -Infinity;
  let builtChanges = -1;
  let builtRebases = -1;
  let builtTarget = '';
  const drawn = { faces: 0, enclosed: 0, unknown: 0, portal: 0, regions: 0, buildMs: 0 };
  const colour = new THREE.Color();

  function build(target: { readonly x: number; readonly y: number; readonly z: number }): void {
    const t0 = performance.now();
    const c = [target.x >> grid.shift, target.y >> grid.shift, target.z >> grid.shift] as const;
    const v = OVERLAY_CHUNKS;
    const h = Math.max(1, v >> 1);
    const pos: number[] = [];
    const col: number[] = [];
    const ids = new Set<number>();
    const counts = { enclosed: 0, unknown: 0, portal: 0 };
    const o = origin.origin;
    stitch.tintFaces([c[0] - v, c[1] - h, c[2] - v], [c[0] + v, c[1] + h, c[2] + v], (x, y, z, face, id, kind) => {
      counts[kind]++;
      ids.add(id);
      if (kind === 'portal') colour.setRGB(0.1, 0.95, 1);
      else if (kind === 'unknown') colour.setRGB(0.55, 0.55, 0.55);
      else regionColour(id, colour);
      const d = FACE_DIRS[face]!;
      const quad = FACE_QUADS[face]!;
      // The face shared with the neighbour, moved back into this cell by the inset.
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const q = quad[k]!;
        pos.push((x - o.x + q[0]) * VOXEL_SIZE_M - d[0] * OVERLAY_INSET_M, (y - o.y + q[1]) * VOXEL_SIZE_M - d[1] * OVERLAY_INSET_M, (z - o.z + q[2]) * VOXEL_SIZE_M - d[2] * OVERLAY_INSET_M);
        col.push(colour.r, colour.g, colour.b);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    mesh.geometry.dispose();
    mesh.geometry = g;
    Object.assign(drawn, { faces: pos.length / 18, ...counts, regions: ids.size, buildMs: Number((performance.now() - t0).toFixed(2)) });
  }

  /** Stitches what arrived (the derive slice) and rebuilds the overlay when due. */
  function update(target: Cells): void {
    if (stitch.pending) stitch.update(frameSliceMs('voxelDerive'));
    mesh.visible = on;
    if (!on) return;
    const now = performance.now();
    const key = `${target.x >> grid.shift},${target.y >> grid.shift},${target.z >> grid.shift}`;
    const due = stitch.changes !== builtChanges || origin.rebases !== builtRebases || key !== builtTarget;
    if (!due || now - builtAt < OVERLAY_REBUILD_MS) return;
    builtAt = now;
    builtChanges = stitch.changes;
    builtRebases = origin.rebases;
    builtTarget = key;
    build(target);
  }
  const frame = (): void => {
    update(opts.target);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    stitch,
    hooks: () => ({
      regions: {
        /** Counts over what is stitched (regions, enclosed, portals, pieces). */
        stats: () => stitch.stats(),
        /** The region or portal of a world cell (null: solid or not stitched). */
        at: (x: number, y: number, z: number) => stitch.regionAt(x, y, z),
        /** The tint overlay on or off; what it drew last. */
        overlay(show: boolean): void {
          on = show;
          builtChanges = -1;
          builtAt = -Infinity;
        },
        drawn: () => ({ on, ...drawn }),
        bytes: () => stitch.bytes,
      },
    }),
  };
}

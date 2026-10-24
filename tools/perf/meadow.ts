/**
 * The meadow perf class: neutral, generated content shaped like an open
 * field a game would cover in grass — a 1 × 1 km terrain of rolling hills
 * wearing the level classes' four-layer material, blended by painted
 * patches, and a ground-cover rule of tall blade clumps over it (the
 * stand-in clump of village-assets.ts `clumpKitGlb`: about 60, 20 and 6
 * triangles a level), seen at eye height from a corner hill across the field
 * to its far edge.
 *
 * The cover rule thins on the layers that are not grass and on steep ground,
 * so the layer weights and slope the cover reads are exercised. Its density
 * and reach are options: the class as recorded uses {@link MEADOW_SPEC}.
 *
 * Also here: the GPU density sweep's configurations (rings of clumps drawn
 * by a plain three.js probe page, tools/perf/bare/grass.js) and the budget
 * proposed from its rows.
 */
import { EYE_HEIGHT_M, prng } from './generate';

export const MEADOW_VERSION = 1;
export const MEADOW_SEED = 40;

export const MEADOW_SPEC = {
  /** Tiles per side, samples per tile side, metres between samples: 2 × 512 m = 1024 m square. */
  terrain: { tiles: 2, tileSamples: 257, spacing: 2, heightRange: [-16, 48] as [number, number] },
  /** Painted patches of the three other layers over layer 0 (the grass layer). */
  patches: 48,
  /**
   * The grass the class is recorded with: clumps of about a dozen blades (0.5–0.8 m) at 8 a square metre is a
   * closed sward of some hundred blades a square metre, out to 60 m, where tall grass in an open-world game
   * still reads as a field.
   */
  grass: { density: 8, coverDistance: 60, clumpHeight: 0.8 },
  /** The camera's far plane (m): past the far corner. */
  farPlane: 2000,
} as const;

/** The terrain's side (m). */
export const MEADOW_SIDE = MEADOW_SPEC.terrain.tiles * (MEADOW_SPEC.terrain.tileSamples - 1) * MEADOW_SPEC.terrain.spacing;

/** The terrain object's position: tile [0, 0]'s min corner, the field centred on the origin. */
export const meadowOrigin = (): [number, number, number] => [-MEADOW_SIDE / 2, 0, -MEADOW_SIDE / 2];

/** Ground height (m) at world (x, z): long rolling hills with smaller swells on them. */
export function meadowHeight(x: number, z: number): number {
  return 12 + 10 * Math.sin(x / 97 + 0.4) * Math.cos(z / 131) + 6 * Math.sin(x / 53 + z / 71) + 1.2 * Math.sin(x / 11.3) * Math.cos(z / 13.7);
}

/** Samples per side of the whole terrain. */
export const meadowSamples = (): number => MEADOW_SPEC.terrain.tiles * (MEADOW_SPEC.terrain.tileSamples - 1) + 1;

/** The terrain's heights in metres, row-major (rows +z), one per sample. */
export function meadowHeights(): Float32Array {
  const T = MEADOW_SPEC.terrain;
  const side = meadowSamples();
  const [x0, , z0] = meadowOrigin();
  const out = new Float32Array(side * side);
  for (let j = 0; j < side; j += 1) for (let i = 0; i < side; i += 1) out[j * side + i] = meadowHeight(x0 + i * T.spacing, z0 + j * T.spacing);
  return out;
}

/** The heights as a RAW heightmap (16-bit little-endian steps of the height range), as `editTerrain` imports. */
export function meadowTerrainRaw(heights: Float32Array = meadowHeights()): Uint8Array {
  const [lo, hi] = MEADOW_SPEC.terrain.heightRange;
  const out = new Uint8Array(heights.length * 2);
  const dv = new DataView(out.buffer);
  for (let k = 0; k < heights.length; k += 1) dv.setUint16(k * 2, Math.max(0, Math.min(65535, Math.round(((heights[k]! - lo) / (hi - lo)) * 65535))), true);
  return out;
}

/** The painted patches: layer (1–3), centre (world x, z), radius (m) and strength; layer 0 elsewhere. */
export function meadowPaint(seed = MEADOW_SEED): { layer: number; at: [number, number]; radius: number; strength: number }[] {
  const rnd = prng(seed * 7919 + 5);
  const half = MEADOW_SIDE / 2;
  const out: { layer: number; at: [number, number]; radius: number; strength: number }[] = [];
  for (let i = 0; i < MEADOW_SPEC.patches; i += 1) {
    const at: [number, number] = [Math.round((rnd() * 2 - 1) * half * 0.95), Math.round((rnd() * 2 - 1) * half * 0.95)];
    out.push({ layer: 1 + (i % 3), at, radius: Math.round(15 + rnd() * 75), strength: Math.round((0.5 + rnd() * 0.5) * 100) / 100 });
  }
  return out;
}

/** The kit the class's grass comes from, and its piece. */
export const MEADOW_KIT = 'meadow-grass';
export const MEADOW_PIECE = 'clump';

/** The meadow's cover rule: clumps on the grass layer's share and gentle ground, thinning to nothing at `coverDistance`. */
export function meadowCoverRule(density: number = MEADOW_SPEC.grass.density, coverDistance: number = MEADOW_SPEC.grass.coverDistance): Record<string, unknown> {
  return { id: 'grass', asset: { assetId: MEADOW_KIT, piece: MEADOW_PIECE }, density, scale: [0.8, 1.3], align: 0.5, layers: [{ layer: 0, min: 0.4, fade: 0.2 }], slope: { max: 35, fade: 5 }, cover: true, coverDistance };
}

/** A rotation turning three's -z view to `yaw` (about +y, from -z towards -x) and tilting it by `pitch` (up positive). */
export function yawPitchQuat(yaw: number, pitch: number): [number, number, number, number] {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2);
  const sx = Math.sin(pitch / 2);
  // + 0: no negative zero in the data.
  const r = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;
  return [r(cy * sx), r(sy * cx), r(-sy * sx), r(cy * cx)];
}

/** The class's view: eye height near the south-west corner, looking across the field to the far (north-east) corner, a little down. */
export function meadowCamera(): { position: [number, number, number]; rotation: [number, number, number, number]; yaw: number; pitch: number } {
  const x = -MEADOW_SIDE / 2 + 60;
  const z = MEADOW_SIDE / 2 - 60;
  // Towards (+x, -z): three looks down -z, so turning towards +x is a negative yaw.
  const yaw = -Math.PI / 4;
  const pitch = -0.08;
  return { position: [x, Math.round((meadowHeight(x, z) + EYE_HEIGHT_M) * 1000) / 1000, z], rotation: yawPitchQuat(yaw, pitch), yaw, pitch };
}

/** One ring of the GPU sweep: clumps per m², the ring's outer radius (m) and the clump level drawn (0–2). */
export interface SweepRing {
  density: number;
  radius: number;
  lod: number;
}

export interface SweepConfig {
  id: string;
  rings: SweepRing[];
}

/**
 * The GPU sweep: no grass (the page's own floor), the near ring alone at rising densities, then the recorded
 * near density with a mid ring (level 1) and a far ring (level 2) at rising density and reach.
 */
export const SWEEP_CONFIGS: readonly SweepConfig[] = [
  { id: 'none', rings: [] },
  ...[2, 4, 8, 16].map((d) => ({ id: `near${d}`, rings: [{ density: d, radius: 30, lod: 0 }] })),
  ...[
    [2, 80],
    [4, 80],
    [2, 150],
    [4, 150],
    [8, 150],
  ].map(([d, r]) => ({ id: `near8-mid${d}@${r}`, rings: [{ density: 8, radius: 30, lod: 0 }, { density: d!, radius: r!, lod: 1 }] })),
  { id: 'near8-mid4@80-far1@300', rings: [{ density: 8, radius: 30, lod: 0 }, { density: 4, radius: 80, lod: 1 }, { density: 1, radius: 300, lod: 2 }] },
  // Past what a field needs, to find where the GPU misses the cap.
  { id: 'near32', rings: [{ density: 32, radius: 30, lod: 0 }] },
  { id: 'near16-mid8@150-far2@400', rings: [{ density: 16, radius: 30, lod: 0 }, { density: 8, radius: 150, lod: 1 }, { density: 2, radius: 400, lod: 2 }] },
  { id: 'near32-mid16@150', rings: [{ density: 32, radius: 30, lod: 0 }, { density: 16, radius: 150, lod: 1 }] },
];

/** A sweep ring's area (m²) between the previous ring's radius and its own (the whole disc for the first). */
export function ringArea(rings: readonly SweepRing[], i: number): number {
  const inner = i === 0 ? 0 : rings[i - 1]!.radius;
  return Math.PI * (rings[i]!.radius ** 2 - inner ** 2);
}

/** Triangles a clump level has (village-assets.ts CLUMP_LEVELS: blades × (2 × segments − 1)). */
export function clumpTriangles(levels: readonly { blades: number; segments: number }[], lod: number): number {
  const l = levels[Math.min(lod, levels.length - 1)]!;
  return l.blades * (2 * l.segments - 1);
}

/** Clumps and triangles a config places around the camera, all round (the view sees a part of them). */
export function sweepLoad(cfg: SweepConfig, levels: readonly { blades: number; segments: number }[]): { clumps: number; triangles: number } {
  let clumps = 0;
  let triangles = 0;
  cfg.rings.forEach((r, i) => {
    const n = r.density * ringArea(cfg.rings, i);
    clumps += n;
    triangles += n * clumpTriangles(levels, r.lod);
  });
  return { clumps: Math.round(clumps), triangles: Math.round(triangles) };
}

/** At the 60 Hz cap a frame interval reads the refresh's 16.7 ms give or take this much (ms): not a missed frame. */
export const CAP_JITTER_MS = 0.3;
/**
 * Missed refreshes a sweep window may show and still count as holding the cap: this host drifts (another process,
 * the GPU's clock), and the probe's floor with no grass at all shows one now and then. A config that truly misses
 * the cap misses many.
 */
export const CAP_MISS_NOISE = 1;

/** A sweep row as the budget reads it: the config, and per renderer the frame at the cap and (WebGPU) the GPU time. */
export interface SweepRow {
  id: string;
  clumps: number;
  byRenderer: Partial<Record<'webgpu' | 'webgl2', { p95: number; missed: number; gpuMs: number | null; tris: number }>>;
}

export interface SweepBudget {
  /** The config proposed, its clumps all round and the triangles it drew in view (the most of the renderers). */
  id: string;
  clumps: number;
  tris: number;
  /** The lightest config (fewest triangles in view) that missed the cap, or null when every one held it. */
  brokeAt: { id: string; tris: number } | null;
}

/** Triangles in view a sweep row drew (the most of its renderers). */
const rowTris = (row: SweepRow): number => Math.max(0, ...Object.values(row.byRenderer).map((m) => m.tris));

/**
 * The budget proposed from the sweep, read at the cap only (GPU timestamps at a capped rate follow the GPU's clock,
 * which drops when it idles, so they do not rank the configs): a config holds when every renderer measured missed
 * no more refreshes than {@link CAP_MISS_NOISE} and its p95 stayed within `frameMs` and the refresh's jitter ({@link CAP_JITTER_MS}). The proposal is
 * the heaviest holding config (triangles in view) at most `1 / safety` of the lightest one that broke — the probe
 * draws no post stack and no game, which the rest of the frame needs — or the heaviest holding one when none
 * broke. Null when none held.
 */
export function proposeSweepBudget(rows: readonly SweepRow[], safety = 2, frameMs = 16.7 + CAP_JITTER_MS): SweepBudget | null {
  const held = (row: SweepRow): boolean => {
    const runs = Object.values(row.byRenderer);
    return runs.length > 0 && runs.every((m) => m.missed <= CAP_MISS_NOISE && m.p95 <= frameMs);
  };
  const grass = rows.filter((r) => r.id !== 'none');
  let brokeAt: SweepBudget['brokeAt'] = null;
  for (const row of grass) if (!held(row) && (brokeAt === null || rowTris(row) < brokeAt.tris)) brokeAt = { id: row.id, tris: rowTris(row) };
  let best: SweepBudget | null = null;
  for (const row of grass) {
    if (!held(row) || (brokeAt !== null && rowTris(row) > brokeAt.tris / safety)) continue;
    if (best === null || rowTris(row) > best.tris) best = { id: row.id, clumps: row.clumps, tris: rowTris(row), brokeAt };
  }
  return best;
}

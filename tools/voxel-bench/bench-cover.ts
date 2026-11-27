/**
 * The bench cover (the cover cameras of light-shots, `--cover` in headroom and coverage): a meadow and a reed shore
 * on the 8 km world's town, written through the commands a designer's tools send. Four stand-in models made in code
 * (a grass clump, a flower tuft, a reed clump and a pebble: tools/perf/village-assets.ts; neutral shapes for
 * pictures and measuring, not art) are imported from a folder of their own; two dressings name them (`setDressing`);
 * the town's grass and gravel materials are given the dressings (`setMaterial`); a gravel road is painted across
 * the empty lots (one `fill` paint stroke) so the verge rule has an edge to grow at, and a shelf of ground is set
 * under a pond's rim (one `set` stroke) so its water is shallow there. Taken out after the run: the strokes by the
 * project's undo, a stroke a step, the materials set back as they were read, the dressings and the models deleted,
 * the folder removed.
 *
 * Engine-owned test data for pictures and measuring, not a product feature.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DressingDef } from '@thirdlight/project-model';
import { SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M } from '@thirdlight/voxel';

import { pebbleGlb, plantGlb } from '../perf/village-assets';
import { BENCH_COVER } from './lighting-cameras';
import { MAT } from './world-kit';

/** The folder the stand-in models are imported from, and the files in it (a file a species). */
export const BENCH_COVER_FOLDER = 'assets/bench-cover';
/** Each model's colour is its glTF base colour factor: linear, so a mid green reads as (0.07, 0.17, 0.03). */
export const BENCH_COVER_MODELS = Object.freeze({
  grass: Object.freeze({ file: 'bench-grass.glb', glb: () => plantGlb('bench-grass', 11, { blades: 12, segments: 3, height: 0.42, spread: 0.16, color: [0.07, 0.17, 0.03] }), triangles: 60 }),
  flower: Object.freeze({ file: 'bench-flower.glb', glb: () => plantGlb('bench-flower', 12, { blades: 8, segments: 2, height: 0.6, spread: 0.09, color: [0.9, 0.6, 0.03] }), triangles: 24 }),
  reed: Object.freeze({ file: 'bench-reed.glb', glb: () => plantGlb('bench-reed', 13, { blades: 8, segments: 3, height: 1.7, spread: 0.1, color: [0.17, 0.15, 0.03] }), triangles: 40 }),
  pebble: Object.freeze({ file: 'bench-pebble.glb', glb: () => pebbleGlb('bench-pebble'), triangles: 10 }),
});
export type BenchCoverModel = keyof typeof BENCH_COVER_MODELS;

export const BENCH_MEADOW_DRESSING = 'bench-meadow';
export const BENCH_ROAD_DRESSING = 'bench-road';

/**
 * The bench's dressings over the models' asset ids. The meadow (on the town's grass): grass under open sky on dry
 * ground; flowers only within 1.5 m of another material's edge and 3 m or more from anything built (the road's verge, not a window sill's foot); reeds where
 * water stands 5 to 60 cm deep. The road (on gravel): pebbles on its shoulder, within 0.75 m of its edge.
 */
export function benchCoverDressings(models: Readonly<Record<BenchCoverModel, string>>): DressingDef[] {
  return [
    {
      dressingFormat: 1,
      dressingId: BENCH_MEADOW_DRESSING,
      name: 'Bench meadow',
      species: [
        { model: models.grass, class: 'cover', density: 6, scale: [0.7, 1.3], align: 0.3, conditions: { sky: true, slope: { max: 40, fade: 10 }, waterDepth: { max: 0 } } },
        { model: models.flower, class: 'cover', density: 2.5, spacing: 0.4, scale: [0.8, 1.25], seed: 3, conditions: { sky: true, waterDepth: { max: 0 }, materialEdge: { max: 1.5 }, construction: { min: 3 } } },
        { model: models.reed, class: 'cover', density: 4, spacing: 0.25, scale: [0.75, 1.3], seed: 5, conditions: { waterDepth: { min: 0.05, max: 0.6 } } },
      ],
    },
    { dressingFormat: 1, dressingId: BENCH_ROAD_DRESSING, name: 'Bench road', species: [{ model: models.pebble, class: 'cover', density: 5, scale: [0.5, 1.4], conditions: { sky: true, materialEdge: { max: 0.75 } } }] },
  ];
}

const cells = (m: number): number => Math.round(m / VOXEL_SIZE_M);

/** The road as one paint stroke: the ground's top cells in its strip take the gravel (each keeps its role, v3's role-less paint). */
export function coverRoadStroke(): Record<string, unknown> {
  const r = BENCH_COVER.road;
  return { v: 3, grid: 0, kind: 'fill', min: [cells(r.x0), -1, cells(r.z0)], max: [cells(r.x1) - 1, -1, cells(r.z1) - 1], mode: 'paint', voxel: { material: MAT.gravel, wetness: 0 } };
}

/** The pond's shelf as one set stroke: two rows of ground under the water's top row, in a ring inside the rim, so the water over it is one partly filled cell deep. */
export function coverShelfStroke(): Record<string, unknown> {
  const p = BENCH_COVER.pond;
  const list: number[] = [];
  const cx = p.x / VOXEL_SIZE_M;
  const cz = p.z / VOXEL_SIZE_M;
  for (let x = Math.floor(cx - p.radius); x <= Math.ceil(cx + p.radius); x++) for (let z = Math.floor(cz - p.radius); z <= Math.ceil(cz + p.radius); z++) {
    const r = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
    if (r > p.open && r <= p.radius) for (const y of [-3, -2]) list.push(x, y, z);
  }
  return { v: 3, grid: 0, kind: 'set', cells: list, voxel: { material: MAT.grass, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 } };
}

/** What the bench's backend calls answer. */
export interface BenchCoverApi {
  /** A command (throws when refused; `no_change` passes). */
  command(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** A voxel stroke or an undo: the JSON answered, as it is. */
  raw(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * Reads the world's far cache (its route): the backend builds what the strokes left for it first, so the cache is
   * current with the world when the bench ends. Absent: not waited for (a backend stopped before that rebuild lands
   * leaves the cache a revision behind, and its next start builds the whole cache again).
   */
  settleFar?(): Promise<unknown>;
  /** The project's assets (id and source path). */
  assets(): Promise<Array<{ assetId: string; sourcePath?: string }>>;
  readonly projectDir: string;
}

const MATERIALS = ['voxel-grass', 'voxel-gravel'] as const;

/** A material's record as the project's file holds it. */
function materialRecord(projectDir: string, materialId: string): Record<string, unknown> & { voxel?: Record<string, unknown> } {
  return (JSON.parse(readFileSync(join(projectDir, 'assets', 'materials', `${materialId}.material.json`), 'utf8')) as { data: Record<string, unknown> }).data;
}

/**
 * Places the bench cover in `world`; returns what was written and the undo. A stroke answered `no_change` (a run
 * before this one left it) is left as found and said: only the strokes this call wrote are undone.
 */
export async function placeBenchCover(b: BenchCoverApi, world: string, log: (s: string) => void = console.log): Promise<{ readonly facts: Record<string, unknown>; undo(): Promise<void> }> {
  const dir = join(b.projectDir, ...BENCH_COVER_FOLDER.split('/'));
  mkdirSync(dir, { recursive: true });
  const bytes: Record<string, number> = {};
  for (const [name, m] of Object.entries(BENCH_COVER_MODELS)) {
    const glb = m.glb();
    writeFileSync(join(dir, m.file), glb);
    bytes[name] = glb.length;
  }
  await b.command('importAssets', { folder: BENCH_COVER_FOLDER });
  const found = await b.assets();
  const models = Object.fromEntries(Object.entries(BENCH_COVER_MODELS).map(([name, m]) => [name, found.find((a) => a.sourcePath === `${BENCH_COVER_FOLDER}/${m.file}`)?.assetId])) as Record<BenchCoverModel, string | undefined>;
  for (const [name, id] of Object.entries(models)) if (id === undefined) throw new Error(`bench cover: the ${name} model was not imported`);
  const dressings = benchCoverDressings(models as Record<BenchCoverModel, string>);
  for (const dressing of dressings) await b.command('setDressing', { dressing });
  // The town's own materials, each given its dressing; set back as read when the bench is taken out.
  const before = MATERIALS.map((id) => materialRecord(b.projectDir, id));
  const named = [BENCH_MEADOW_DRESSING, BENCH_ROAD_DRESSING];
  for (let i = 0; i < before.length; i++) await b.command('setMaterial', { material: { ...before[i]!, voxel: { ...before[i]!.voxel, dressing: named[i]! } } });
  let written = 0;
  const facts: Record<string, unknown> = { models: Object.fromEntries(Object.entries(BENCH_COVER_MODELS).map(([name, m]) => [name, { assetId: models[name as BenchCoverModel], triangles: m.triangles, bytes: bytes[name] }])), dressings: dressings.map((d) => ({ id: d.dressingId, species: d.species.map((s) => ({ model: s.model, density: s.density, conditions: Object.keys(s.conditions ?? {}) })) })), road: BENCH_COVER.road, pond: BENCH_COVER.pond };
  for (const [name, command] of [['road', coverRoadStroke()], ['shelf', coverShelfStroke()]] as const) {
    const r = await b.raw('editVoxels', { world, command });
    const code = (r['error'] as { code?: string } | undefined)?.code;
    if (r['ok'] === true) written++;
    else if (code !== 'no_change') throw new Error(`the bench cover's ${name}: ${JSON.stringify(r).slice(0, 400)}`);
    facts[name === 'road' ? 'roadStroke' : 'shelfStroke'] = r['ok'] === true ? { cells: r['cells'] ?? null, parts: r['parts'] ?? null } : 'there already (a run before this one left it)';
    log(`bench cover: ${name} ${r['ok'] === true ? `written, ${String(r['cells'] ?? '?')} cells, parts ${String(r['parts'] ?? '?')}` : 'there already'}`);
  }
  log(`bench cover: placed (models ${Object.values(models).join(', ')}; ${JSON.stringify(bytes)} bytes)`);
  return {
    facts,
    undo: async () => {
      // The strokes written here are the project's newest steps (the cover is placed last of the project's own data).
      for (let k = 0; k < written; k++) {
        const r = await b.raw('undo', {});
        const voxels = r['voxels'] as { ok?: boolean; cells?: number } | undefined;
        if (r['ok'] !== true || voxels?.ok !== true) {
          log(`bench cover: NOT TAKEN OUT: undo ${k + 1} of ${written} was not a voxel step (${JSON.stringify(r).slice(0, 300)}); the road or the pond's shelf is still in ${world}`);
          break;
        }
        log(`bench cover: undo ${k + 1} of ${written}, ${String(voxels.cells ?? '?')} cells`);
      }
      for (const m of before) await b.command('setMaterial', { material: m }).catch((e: unknown) => log(`bench cover: ${String(m['materialId'])} was not set back: ${String(e)}`));
      for (const d of dressings) await b.command('deleteDressing', { dressingId: d.dressingId }).catch((e: unknown) => log(`bench cover: dressing ${d.dressingId} was not deleted: ${String(e)}`));
      for (const id of Object.values(models)) await b.command('deleteAsset', { assetId: id! }).catch((e: unknown) => log(`bench cover: asset ${String(id)} was not deleted: ${String(e)}`));
      rmSync(dir, { recursive: true, force: true });
      await b.settleFar?.().catch((e: unknown) => log(`bench cover: the far cache was not read after the undo: ${String(e)}`));
      log('bench cover: taken out');
    },
  };
}

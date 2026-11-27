/**
 * The bench cover (the cover cameras of light-shots, `--cover` in headroom and coverage): a meadow and a reed shore
 * on the 8 km world's town, written through the commands a designer's tools send. The plants and what grows them
 * are the engine's own starter cover: the Basic Kit is added to the project (its four plant models, their
 * materials, its dressings: one call, one undo step), the town's grass is given the kit's Meadow and its gravel the
 * kit's Gravel (`setMaterial`); a gravel road is painted across the empty lots (one `fill` paint stroke) so the
 * verge rule has an edge to grow at, and a shelf of ground is set under a pond's rim (one `set` stroke) so its
 * water is shallow there. Taken out after the run by the project's undo, newest first: the strokes, the two
 * materials, the kit.
 *
 * Engine-owned test data for pictures and measuring, not a product feature.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DressingDef } from '@thirdlight/project-model';
import { SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M } from '@thirdlight/voxel';

import { BENCH_COVER } from './lighting-cameras';
import { MAT } from './world-kit';

/** The pack that brings the plants and the dressings. */
export const BENCH_COVER_PACK = 'basic-kit';
/** The kit's dressings the bench sets: the Meadow on the town's grass, Gravel on its gravel. */
export const BENCH_MEADOW_DRESSING = 'basic-meadow';
export const BENCH_ROAD_DRESSING = 'basic-gravel';
/** The species of the kit's dressings the bench's checks name, by their place in each list. */
export const BENCH_SPECIES = Object.freeze({ grass: 0, patchFlowers: 1, vergeFlowers: 2, reeds: 3, pebbles: 0, edgeGrass: 1 });

const PACK_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'packs', BENCH_COVER_PACK);

/** The kit's dressings as its pack holds them (what a project receives). */
export function benchCoverDressings(): DressingDef[] {
  const pack = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as { commands: { op: string; args: Record<string, unknown> }[] };
  return pack.commands.filter((c) => c.op === 'setDressing').map((c) => c.args['dressing'] as DressingDef);
}

/** The kit's plant models as their maker reported them: triangles a level and the file's bytes, by asset id. */
export function benchCoverModels(): Record<string, { triangles: number[]; bytes: number }> {
  const made = JSON.parse(readFileSync(join(PACK_DIR, 'source', 'cover-plants.json'), 'utf8')) as { models: Record<string, { triangles: number[]; bytes: number }> };
  return Object.fromEntries(Object.entries(made.models).map(([id, m]) => [id, { triangles: m.triangles, bytes: m.bytes }]));
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
  /** A command, a voxel stroke or an undo: the JSON answered, as it is. */
  raw(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Adds an engine pack to the project (`POST …/packs/<id>`): the JSON answered. */
  addPack(packId: string): Promise<Record<string, unknown>>;
  /**
   * Reads the world's far cache (its route): the backend builds what the strokes left for it first, so the cache is
   * current with the world when the bench ends. Absent: not waited for (a backend stopped before that rebuild lands
   * leaves the cache a revision behind, and its next start builds the whole cache again).
   */
  settleFar?(): Promise<unknown>;
  readonly projectDir: string;
}

const MATERIALS = ['voxel-grass', 'voxel-gravel'] as const;

/** A material's record as the project's file holds it. */
function materialRecord(projectDir: string, materialId: string): Record<string, unknown> & { voxel?: Record<string, unknown> } {
  return (JSON.parse(readFileSync(join(projectDir, 'assets', 'materials', `${materialId}.material.json`), 'utf8')) as { data: Record<string, unknown> }).data;
}

const codeOf = (r: Record<string, unknown>): string | undefined => (r['error'] as { code?: string } | undefined)?.code;

/**
 * Places the bench cover in `world`; returns what was written and the undo. Whatever a run before this one left
 * (the kit in the project, a material already naming its dressing, a stroke answered `no_change`) is left as found
 * and said: only the steps this call made are undone.
 */
export async function placeBenchCover(b: BenchCoverApi, world: string, log: (s: string) => void = console.log): Promise<{ readonly facts: Record<string, unknown>; undo(): Promise<void> }> {
  /** The steps this call put on the project's undo line, oldest first. */
  const steps: ('pack' | 'material' | 'stroke')[] = [];
  const pack = await b.addPack(BENCH_COVER_PACK);
  if (pack['ok'] === true) steps.push('pack');
  else if (codeOf(pack) !== 'pack_present') throw new Error(`the bench cover's kit: ${JSON.stringify(pack).slice(0, 400)}`);
  log(`bench cover: ${BENCH_COVER_PACK} ${pack['ok'] === true ? `added (${(pack['added'] as unknown[] | undefined)?.length ?? '?'} commands, one undo step)` : 'in the project already'}`);
  // The town's own materials, each given its dressing.
  const named = [BENCH_MEADOW_DRESSING, BENCH_ROAD_DRESSING];
  for (let i = 0; i < MATERIALS.length; i++) {
    const m = materialRecord(b.projectDir, MATERIALS[i]!);
    const r = await b.raw('setMaterial', { material: { ...m, voxel: { ...m.voxel, dressing: named[i]! } } });
    if (r['ok'] === true) steps.push('material');
    else if (codeOf(r) !== 'no_change') throw new Error(`the bench cover's ${MATERIALS[i]!}: ${JSON.stringify(r).slice(0, 400)}`);
  }
  const dressings = benchCoverDressings().filter((d) => named.includes(d.dressingId));
  const facts: Record<string, unknown> = { pack: BENCH_COVER_PACK, models: benchCoverModels(), dressings: dressings.map((d) => ({ id: d.dressingId, species: d.species.map((s) => ({ model: s.model, density: s.density, conditions: Object.keys(s.conditions ?? {}) })) })), road: BENCH_COVER.road, pond: BENCH_COVER.pond };
  for (const [name, command] of [['road', coverRoadStroke()], ['shelf', coverShelfStroke()]] as const) {
    const r = await b.raw('editVoxels', { world, command });
    if (r['ok'] === true) steps.push('stroke');
    else if (codeOf(r) !== 'no_change') throw new Error(`the bench cover's ${name}: ${JSON.stringify(r).slice(0, 400)}`);
    facts[name === 'road' ? 'roadStroke' : 'shelfStroke'] = r['ok'] === true ? { cells: r['cells'] ?? null, parts: r['parts'] ?? null } : 'there already (a run before this one left it)';
    log(`bench cover: ${name} ${r['ok'] === true ? `written, ${String(r['cells'] ?? '?')} cells, parts ${String(r['parts'] ?? '?')}` : 'there already'}`);
  }
  log(`bench cover: placed (${steps.join(', ')})`);
  return {
    facts,
    undo: async () => {
      // This call's steps are the project's newest (the cover is placed last of the project's own data): each undo
      // takes back the newest, and a step that is not the kind expected stops the rest (nothing else is undone).
      for (let k = steps.length - 1; k >= 0; k--) {
        const r = await b.raw('undo', {});
        const voxels = r['voxels'] as { ok?: boolean; cells?: number } | undefined;
        const kind = steps[k]!;
        if (r['ok'] !== true || (kind === 'stroke') !== (voxels?.ok === true)) {
          log(`bench cover: NOT TAKEN OUT: undo of ${kind} ${k + 1} of ${steps.length} was not that step (${JSON.stringify(r).slice(0, 300)}); ${steps.slice(0, k + 1).join(', ')} still in the project`);
          break;
        }
        log(`bench cover: undo of ${kind}${kind === 'stroke' ? `, ${String(voxels?.cells ?? '?')} cells` : ''}`);
      }
      await b.settleFar?.().catch((e: unknown) => log(`bench cover: the far cache was not read after the undo: ${String(e)}`));
      log('bench cover: taken out');
    },
  };
}

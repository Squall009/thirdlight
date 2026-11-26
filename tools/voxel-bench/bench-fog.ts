/**
 * The bench fog (the fog cameras of light-shots, `--fog` in headroom): a hollow dug into an empty lot of the 8 km
 * world's town and filled with mist (lighting-cameras.ts `FOG_HOLLOW`), written through the commands a designer's
 * tools send: a gas material (`setMaterial`), the hollow (one `editVoxels` dig stroke) and the fill (one `flood`
 * stroke with a fade). Taken out after the run by the project's undo, a stroke a step, and the material deleted, so
 * the world's files are what they were.
 *
 * Engine-owned test data for pictures and measuring, not a product feature.
 */
import { VOXEL_ROLE, VOXEL_SIZE_M } from '@thirdlight/voxel';
import { FOG_HOLLOW } from './lighting-cameras';

/** The bench's mist: a gas with a voxel id the world does not use, pale grey, at the gas record's default density. */
export const BENCH_FOG_MATERIAL = Object.freeze({ materialId: 'bench-mist', name: 'Bench mist', shader: 'standard', params: {}, textures: {}, voxel: { id: 4010, use: 'gas', gas: { color: '#dfe6ea' } } });

const cells = (m: number): number => Math.round(m / VOXEL_SIZE_M);

/** The hollow as one dig stroke: its balls, hard-rimmed (a brush's size is its half extents). */
export function fogHollowStroke(): { v: 3; grid: 0; kind: 'brush'; shape: 'sphere'; size: [number, number, number]; points: number[]; mode: 'dig'; smooth: false } {
  const r = cells(FOG_HOLLOW.diameter / 2);
  return { v: 3, grid: 0, kind: 'brush', shape: 'sphere', size: [r, r, r], points: FOG_HOLLOW.dabs.flatMap((p) => p.map(cells)), mode: 'dig', smooth: false };
}

/** The fill as one flood stroke of the bench's mist; `drain`: the same walk with air (what takes a fill out). */
export function fogFloodCommand(drain = false): Record<string, unknown> {
  const [x, y, z] = FOG_HOLLOW.seed.map((m) => Math.floor(m / VOXEL_SIZE_M)) as [number, number, number];
  return { v: 3, grid: 0, kind: 'flood', seed: [x, y, z], level: cells(FOG_HOLLOW.level), value: drain ? { material: 0, role: 0 } : { material: BENCH_FOG_MATERIAL.voxel.id, role: VOXEL_ROLE.gas }, reach: cells(FOG_HOLLOW.reach), ...(drain ? {} : { fade: FOG_HOLLOW.fade }) };
}

/** What the bench's backend calls answer: a command (throws when refused) and a raw call (the answer as it is). */
export interface BenchFogApi {
  command(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** A voxel stroke or an undo, sent without waiting on its outcome: the JSON answered. */
  raw(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Places the bench fog in `world`; returns what was written and the undo. A stroke answered `no_change` (the fog of
 * a run that did not finish is still there) is left as found and said: only the strokes this call wrote are undone.
 */
export async function placeBenchFog(b: BenchFogApi, world: string, log: (s: string) => void = console.log): Promise<{ readonly facts: Record<string, unknown>; undo(): Promise<void> }> {
  await b.command('setMaterial', { material: BENCH_FOG_MATERIAL });
  let written = 0;
  const facts: Record<string, unknown> = { material: BENCH_FOG_MATERIAL.voxel, hollow: FOG_HOLLOW };
  for (const [name, command] of [['hollow', fogHollowStroke()], ['flood', fogFloodCommand()]] as const) {
    const r = await b.raw('editVoxels', { world, command });
    const code = (r['error'] as { code?: string } | undefined)?.code;
    if (r['ok'] === true) written++;
    else if (code !== 'no_change') throw new Error(`the bench fog's ${name}: ${JSON.stringify(r).slice(0, 400)}`);
    facts[name] = r['ok'] === true ? { cells: r['cells'] ?? null, parts: r['parts'] ?? null } : 'there already (a run before this one left it)';
    log(`bench fog: ${name} ${r['ok'] === true ? `written, ${String(r['cells'] ?? '?')} cells, parts ${String(r['parts'] ?? '?')}` : 'there already'}`);
  }
  return {
    facts,
    undo: async () => {
      // The strokes written here are the project's newest steps (the fog is placed last and taken out first).
      for (let k = 0; k < written; k++) {
        const r = await b.raw('undo', {});
        const voxels = r['voxels'] as { ok?: boolean; cells?: number } | undefined;
        if (r['ok'] !== true || voxels?.ok !== true) {
          log(`bench fog: NOT TAKEN OUT: undo ${k + 1} of ${written} was not a voxel step (${JSON.stringify(r).slice(0, 300)}); the hollow or its fog is still in ${world}`);
          break;
        }
        log(`bench fog: undo ${k + 1} of ${written}, ${String(voxels.cells ?? '?')} cells`);
      }
      await b.command('deleteMaterial', { materialId: BENCH_FOG_MATERIAL.materialId }).catch((e: unknown) => log(`bench fog: the material was not deleted: ${String(e)}`));
    },
  };
}

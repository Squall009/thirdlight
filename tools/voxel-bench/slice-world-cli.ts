/**
 * Writes the thin slice's test world into a project folder
 * (`node tools/voxel-bench/run.mjs slice-world --project-dir DIR`), e.g. a
 * staging project's folder under the staging data root, before the backend
 * opens the world. Prints where the scene stands (the page's `at`).
 *
 *   --project-dir DIR   the project's folder (required)
 *   --name NAME         the world's folder name (default slice)
 *   --footprint CELLS   cells a side (default 1024: 512 m)
 *   --kind slice|town   the slice's hilly square (default) or the bench's dense town (256 m)
 */
import { SLICE_FOOTPRINT, SLICE_WORLD_NAME, writeSliceWorld, writeTownWorld } from './slice-world';

function arg(name: string, fallback: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const projectDir = arg('project-dir', null);
if (projectDir === null) {
  console.error('slice-world: --project-dir DIR is required');
  process.exit(2);
}
const t0 = performance.now();
const w = arg('kind', 'slice') === 'town' ? writeTownWorld(projectDir, arg('name', 'town')!) : writeSliceWorld(projectDir, arg('name', SLICE_WORLD_NAME)!, Number(arg('footprint', String(SLICE_FOOTPRINT))));
console.log(JSON.stringify({ dir: w.dir, files: w.files, scene: w.scene, chunks: [...w.store.chunkKeys()].length, ms: Math.round(performance.now() - t0) }));

/**
 * Writes the thin slice's test world into a project folder
 * (`node tools/voxel-bench/run.mjs slice-world --project-dir DIR`), e.g. a
 * staging project's folder under the staging data root, before the backend
 * opens the world. Prints where the scene stands (the page's `at`).
 *
 *   --project-dir DIR   the project's folder (required)
 *   --name NAME         the world's folder name (default slice)
 *   --footprint CELLS   cells a side (default 1024: 512 m)
 *   --kind slice|town|features   the slice's hilly square (default), the bench's dense town (256 m)
 *                       or the terrain mesher's hard-case row (448 × 32 m)
 */
import { SLICE_FOOTPRINT, SLICE_WORLD_NAME, writeFeaturesWorld, writeSliceWorld, writeTownWorld } from './slice-world';

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
const kind = arg('kind', 'slice');
if (kind !== 'slice' && kind !== 'town' && kind !== 'features') {
  console.error(`slice-world: --kind ${kind}: not slice, town or features`);
  process.exit(2);
}
const w =
  kind === 'town' ? writeTownWorld(projectDir, arg('name', 'town')!)
  : kind === 'features' ? writeFeaturesWorld(projectDir, arg('name', 'features')!)
  : writeSliceWorld(projectDir, arg('name', SLICE_WORLD_NAME)!, Number(arg('footprint', String(SLICE_FOOTPRINT))));
console.log(JSON.stringify({ dir: w.dir, files: w.files, scene: w.scene, chunks: [...w.store.chunkKeys()].length, ms: Math.round(performance.now() - t0) }));

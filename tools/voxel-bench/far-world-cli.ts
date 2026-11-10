/**
 * The multi-km mountain test world and its far cache
 * (`node tools/voxel-bench/run.mjs far-world [options]`):
 *
 *   --project-dir DIR   the project folder the world goes into (`voxels/<name>/`; required)
 *   --name NAME         the world's folder name (default far)
 *   --size-km N         side in km (default 8)
 *   --seed N            the world's seed (default 97)
 *   --style S           realistic (default: eroded massifs, rivers, cliffs, outcrops, boulders, snow) or terraced
 *                       (the first far world's regular terraced cliffs, for measurements against it)
 *   --workers N         worker threads (default 4)
 *   --reserve-gb N      stop between columns when the disk has less free (default 2.5)
 *   --estimate N        write only the N centre columns into a scratch world and extrapolate disk and time (no manifest)
 *   --cache-only        keep the world, build its far cache only
 *   --no-cache          write the world, build no far cache
 *   --min-level N       the far tree's lowest kept level (default 2)
 *   --heights           print the surface height's statistics over the world and stop
 *
 * Writes the world column by column through the workers (never held whole),
 * then builds the far cache into the project's `cache/voxel-far/<name>/`,
 * then measures the far selection from a few eyes. Prints one JSON report:
 * disk MB and MB/km², generation and build s and s/km², cache MB/km² per
 * level, nodes drawn against distance, the scope's peak memory.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { farCacheDir } from '@thirdlight/workspace';
import { farSurfaceHeight, farWorldDirs, farWorldHalf, FAR_WORLD_NAME, FAR_WORLD_STYLES, type FarWorldStyle } from './far-world';
import { buildFarCacheInPool, FarPool, freeBytes, measureFarSelection, writeFarWorld } from './far-world-run';
import { bundleWorker, REPO } from './stream-node';

function arg(name: string, fallback: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** The capped scope's peak memory (bytes), when the cgroup reports one. */
function scopePeak(): number | null {
  const own = (readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::')) ?? '').slice(3);
  const f = `/sys/fs/cgroup${own}/memory.peak`;
  return existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) : null;
}

const projectDir = arg('project-dir', null);
if (projectDir === null) {
  console.error('far-world: --project-dir DIR is required');
  process.exit(2);
}
const name = arg('name', FAR_WORLD_NAME)!;
const sizeKm = Number(arg('size-km', '8'));
const seed = Number(arg('seed', '97'));
const style = arg('style', FAR_WORLD_STYLES[0]) as FarWorldStyle;
if (!FAR_WORLD_STYLES.includes(style)) {
  console.error(`far-world: --style is one of ${FAR_WORLD_STYLES.join(', ')}`);
  process.exit(2);
}
const workers = Number(arg('workers', '4'));
const reserveBytes = Number(arg('reserve-gb', '2.5')) * 2 ** 30;
const minLevel = Number(arg('min-level', '2'));
const estimate = arg('estimate', null);
const half = farWorldHalf(sizeKm);
const km2 = (2 * half * 0.5 / 1000) ** 2;
const MB = 1e6;

if (flag('heights')) {
  // Every 8th cell: enough for the peaks, the cliffs and the valleys' share.
  let max = -Infinity, sum = 0, n = 0, over500 = 0, over1000 = 0;
  for (let x = -half; x < half; x += 16) for (let z = -half; z < half; z += 16) {
    const h = farSurfaceHeight(x, z, { seed, sizeKm, style }) / 2;
    max = Math.max(max, h);
    sum += h;
    n++;
    if (h > 500) over500++;
    if (h > 1000) over1000++;
  }
  console.log(JSON.stringify({ style, sideKm: (2 * half) / 2000, maxM: Math.round(max), meanM: Math.round(sum / n), over500: +(over500 / n).toFixed(3), over1000: +(over1000 / n).toFixed(3) }));
  process.exit(0);
}

const file = await bundleWorker('far-worker-node', join(REPO, 'dist', 'voxel-bench', 'far-worker.mjs'));
const pool = new FarPool(file, workers);
const report: Record<string, unknown> = { style, sizeKm: (2 * half) / 2000, km2: +km2.toFixed(2), seed, workers, freeGiBBefore: +(freeBytes(projectDir) / 2 ** 30).toFixed(2) };
try {
  if (estimate !== null) {
    const scratch = join(projectDir, 'estimate');
    rmSync(scratch, { recursive: true, force: true });
    const limit = Number(estimate);
    const w = await writeFarWorld(pool, scratch, { sizeKm, seed, style, reserveBytes, limit });
    const columnKm2 = (256 / 1000) ** 2;
    report.estimate = { columns: w.columns, MB: +(w.bytes / MB).toFixed(1), MBperKm2: +(w.bytes / MB / (w.columns * columnKm2)).toFixed(2), worldMB: Math.round((w.bytes / MB / (w.columns * columnKm2)) * km2), sPerKm2: +((w.ms / 1000) * workers / (w.columns * columnKm2)).toFixed(1) };
    rmSync(scratch, { recursive: true, force: true });
  } else {
    const { dir } = farWorldDirs(projectDir, name);
    if (!flag('cache-only')) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      let last = 0;
      const w = await writeFarWorld(pool, projectDir, {
        name,
        sizeKm,
        seed,
        style,
        reserveBytes,
        onColumn: (done, of) => {
          if (done - last >= 64 || done === of) {
            last = done;
            console.error(`far-world: ${done}/${of} columns, ${(freeBytes(projectDir) / 2 ** 30).toFixed(2)} GiB free`);
          }
        },
      });
      report.world = { dir, columns: w.columns, files: w.files, MB: +(w.bytes / MB).toFixed(1), MBperKm2: +(w.bytes / MB / km2).toFixed(2), uniformChunks: w.uniform, storedChunks: w.stored, s: +(w.ms / 1000).toFixed(1), sPerKm2: +(w.ms / 1000 / km2).toFixed(2), stopped: w.stopped };
      if (w.stopped !== null) throw new Error(`world stopped: ${w.stopped}`);
    }
    if (!flag('no-cache')) {
      const cacheDir = farCacheDir(projectDir, name);
      let last = 0;
      const c = await buildFarCacheInPool(pool, dir, cacheDir, minLevel, (done, of) => {
        if (done - last >= 64 || done === of) {
          last = done;
          console.error(`far-cache: ${done}/${of} columns`);
        }
      });
      report.cache = {
        dir: cacheDir,
        MB: +(c.bytes / MB).toFixed(2),
        MBperKm2: +(c.bytes / MB / km2).toFixed(3),
        s: +(c.ms / 1000).toFixed(1),
        sPerKm2: +(c.ms / 1000 / km2).toFixed(2),
        levels: c.manifest.levels.map((l) => ({ level: l.level, nodes: l.nodes, MB: +(l.bytes / MB).toFixed(2), files: l.regions.length })),
      };
      // Eyes: the town square, 300 m over it, a valley 2.5 km out, and a corner of the world (cells; ground ~0 in the town).
      const eyes: Array<readonly [number, number, number]> = [
        [0, 4, 0],
        [0, 600, 0],
        [5000, 400, 0],
        [-half + 200, 3200, -half + 200],
      ];
      report.selection = measureFarSelection(cacheDir, eyes, [1, 2, 4], { half: 384, height: 192 });
    }
  }
} finally {
  await pool.close();
}
report.freeGiBAfter = +(freeBytes(projectDir) / 2 ** 30).toFixed(2);
const peak = scopePeak();
report.scopePeakMB = peak === null ? null : Math.round(peak / MB);
console.log(JSON.stringify(report, null, 1));

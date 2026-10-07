/**
 * A synthetic world of probe tiles (`node tools/perf/run.mjs village --synthetic-probes N`): probe tiles at
 * the placement's own tiling (2 m, 64 intervals a tile, a ground band and a layer above) over a square
 * centred on the class's scene, about N tiles, each a texture asset holding a plausible sky light (no bake,
 * no game data), recorded as the scene's probe bake. The export then streams them around its camera
 * (probe-residency.ts): its frame time, the tiles' arrival (the page's `tl:probes:resident` mark) and the
 * probe textures' size measure probe lighting at world scale.
 */
import { encodePng16, packProbeTexels } from '@thirdlight/three-adapter';
import { placeProbeGrids, probeCount, probeGridGpuBytes, type ProbeGridRecord } from '@thirdlight/project-model';

import type { PerfBackend } from './backend';
import { publishFileVia, type CommandFn } from './build';

/** Height of the synthetic world's probes over the ground (m). */
const WORLD_HEIGHT = 16;
const SPACING = 2;

/** A tile file: every probe the same soft sky light from above, valid, no walls. */
async function tileFile(resolution: readonly number[]): Promise<Uint8Array> {
  const n = resolution[0]! * resolution[1]! * resolution[2]!;
  const sh = new Float32Array(n * 27);
  for (let p = 0; p < n; p++) {
    // Band 0 (RGB), then the y term (light from above).
    sh.set([0.55, 0.6, 0.7, 0.2, 0.22, 0.26], p * 27);
  }
  const packed = packProbeTexels(sh, new Float32Array(n).fill(1));
  return encodePng16(packed.width, packed.height, packed.samples);
}

export interface SyntheticProbes {
  tiles: number;
  probes: number;
  side: number;
  fileBytes: number;
  gpuBytes: number;
  ms: number;
}

/** Record about `tiles` synthetic probe tiles as `sceneId`'s probe bake. */
export async function addSyntheticProbes(be: PerfBackend, projectId: string, sceneId: string, tiles: number, log: (s: string) => void): Promise<SyntheticProbes> {
  const t0 = performance.now();
  const cmd: CommandFn = (op, args) => be.project(projectId).command(op, args);
  // Two layers of tiles (the ground band and above): a square of √(N/2) tiles a side, 128 m each.
  const perSide = Math.max(1, Math.round(Math.sqrt(tiles / 2)));
  const side = perSide * 64 * SPACING;
  const boxes = placeProbeGrids({ min: [-side / 2, 0, -side / 2], max: [side / 2, WORLD_HEIGHT, side / 2] }, SPACING);
  const files = new Map<string, Uint8Array>();
  const grids: ProbeGridRecord[] = [];
  let fileBytes = 0;
  for (const [i, b] of boxes.entries()) {
    const shape = b.resolution.join('x');
    let bytes = files.get(shape);
    if (bytes === undefined) files.set(shape, (bytes = await tileFile(b.resolution)));
    const asset = `synthetic-probes-${i}`;
    await publishFileVia(be, projectId, cmd, { assetId: asset, kind: 'texture', displayName: `probes synthetic ${i + 1}`, bytes });
    fileBytes += bytes.length;
    grids.push({ ...b, asset });
    if ((i + 1) % 100 === 0) log(`synthetic probes: ${i + 1}/${boxes.length} tiles published`);
  }
  const probes = grids.reduce((n, g) => n + probeCount(g), 0);
  const gpuBytes = grids.reduce((n, g) => n + probeGridGpuBytes(g), 0);
  const createdAt = new Date().toISOString();
  const hash = '0123456789abcdef';
  const probeBake = { createdAt, spacing: SPACING, bounces: 0, grids, probes, moved: 0, filled: 0, gpuBytes, lightsHash: hash, staticsHash: hash };
  const lighting = { bakeId: `bake-synthetic`, createdAt, source: 'browser', range: 1, texelsPerMeter: 1, samples: 1, bounces: 0, atlases: [], entries: [], bakedLights: [], lightsHash: hash, staticsHash: hash, probes: probeBake };
  const res = await cmd('setLighting', { sceneId, lighting });
  if (res['ok'] === false) throw new Error(`setLighting refused: ${JSON.stringify(res).slice(0, 400)}`);
  const out = { tiles: grids.length, probes, side, fileBytes, gpuBytes, ms: Math.round(performance.now() - t0) };
  log(`synthetic probes: ${out.tiles} tiles over ${side} m × ${side} m, ${probes} probes, ${(fileBytes / 1048576).toFixed(1)} MB of files, ${(gpuBytes / 1048576).toFixed(0)} MB if all were on the GPU (${(out.ms / 1000).toFixed(0)} s)`);
  return out;
}

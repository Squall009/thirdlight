/**
 * The placeholder voxel texture sets (texture-sets.ts): written as PNGs and
 * measured, and optionally put on a running backend's project through the
 * one command path, as voxel materials for the benchmark worlds' ids.
 *
 *   node tools/voxel-bench/run.mjs textures [--size 4096] [--out DIR]
 *       every set at the authored size (1024 px/m on a 4 m tile) into DIR
 *       (default ~/.cache/thirdlight-phase46/work/46d.4a/textures): bytes a
 *       map and the ms it took
 *   node tools/voxel-bench/run.mjs textures --encode 4096 [--sets stone,grass]
 *       each map of the sets (default all) at that size encoded as one layer
 *       the way the backend's slot route encodes a layer past the encoder's
 *       limit (UASTC, the assembled effort, in stripes), decoded again by
 *       three's transcoder and checked against the source at fixed texels
 *       of every level-0 stripe edge: ms, bytes, levels, the texel error
 *   node tools/voxel-bench/run.mjs textures --import 1024 [--origin URL] [--token-file F] [--data-root DIR] [--project ID]
 *       every set at that size into the project's `assets/voxel-textures`
 *       folder, imported as every texture is (`importAssets`; regenerated
 *       files imported again by "check files"), and one voxel material a
 *       benchmark id set (`setMaterial`) naming the textures as its
 *       surfaces' sets (staging by default: http://127.0.0.1:4180,
 *       ~/thirdlight-staging-p45, voxel-slice)
 *
 * Engine-owned test data only; nothing here is shipped or committed.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PLACEHOLDER_MAPS, PLACEHOLDER_SETS, placeholderLook, placeholderPng, placeholderSet, type PlaceholderSet } from './texture-sets';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

/**
 * The benchmark worlds' voxel ids (the world kit's: rock 1, soil 2, grass 3, sand 4, gravel 6, stone 10, timber 11,
 * plaster 12, roof tile 13, plank 14, brick 15) as voxel materials: the set each surface wears, a tint (the record's
 * colour, multiplying the albedo) for the ids that reuse another's textures, and the placeholder kit (`run.mjs kits`)
 * whose test list binds the id, kept on the record (left out where the project has no such kit).
 */
const BENCH_MATERIALS: ReadonlyArray<{ id: number; name: string; use: 'construction' | 'terrain'; wall: PlaceholderSet; floor?: PlaceholderSet; ceiling?: PlaceholderSet; color?: string; kit?: string }> = [
  { id: 1, name: 'Rock', use: 'terrain', wall: 'rock' },
  { id: 2, name: 'Soil', use: 'terrain', wall: 'earth' },
  { id: 3, name: 'Grass', use: 'terrain', wall: 'grass' },
  { id: 4, name: 'Sand', use: 'terrain', wall: 'earth', color: '#f2dcae' },
  { id: 6, name: 'Gravel', use: 'terrain', wall: 'rock', color: '#d8d0c4' },
  { id: 10, name: 'Stone', use: 'construction', wall: 'stone', kit: 'stone' },
  { id: 11, name: 'Timber', use: 'construction', wall: 'timber', kit: 'log' },
  { id: 12, name: 'Plaster', use: 'construction', wall: 'plaster', floor: 'timber', ceiling: 'plaster' },
  { id: 13, name: 'Roof tile', use: 'construction', wall: 'timber', color: '#c07a62' },
  { id: 14, name: 'Plank', use: 'construction', wall: 'timber', color: '#e8d8c0', kit: 'log' },
  { id: 15, name: 'Brick', use: 'construction', wall: 'stone', color: '#d08a70', kit: 'stone' },
];

const fileOf = (set: PlaceholderSet, map: string): string => `voxel-${set}-${map}.png`;

/** Every set at `size`² into `dir`: per file its bytes; the ms the whole took. */
function writeSets(dir: string, size: number): { files: Array<{ name: string; bytes: number }>; ms: number } {
  mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const files: Array<{ name: string; bytes: number }> = [];
  for (const set of PLACEHOLDER_SETS) {
    const maps = placeholderSet(set, size);
    for (const map of PLACEHOLDER_MAPS) {
      const png = placeholderPng(maps[map], size);
      writeFileSync(join(dir, fileOf(set, map)), png);
      files.push({ name: fileOf(set, map), bytes: png.length });
    }
  }
  return { files, ms: performance.now() - t0 };
}

const importSize = arg('import', '');
const encodeSize = arg('encode', '');
if (encodeSize !== '') {
  const { packKtx2 } = await import('../../packages/backend/src/texture-encode');
  const { readKtx2 } = await import('../../packages/backend/src/ktx2-container');
  const { halveRgba, stripeRows } = await import('../../packages/backend/src/ktx2-striped');
  const { KTX2_SOURCE_PIXELS_MAX } = await import('../../packages/backend/src/texture-encode');
  const { transcodeKtx2Levels } = await import('./three-basis');
  const size = Number(encodeSize);
  const sets = arg('sets', PLACEHOLDER_SETS.join(',')).split(',') as PlaceholderSet[];
  const modeOf = { albedoHeight: 'color', normal: 'normal', orm: 'data' } as const;
  const rows = stripeRows(size, KTX2_SOURCE_PIXELS_MAX);
  // Texels on both sides of every stripe edge, the corners and the middle.
  const probes: Array<[number, number]> = [[0, 0], [size - 1, size - 1], [size >> 1, size >> 1]];
  for (let y = rows; y < size; y += rows) probes.push([17, y - 1], [size - 33, y], [size >> 2, y + 1]);
  let total = 0;
  for (const set of sets) {
    const maps = placeholderSet(set, size);
    for (const map of PLACEHOLDER_MAPS) {
      const png = placeholderPng(maps[map], size);
      const t0 = performance.now();
      const layer = [0, 1, 2, 3].map((channel) => ({ source: 0, channel })) as never;
      const r = await packKtx2([png], [layer], modeOf[map], [], 'assembled', true);
      const ms = performance.now() - t0;
      if (!r.ok) throw new Error(`${set} ${map}: ${r.message}`);
      total += ms;
      const head = readKtx2(r.ktx2)!;
      const t1 = performance.now();
      const { levels } = await transcodeKtx2Levels(r.ktx2);
      const decodeMs = performance.now() - t1;
      const src = maps[map];
      let worst = 0;
      for (const [x, y] of probes) {
        // A 3×3 mean round the texel on both sides: UASTC's per-texel error averages out, a misplaced stripe does not.
        for (let c = 0; c < 4; c++) {
          let a = 0;
          let b = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(size - 1, Math.max(0, x + dx));
            const yy = Math.min(size - 1, Math.max(0, y + dy));
            const p = (yy * size + xx) * 4 + c;
            a += levels[0]!.data[p]!;
            b += src[p]!;
            n++;
          }
          worst = Math.max(worst, Math.abs(a - b) / n);
        }
      }
      const mean = (a: Uint8Array, b: Uint8Array): number => {
        let d = 0;
        for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
        return d / a.length;
      };
      const half = halveRgba(src, size, size, modeOf[map]).data;
      console.log(`[encode] ${set} ${map} ${size}² ${modeOf[map]}: ${(ms / 1000).toFixed(1)} s, ${(r.ktx2.length / 1e6).toFixed(2)} MB KTX2 (PNG ${(png.length / 1e6).toFixed(2)} MB), ${head.levels.length} levels, ${levels[0]!.width}×${levels[0]!.height} decoded by three in ${(decodeMs / 1000).toFixed(1)} s; mean error level 0 ${mean(levels[0]!.data, src).toFixed(2)}, level 1 vs the box halving ${mean(levels[1]!.data, half).toFixed(2)}, worst 3×3 mean at ${probes.length} stripe-edge texels ${worst.toFixed(1)} (/255)`);
    }
  }
  console.log(`[encode] ${sets.length * PLACEHOLDER_MAPS.length} maps in ${(total / 1000).toFixed(1)} s (one thread), stripes of ${rows} rows`);
} else if (importSize === '') {
  const size = Number(arg('size', '4096'));
  const dir = arg('out', join(homedir(), '.cache', 'thirdlight-phase46', 'work', '46d.4a', 'textures'));
  const { files, ms } = writeSets(dir, size);
  for (const set of PLACEHOLDER_SETS) {
    const l = placeholderLook(set);
    console.log(`[textures] ${set}: ${size}² (${size / l.tileMetres} px/m on a ${l.tileMetres} m tile, depth ${l.depthMetres} m): ${PLACEHOLDER_MAPS.map((m) => `${m} ${(files.find((f) => f.name === fileOf(set, m))!.bytes / 1e6).toFixed(2)} MB`).join(', ')}`);
  }
  console.log(`[textures] ${files.length} PNGs, ${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1)} MB in ${dir}, ${(ms / 1000).toFixed(1)} s`);
} else {
  const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
  const TOKEN = readFileSync(arg('token-file', join(homedir(), 'thirdlight-staging-p45', 'owner-token')), 'utf8').trim();
  const DATA_ROOT = arg('data-root', join(homedir(), 'thirdlight-staging-p45'));
  const PROJECT = arg('project', 'voxel-slice');
  const FOLDER = 'assets/voxel-textures';
  type Answer = Record<string, unknown> & { ok?: boolean; error?: { code: string; message?: string } };
  const command = async (op: string, args: Record<string, unknown>, write: boolean): Promise<Answer> => {
    const body: Record<string, unknown> = { op, projectId: PROJECT, args };
    if (write) {
      body['expectedRevision'] = (await command('queryProject', {}, false))['revision'];
      body['requestId'] = `req-${randomBytes(16).toString('hex')}`;
    }
    const r = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/commands`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as Answer;
  };
  const size = Number(importSize);
  const written = writeSets(join(DATA_ROOT, 'projects', PROJECT, ...FOLDER.split('/')), size);
  console.log(`[textures] ${written.files.length} PNGs at ${size}² (${(written.files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1)} MB) in ${(written.ms / 1000).toFixed(1)} s`);
  const imported = await command('importAssets', { folder: FOLDER }, true);
  if (imported.ok !== true && imported.error?.code !== 'no_change') throw new Error(`importAssets: ${JSON.stringify(imported.error)}`);
  const checked = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/files/check`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
  if (!checked.ok) throw new Error(`check files: ${checked.status} ${await checked.text()}`);
  const listed = await command('queryAssets', { limit: 100 }, false);
  if (listed.ok !== true) throw new Error(`queryAssets: ${JSON.stringify(listed.error)}`);
  const assets = (listed['assets'] ?? []) as Array<{ assetId: string; sourcePath?: string }>;
  const idOf = (set: PlaceholderSet, map: string): string => {
    const a = assets.find((x) => x.sourcePath === `${FOLDER}/${fileOf(set, map)}`);
    if (a === undefined) throw new Error(`${fileOf(set, map)} was not imported`);
    return a.assetId;
  };
  const setOf = (s: PlaceholderSet): Record<string, string> => Object.fromEntries(PLACEHOLDER_MAPS.map((m) => [m, idOf(s, m)]));
  for (const m of BENCH_MATERIALS) {
    const material = {
      materialId: `voxel-${m.name.toLowerCase().replace(/\W+/g, '-')}`,
      name: m.name,
      shader: 'standard',
      params: { color: m.color ?? '#ffffff' },
      textures: {},
      voxel: { id: m.id, use: m.use, ...(m.kit !== undefined ? { kit: m.kit } : {}), heightDepth: placeholderLook(m.wall).depthMetres, surfaces: { wall: setOf(m.wall), ...(m.floor !== undefined ? { floor: setOf(m.floor) } : {}), ...(m.ceiling !== undefined ? { ceiling: setOf(m.ceiling) } : {}) } },
    };
    let set = await command('setMaterial', { material }, true);
    if (set.error?.code === 'kit_missing') set = await command('setMaterial', { material: { ...material, voxel: { ...material.voxel, kit: undefined } } }, true);
    if (set.ok !== true && set.error?.code !== 'no_change') throw new Error(`setMaterial ${m.name}: ${JSON.stringify(set.error)}`);
    console.log(`[textures] material ${material.materialId} (voxel ${m.id}, ${m.use}): wall ${m.wall}${m.floor !== undefined ? `, floor ${m.floor}` : ''}${m.ceiling !== undefined ? `, ceiling ${m.ceiling}` : ''}: ${set.ok === true ? 'set' : set.error?.code}`);
  }
}

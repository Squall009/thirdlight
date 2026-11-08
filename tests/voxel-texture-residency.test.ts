/**
 * The voxel surfaces' texture arrays kept resident per quality level and
 * the texture budget: a real array KTX2 (two 1024² layers, the backend's
 * encoder), cut into its parts as a build ships it, streamed level by level
 * by the page's texture streamer and decoded by three's Basis transcoder
 * (the file the pages load). The need comes from a mesh drawing the arrays
 * in world space (the voxel surface's material lists them with its tile),
 * the cap from the quality level's texel density.
 */
import { PNG_SIGNATURE, pngChunk } from '@thirdlight/shared';
import { deflateSync } from 'node:zlib';

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { packKtx2, type PackLayer } from '../packages/backend/src/texture-encode';
import { readKtx2Layout } from '../packages/project-model/src/ktx2-levels';
import { DEFAULT_QUALITY_LEVELS, levelVoxels, VOXEL_TEXEL_DENSITY_BY_TIER, type QualityLevelConfig } from '../packages/project-model/src/quality-levels';
import { validateQualityLevels } from '../packages/project-model/src/materials';
import { VOXEL_AUTHORED_TEXEL_DENSITY, voxelArrayTopLevel } from '../packages/project-model/src/voxel-surface-textures';
import { createTextureStreamer, StreamedArrayTexture, WORLD_MAPPED_TEXTURES_KEY, wholeKtx2Source, type TextureStreamer } from '../packages/three-adapter/src/texture-streaming';
import { capVoxelArrays, voxelTexelDensityAt } from '../packages/three-adapter/src/voxel-world-draws';
import { transcodeKtx2Levels } from '../tools/voxel-bench/three-basis';

const EDGE = 1024;
const LAYERS = 2;

/** An RGB PNG whose texels differ at every mip level (a checkerboard over a gradient), tinted per layer. */
function layerPng(size: number, tint: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const r = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      r[1 + x * 3] = on ? 220 : tint;
      r[2 + x * 3] = Math.round((x / size) * 255);
      r[3 + x * 3] = Math.round((y / size) * 255);
    }
    rows.push(r);
  }
  return new Uint8Array(Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', new Uint8Array(0))]));
}

/** Transcodes a whole KTX2 as three's KTX2Loader does (every level, a level's layers one after another), to RGBA8. */
async function decode(bytes: Uint8Array): Promise<THREE.CompressedTexture> {
  const { levels, layers, width, height } = await transcodeKtx2Levels(bytes);
  const mipmaps = levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
  return layers > 1 ? new THREE.CompressedArrayTexture(mipmaps as never, width, height, layers, THREE.RGBAFormat as never) : new THREE.CompressedTexture(mipmaps as never, width, height, THREE.RGBAFormat as never);
}

/** A chunk-like mesh whose material samples `texture` in world space on a `tile` metre repeat, 0.5 m in front of the camera. */
function drawnWith(texture: THREE.Texture, tile: number): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; mesh: THREE.Mesh } {
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  material.userData[WORLD_MAPPED_TEXTURES_KEY] = { textures: [texture], tileMetres: tile };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.set(0, 0, -1);
  scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  return { scene, camera, mesh };
}

/** Plans and waits until every load the plan asks for has landed. */
async function settle(s: TextureStreamer, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
  for (let i = 0; i < 200; i++) {
    s.update(scene, camera, 720, true);
    if (s.pending() === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the streamer did not settle');
}

describe('voxel texture residency', () => {
  let ktx2: Uint8Array;
  beforeAll(async () => {
    const layer = (i: number): PackLayer => [{ source: i, channel: 0 }, { source: i, channel: 1 }, { source: i, channel: 2 }, { value: 255 }];
    const r = await packKtx2([layerPng(EDGE, 20), layerPng(EDGE, 120)], [layer(0), layer(1)], 'color');
    if (!r.ok) throw new Error(r.message);
    ktx2 = r.ktx2;
  }, 120_000);

  it('a tier keeps the authored set down to its texel density (4096² authored: low level 2, medium 1, high 0)', () => {
    expect(VOXEL_AUTHORED_TEXEL_DENSITY).toBe(1024);
    const authored = VOXEL_AUTHORED_TEXEL_DENSITY * 4;
    expect(DEFAULT_QUALITY_LEVELS.map((l) => [l.id, levelVoxels(l).texelDensity, voxelArrayTopLevel(authored, levelVoxels(l).texelDensity)])).toEqual([
      ['low', VOXEL_TEXEL_DENSITY_BY_TIER.low, 2],
      ['medium', VOXEL_TEXEL_DENSITY_BY_TIER.medium, 1],
      ['high', VOXEL_TEXEL_DENSITY_BY_TIER.high, 0],
    ]);
    // A set authored smaller than the density keeps its top; a level's own density lays over its tier's.
    expect(voxelArrayTopLevel(1024, 512)).toBe(0);
    expect(voxelArrayTopLevel(2048, 256)).toBe(1);
    expect(levelVoxels({ lighting: 'high', voxelTexelDensity: 128 }).texelDensity).toBe(128);
    expect(voxelTexelDensityAt('nope')).toEqual({ level: 'high', texelDensity: 1024 });
    const errors: Parameters<typeof validateQualityLevels>[2] = [];
    validateQualityLevels([{ id: 'a', voxelTexelDensity: 512 }, { id: 'b', voxelTexelDensity: 300 }] satisfies QualityLevelConfig[], '/qualityLevels', errors);
    expect(errors.map((e) => e.path)).toEqual(['/qualityLevels/1/voxelTexelDensity']);
  });

  it('streams the array level by level under the cap; a runtime cap change drops at once and streams back', async () => {
    const layout = readKtx2Layout(ktx2);
    if (!layout.ok) throw new Error(layout.message);
    expect(layout.layout.layers).toBe(LAYERS);
    const source = wholeKtx2Source(ktx2)!;
    // Head (metadata and the tail up to 128²), then 256², 512², 1024².
    expect(source.parts.map((p) => p.levels)).toEqual([[3, 4, 5, 6, 7, 8, 9, 10], [2], [1], [0]]);
    const streamer = createTextureStreamer({ budgetBytes: 64 * 1024 * 1024, decode, intervalMs: 0 });
    const tex = (await streamer.open('slots-voxel', source)) as StreamedArrayTexture;
    expect(tex).toBeInstanceOf(StreamedArrayTexture);
    expect(tex.image).toMatchObject({ width: 128, height: 128, depth: LAYERS });
    const { scene, camera } = drawnWith(tex, 4);
    const whole = await decode(ktx2);
    const levelBytes = (l: number): number => (EDGE >> l) ** 2 * 4 * LAYERS;
    const tailBytes = whole.mipmaps.slice(3).reduce((n, m) => n + (m as { data: Uint8Array }).data.length, 0);

    // 1024² on a 4 m tile is 256 px/m: a level keeping 64 px/m caps it at level 2 (256²).
    const capAt = (density: number): void => void capVoxelArrays({ albedoHeight: tex }, density, (t, l) => streamer.limit(t, l));
    capAt(64);
    await settle(streamer, scene, camera);
    let o = streamer.observe().textures[0]!;
    expect(o).toMatchObject({ layers: LAYERS, top: 2, resident: 2, wanted: 0, tail: 3 });
    expect(o.bytes).toBe(levelBytes(2) + tailBytes);
    expect(tex.image).toMatchObject({ width: 256, height: 256, depth: LAYERS });
    // The streamed level is the file's level, both layers (decoded from its own part).
    const top = tex.mipmaps[0] as { data: Uint8Array; width: number };
    expect(top.width).toBe(256);
    expect(Buffer.from(top.data).equals(Buffer.from((whole.mipmaps[2] as { data: Uint8Array }).data))).toBe(true);

    // Raised at run time (high: no cap): 512² then 1024² stream in, one level at a time.
    const before = streamer.observe();
    capAt(Infinity);
    await settle(streamer, scene, camera);
    o = streamer.observe().textures[0]!;
    expect(o).toMatchObject({ top: 0, resident: 0 });
    expect(streamer.observe().upgrades - before.upgrades).toBe(2);
    expect(o.bytes).toBe(levelBytes(0) + levelBytes(1) + levelBytes(2) + tailBytes);
    expect(Buffer.from((tex.mipmaps[0] as { data: Uint8Array }).data).equals(Buffer.from((whole.mipmaps[0] as { data: Uint8Array }).data))).toBe(true);

    // Lowered again (128 px/m: level 1): the top level goes in the same plan, nothing is read.
    const drops = streamer.observe().drops;
    capAt(128);
    streamer.update(scene, camera, 720, true);
    o = streamer.observe().textures[0]!;
    expect(o).toMatchObject({ top: 1, resident: 1 });
    expect(streamer.observe().drops).toBe(drops + 1);
    expect(streamer.pending()).toBe(0);
    expect(tex.image).toMatchObject({ width: 512, depth: LAYERS });
    streamer.dispose();
  }, 120_000);

  it('the budget keeps less than the cap allows, and far away the tail is enough', async () => {
    const tailOnly = createTextureStreamer({ budgetBytes: 1, decode, intervalMs: 0 });
    const tex = await tailOnly.open('slots-voxel', wholeKtx2Source(ktx2)!);
    const { scene, camera, mesh } = drawnWith(tex, 4);
    await settle(tailOnly, scene, camera);
    let obs = tailOnly.observe();
    // The tail always stays (over the 1-byte budget, said so).
    expect(obs.textures[0]).toMatchObject({ resident: 3, wanted: 0 });
    expect(obs.over).toBe(true);
    // Room for 512² and below, not 1024²: the plan stops at level 1 and the resident bytes stay inside it.
    const levelBytes = (l: number): number => (EDGE >> l) ** 2 * 4 * LAYERS;
    const budget = obs.residentBytes + levelBytes(2) + levelBytes(1) + 1024;
    tailOnly.setBudget(budget);
    await settle(tailOnly, scene, camera);
    obs = tailOnly.observe();
    expect(obs.textures[0]).toMatchObject({ resident: 1, wanted: 0 });
    expect(obs.residentBytes).toBeLessThanOrEqual(budget);
    expect(obs.over).toBe(false);
    // 200 m away a 4 m tile of 1024² needs no more than its tail: nothing more is asked for.
    mesh.position.set(0, 0, -200);
    tailOnly.update(scene, camera, 720, true);
    expect(tailOnly.observe().textures[0]!.wanted).toBe(3);
    tailOnly.dispose();
  }, 120_000);
});

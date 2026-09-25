/**
 * Phase 9.6: one bake of a scene, from the editor.
 *
 * The Scene view gathers the scene's static objects (world-space meshes with
 * UV1) and its baked lights; `packLightmaps` places each object's lightmap in
 * an atlas; the browser baker renders the atlases; each atlas is published as
 * a texture asset (a re-bake publishes a new version of the previous bake's
 * atlases) and `setLighting` records the bake.
 *
 * Browser-only.
 */
import { bakeHashes, packLightmaps, type BakeHashEntity, type LightmapPacking, type LightmapPlacement } from '@thirdlight/protocol';
import * as THREE from 'three';
import { bakeLightmapsInBrowser, boxLightmapSize, type BakeMeshInput, type BrowserBakeInput } from '@thirdlight/three-adapter';
import type { LightingBake } from '@thirdlight/project-model';

import { makeAssetId, type SessionClient } from '../session/client';
import { publishArgsFromProposal, utcSecondTimestamp, type ImportTarget } from '../session/asset-browser';
import type { ProjectedEntity } from '../session/projection';
import { editorRendererChoice } from './renderer-choice';
import { packBakeInput } from '../workers/bake-transfer';
import { editorWorkers } from '../workers/editor-workers';
import type { BakeJobResult } from '../workers/jobs';
import { encodePngOnPage } from '../workers/page-png';
import type { Viewport } from './viewport';

export interface BakeSettings {
  texelsPerMeter: number;
  /** Browser preview samples. */
  samples: number;
  /** Blender (final) samples and bounces. */
  finalSamples: number;
  bounces: number;
  /** Irradiance at texel value 1.0. */
  range: number;
}

export const DEFAULT_BAKE_SETTINGS: BakeSettings = { texelsPerMeter: 16, samples: 64, finalSamples: 512, bounces: 3, range: 4 };

const PADDING = 2;

/** The hash view of a projected entity (the same for the bake and the stale check). */
export function bakeHashEntity(e: ProjectedEntity): BakeHashEntity {
  return {
    id: e.id,
    parentId: e.parentId,
    active: e.active,
    static: e.static,
    components: {
      transform: { position: e.position, rotation: e.rotation, scale: e.scale },
      ...(e.box !== undefined ? { box: e.box } : {}),
      ...(e.kind === 'model' && e.assetId !== undefined ? { model: { assetId: e.assetId, ...(e.piece !== undefined ? { piece: e.piece } : {}) } } : {}),
      ...(e.materials !== undefined ? { materials: e.materials } : {}),
      ...(e.light !== undefined ? { light: e.light } : {}),
    },
  };
}

/** Whether a scene's bake no longer matches its static objects or baked lights. */
export function bakeIsStale(bake: LightingBake, sceneEntities: readonly ProjectedEntity[]): boolean {
  const h = bakeHashes(sceneEntities.map(bakeHashEntity));
  return h.staticsHash !== bake.staticsHash || h.lightsHash !== bake.lightsHash;
}

/** `where`: the preview bake ran in the editor worker or on the page (phase 22.1). */
export type BakeRunResult = { ok: true; bake: LightingBake; millis: number; skipped: string[]; device?: string; where?: 'worker' | 'page' } | { ok: false; message: string };

interface BakeDeps {
  client: SessionClient;
  viewport: Viewport;
  sceneId: string;
  sceneName: string;
  settings: BakeSettings;
  onProgress: (text: string, fraction: number) => void;
  signal?: AbortSignal;
}

/** The UV1 bounding box of an object's meshes. */
function uv1Box(meshes: readonly BakeMeshInput[]): { minU: number; minV: number; maxU: number; maxV: number } {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const m of meshes) {
    const uv = m.geometry.getAttribute('uv1');
    if (uv === undefined) continue;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  return Number.isFinite(minU) ? { minU, minV, maxU, maxV } : { minU: 0, minV: 0, maxU: 1, maxV: 1 };
}

type Prepared = {
  sceneEntities: ProjectedEntity[];
  inputs: ReturnType<Viewport['bakeInputs']>;
  packing: LightmapPacking;
  placement: Map<string, LightmapPlacement>;
};

/** Gather the scene's static objects and lights and place the lightmaps. */
function prepare(deps: BakeDeps, lightModes: readonly ('baked' | 'mixed')[]): Prepared | { message: string } {
  const { client, viewport, sceneId, settings } = deps;
  const sceneEntities = client.projection.listEntities().filter((e) => (e.sceneId ?? sceneId) === sceneId) as ProjectedEntity[];
  const statics = new Set(sceneEntities.filter((e) => e.static && e.active && (e.kind === 'box' || e.kind === 'model')).map((e) => e.id));
  if (statics.size === 0) return { message: 'nothing to bake: mark boxes or models as Static first (Inspector)' };
  const inputs = viewport.bakeInputs(statics);
  if (inputs.targets.length === 0) return { message: 'none of the static objects has a lightmap UV (UV1)' };
  if (!inputs.lights.some((l) => lightModes.includes(l.mode))) {
    return {
      message: lightModes.includes('mixed')
        ? 'no light is set to "baked" or "mixed"'
        : 'no light is set to "baked" (the browser preview bakes baked lights; mixed lights need the final bake)',
    };
  }
  // Only the part of UV1 an object uses gets its lightmap rectangle (a kit's
  // UV1 is one shared atlas: each piece uses a small region of it).
  const uvBoxes = new Map(inputs.targets.map((t) => [t.entityId, uv1Box(t.meshes)]));
  const items = inputs.targets.map((t) => {
    if (t.box !== null) return { id: t.entityId, ...boxLightmapSize(t.box.size, t.box.scale, settings.texelsPerMeter) };
    const box = uvBoxes.get(t.entityId)!;
    const aspect = Math.min(8, Math.max(1 / 8, (box.maxU - box.minU) / Math.max(1e-6, box.maxV - box.minV)));
    const side = Math.sqrt(t.area) * settings.texelsPerMeter * 1.25;
    return { id: t.entityId, width: Math.min(1024, Math.max(8, Math.ceil(side * Math.sqrt(aspect)))), height: Math.min(1024, Math.max(8, Math.ceil(side / Math.sqrt(aspect)))) };
  });
  const packed = packLightmaps(items, { maxSize: 2048, padding: PADDING });
  if ('error' in packed) return { message: packed.error };
  const packing: LightmapPacking = {
    atlases: packed.atlases,
    placements: packed.placements.map((p) => {
      const box = uvBoxes.get(p.id)!;
      const du = Math.max(1e-6, box.maxU - box.minU);
      const dv = Math.max(1e-6, box.maxV - box.minV);
      const sx = p.scaleOffset[0] / du;
      const sy = p.scaleOffset[1] / dv;
      return { ...p, scaleOffset: [sx, sy, p.scaleOffset[2] - box.minU * sx, p.scaleOffset[3] - box.minV * sy] as [number, number, number, number] };
    }),
  };
  return { sceneEntities, inputs, packing, placement: new Map(packing.placements.map((p) => [p.id, p])) };
}

/** Publish the atlases (a re-bake adds versions to the previous atlases) and record the bake. */
async function publish(deps: BakeDeps, prepared: Prepared, pngs: readonly Uint8Array[], meta: { source: 'browser' | 'blender'; samples: number; bounces: number; bakedLights: string[] }): Promise<LightingBake | { message: string }> {
  const { client, sceneId, settings } = deps;
  const previous = client.getLighting()[sceneId] ?? null;
  const atlasIds: string[] = [];
  for (let i = 0; i < pngs.length; i++) {
    deps.onProgress(`saving lightmap ${i + 1}/${pngs.length}`, 0.9 + (0.1 * i) / pngs.length);
    const reuse = previous?.atlases[i];
    const displayName = `lightmap ${deps.sceneName} ${i + 1}`;
    const target: ImportTarget =
      reuse !== undefined && client.content.resolveVersion(reuse) !== null ? { mode: 'reimport', assetId: reuse, displayName } : { mode: 'create', assetId: makeAssetId(), displayName };
    const up = await client.uploadAsset(pngs[i]!, { kind: 'texture', displayName, target });
    if (!up.ok) return { message: `lightmap upload failed: ${up.error.message}` };
    const args = publishArgsFromProposal(up.proposal, target, utcSecondTimestamp(), 'texture');
    if (!args.ok) return { message: `lightmap publish failed: ${args.error.message}` };
    const res = await client.command('publishAsset', args.args, client.projection.revision);
    if (!res.ok) return { message: `lightmap publish refused: ${(res.response as { message?: string }).message ?? 'unknown'}` };
    atlasIds.push(String((args.args as { assetId: string }).assetId));
  }
  const hashes = bakeHashes(prepared.sceneEntities.map(bakeHashEntity));
  const bake: LightingBake = {
    bakeId: `bake-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    source: meta.source,
    range: settings.range,
    texelsPerMeter: settings.texelsPerMeter,
    samples: meta.samples,
    bounces: meta.bounces,
    atlases: atlasIds,
    entries: prepared.packing.placements.map((p) => ({ entityId: p.id, atlas: p.atlas, scaleOffset: p.scaleOffset })),
    bakedLights: meta.bakedLights,
    lightsHash: hashes.lightsHash,
    staticsHash: hashes.staticsHash,
  };
  const res = await client.command('setLighting', { sceneId, lighting: bake }, client.projection.revision);
  if (!res.ok) return { message: `the bake was refused: ${(res.response as { message?: string }).message ?? 'unknown'}` };
  deps.onProgress('done', 1);
  return bake;
}

/** "Bake preview": direct light and sky occlusion of the baked lights, in this browser. */
export async function runBrowserBake(deps: BakeDeps): Promise<BakeRunResult> {
  const prepared = prepare(deps, ['baked']);
  if ('message' in prepared) return { ok: false, message: prepared.message };
  const baked = prepared.inputs.lights.filter((l) => l.mode === 'baked');
  deps.onProgress('baking…', 0);
  const input: Omit<BrowserBakeInput, 'onProgress' | 'signal' | 'canvas'> = {
    atlases: prepared.packing.atlases,
    targets: prepared.inputs.targets.map((t) => {
      const p = prepared.placement.get(t.entityId)!;
      return { entityId: t.entityId, atlas: p.atlas, scaleOffset: p.scaleOffset, meshes: t.meshes };
    }),
    occluders: prepared.inputs.occluders,
    lights: baked,
    samples: deps.settings.samples,
    range: deps.settings.range,
    padding: PADDING,
    // Phase 17.3: the bake draws with the editor's renderer backend (like its previews).
    renderer: editorRendererChoice().preference,
  };
  const onProgress = (done: number, total: number): void => deps.onProgress(`baking ${done}/${total}`, (done / total) * 0.9);
  /** On the page, as before 22.1: the renderer on a DOM canvas, then the PNGs. */
  const onPage = async (): Promise<BakeJobResult> => {
    const r = await bakeLightmapsInBrowser({ ...input, onProgress, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) });
    if (!r.ok) return r;
    const pngs: Uint8Array[] = [];
    for (const atlas of r.atlases) pngs.push(await encodePngOnPage({ pixels: atlas.pixels, width: atlas.width, height: atlas.height }));
    return { ok: true, pngs, millis: r.millis };
  };
  // Phase 22.1: the whole bake (rendering on an OffscreenCanvas, read-back,
  // dilation, encoding) in a worker; on the page when there is none, or when
  // the worker's canvas gets no renderer (then the page's might).
  const workers = editorWorkers();
  let result: BakeJobResult;
  try {
    result = await workers.run('bake', () => packBakeInput(input), { lane: 'gpu', inline: onPage, onProgress, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  let where: 'worker' | 'page' = workers.lastMode.get('bake') === 'worker' ? 'worker' : 'page';
  if (!result.ok && result.code === 'bake_unsupported' && where === 'worker') {
    result = await onPage();
    where = 'page';
  }
  // A user-timing mark (DevTools, the e2e): the lightmaps are baked and encoded; what follows is publishing them.
  performance.mark('tl:bake:rendered');
  if (!result.ok) return { ok: false, message: result.message };
  const pngs = result.pngs;
  const bake = await publish(deps, prepared, pngs, { source: 'browser', samples: deps.settings.samples, bounces: 0, bakedLights: baked.map((l) => l.entityId) });
  if ('message' in bake) return { ok: false, message: bake.message };
  return { ok: true, bake, millis: result.millis, skipped: prepared.inputs.missingUv, where };
}

/** The bake package the backend hands to Blender (see backend bake.ts). */
export function buildBakePackage(prepared: Prepared, settings: BakeSettings): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const put = (a: Float32Array | Uint32Array): number => {
    const at = size;
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    chunks.push(bytes);
    size += bytes.byteLength;
    return at;
  };
  const geometryIds = new Map<THREE.BufferGeometry, string>();
  const geometries: Record<string, unknown>[] = [];
  const geometry = (g: THREE.BufferGeometry, withUv: boolean): string => {
    const key = geometryIds.get(g);
    if (key !== undefined) return key;
    const id = `g${geometries.length}`;
    geometryIds.set(g, id);
    const pos = g.getAttribute('position');
    const n = pos.count;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = pos.getX(i);
      positions[i * 3 + 1] = pos.getY(i);
      positions[i * 3 + 2] = pos.getZ(i);
    }
    const uvAttr = g.getAttribute('uv1');
    let uv: Float32Array | null = null;
    if (withUv && uvAttr !== undefined) {
      uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        uv[i * 2] = uvAttr.getX(i);
        uv[i * 2 + 1] = uvAttr.getY(i);
      }
    }
    const index = g.getIndex();
    const idx = index !== null ? Uint32Array.from({ length: index.count }, (_, i) => index.getX(i)) : null;
    geometries.push({
      id,
      vertexCount: n,
      position: put(positions),
      uv1: uv !== null ? put(uv) : null,
      index: idx !== null ? put(idx) : null,
      indexCount: idx !== null ? idx.length : 0,
    });
    return id;
  };
  const objects: Record<string, unknown>[] = [];
  const mesh = (m: BakeMeshInput, entityId: string, p: LightmapPlacement | null): void => {
    objects.push({ entityId, geometry: geometry(m.geometry, p !== null), matrix: Array.from(m.matrixWorld.elements), atlas: p?.atlas ?? null, scaleOffset: p?.scaleOffset ?? null });
  };
  for (const t of prepared.inputs.targets) for (const m of t.meshes) mesh(m, t.entityId, prepared.placement.get(t.entityId)!);
  prepared.inputs.occluders.forEach((m, i) => mesh(m, `occluder-${i}`, null));
  const header = new TextEncoder().encode(
    JSON.stringify({
      atlases: prepared.packing.atlases,
      geometries,
      objects,
      lights: prepared.inputs.lights,
      settings: { samples: settings.finalSamples, bounces: settings.bounces, range: settings.range, padding: PADDING, denoise: true },
    }),
  );
  const pad = (4 - ((12 + header.byteLength) % 4)) % 4;
  const out = new Uint8Array(12 + header.byteLength + pad + size);
  out.set([0x54, 0x4c, 0x42, 0x4b], 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, header.byteLength, true);
  out.set(header, 12);
  let at = 12 + header.byteLength + pad;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "Bake final": Blender Cycles on the bake host (bounce light; baked and mixed lights). */
export async function runBlenderBake(deps: BakeDeps): Promise<BakeRunResult> {
  const prepared = prepare(deps, ['baked', 'mixed']);
  if ('message' in prepared) return { ok: false, message: prepared.message };
  const { client } = deps;
  deps.onProgress('sending the scene to the bake host…', 0);
  const started = await client.startBake(buildBakePackage(prepared, deps.settings));
  if (!started.ok) return { ok: false, message: started.error.message };
  const jobId = started.jobId;
  let millis = 0;
  let device: string | null = null;
  for (;;) {
    if (deps.signal?.aborted === true) {
      await client.cancelBake(jobId);
      return { ok: false, message: 'the bake was cancelled' };
    }
    await sleep(1000);
    const st = await client.bakeJob(jobId);
    if (!st.ok) return { ok: false, message: st.error.message };
    const j = st.job;
    device = j.device ?? device;
    if (j.state === 'failed' || j.state === 'cancelled') return { ok: false, message: j.message ?? j.state };
    if (j.state === 'done') {
      millis = j.millis ?? 0;
      break;
    }
    deps.onProgress(`Blender${j.device !== null ? ` (${j.device})` : ''}: ${j.progress.done}/${j.progress.total}`, 0.05 + 0.8 * (j.progress.total > 0 ? j.progress.done / j.progress.total : 0));
  }
  const pngs: Uint8Array[] = [];
  for (let i = 0; i < prepared.packing.atlases.length; i++) pngs.push(await client.bakeAtlas(jobId, i));
  const bakedLights = prepared.inputs.lights.filter((l) => l.mode === 'baked').map((l) => l.entityId);
  const bake = await publish(deps, prepared, pngs, { source: 'blender', samples: deps.settings.finalSamples, bounces: deps.settings.bounces, bakedLights });
  if ('message' in bake) return { ok: false, message: bake.message };
  return { ok: true, bake, millis, skipped: prepared.inputs.missingUv, ...(device !== null ? { device } : {}) };
}

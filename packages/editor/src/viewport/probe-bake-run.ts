/**
 * One probe bake of a scene, from the editor ("Bake probes").
 *
 * The tiles go over the scene's probe volumes, or over its static objects
 * when it has none (`placeProbeGrids`); the Scene view's renderer bakes them
 * (`bakeProbeGrids`, WebGPU); each tile's probes are published as a texture
 * asset (a re-bake publishes new versions of the previous bake's files, tile
 * by tile) and `setLighting` records them in the scene's bake as `probes`,
 * next to its lightmaps (which stay as they are).
 *
 * Browser-only.
 */
import { bakeHashes, type BakeHashEntity } from '@thirdlight/protocol';
import { bakeProbeGrids, encodePng16, packProbeTexels, skyTurnDegrees, type ProbeBakeResult } from '@thirdlight/three-adapter';
import { DEFAULT_PROBE_BOUNCES, DEFAULT_PROBE_SPACING, placeProbeGrids, probeGridGpuBytes } from '@thirdlight/runtime';
import type { LightingBake, ProbeBake } from '@thirdlight/project-model';
import type * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import type { SessionClient } from '../session/client';
import type { ProjectedEntity } from '../session/projection';
import { bakeHashEntity, publishBakeTexture } from './bake-run';
import { gatherProbeMeshes, probeVolumesOf } from './probe-bake-inputs';
import type { Viewport } from './viewport';

export interface ProbeBakeSettings {
  /** Meters between probes horizontally (half that vertically near the ground). */
  spacing: number;
  /** Extra bounce passes. */
  bounces: number;
}

export const DEFAULT_PROBE_BAKE_SETTINGS: ProbeBakeSettings = { spacing: DEFAULT_PROBE_SPACING, bounces: DEFAULT_PROBE_BOUNCES };

/** Why this view cannot bake probes (null: it can). */
export function probeBakeUnavailable(api: string | null): string | null {
  return api === 'webgpu' ? null : 'baking probes needs WebGPU; the Scene view draws with WebGL 2 (baked probes still draw)';
}

export type ProbeBakeRunResult = { ok: true; probes: ProbeBake; millis: number; fileBytes: number } | { ok: false; message: string };

interface ProbeBakeDeps {
  client: SessionClient;
  viewport: Viewport;
  sceneId: string;
  sceneName: string;
  settings: ProbeBakeSettings;
  onProgress: (text: string, fraction: number) => void;
  signal?: AbortSignal;
}

export async function runProbeBake(deps: ProbeBakeDeps): Promise<ProbeBakeRunResult> {
  const { client, viewport, sceneId, settings } = deps;
  const sceneEntities = client.projection.listEntities().filter((e) => (e.sceneId ?? sceneId) === sceneId) as ProjectedEntity[];
  const statics = new Set(
    sceneEntities
      .filter((e) => {
        if (!e.static || !e.active) return false;
        const layer = e.components['blockLayer'] as { metadataOnly?: boolean } | undefined;
        return e.kind === 'box' || e.kind === 'model' || (layer !== undefined && layer.metadataOnly !== true);
      })
      .map((e) => e.id),
  );
  const ctx = viewport.probeBakeContext();
  const api = viewport.rendererInfo().api;
  const unavailable = probeBakeUnavailable(api);
  if (unavailable !== null || ctx.renderer === null) return { ok: false, message: unavailable ?? 'the Scene view has no renderer yet' };
  const { meshes, bounds } = gatherProbeMeshes(ctx.host, statics);
  const volumes = probeVolumesOf(ctx.host, sceneEntities);
  const grids = placeProbeGrids(bounds, settings.spacing, volumes);
  if (grids.length === 0) return { ok: false, message: 'nothing to bake: mark boxes, models or block layers as Static, or add a probe volume' };
  const live = ctx.scene;
  const sky = {
    environment: live?.environment ?? null,
    intensity: live?.environmentIntensity ?? 1,
    color: (live?.background as THREE.Color | null)?.isColor === true ? (live!.background as THREE.Color) : null,
    rotation: live?.environmentRotation.y ?? 0,
  };
  const skyTurn = skyTurnDegrees(client.getSceneEnvironment(sceneId)?.sky);
  deps.onProgress('baking probes…', 0);
  const baked: ProbeBakeResult = await bakeProbeGrids({
    renderer: ctx.renderer as WebGPURenderer,
    meshes,
    lights: ctx.lights,
    sky,
    grids,
    bounces: settings.bounces,
    onProgress: (text, fraction) => deps.onProgress(text, fraction * 0.9),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  // A user-timing mark (DevTools, the e2e): the probes are baked; what follows is publishing them.
  performance.mark('tl:probes:baked');
  if (!baked.ok) return { ok: false, message: baked.message };

  const previous = client.getLighting()[sceneId] ?? null;
  const assets: string[] = [];
  let fileBytes = 0;
  for (let i = 0; i < grids.length; i++) {
    deps.onProgress(`saving probes ${i + 1}/${grids.length}`, 0.9 + (0.1 * i) / grids.length);
    const tile = baked.tiles[i]!;
    const packed = packProbeTexels(tile.sh, tile.validity, tile.walls);
    const png = await encodePng16(packed.width, packed.height, packed.samples);
    fileBytes += png.byteLength;
    const id = await publishBakeTexture(client, png, `probes ${deps.sceneName} ${i + 1}`, previous?.probes?.grids[i]?.asset, 'probe file');
    if (typeof id !== 'string') return { ok: false, message: id.message };
    assets.push(id);
  }
  const hashes = bakeHashes(sceneEntities.map((e): BakeHashEntity => bakeHashEntity(e, (id) => client.getBlockLayers().get(id)?.chunks)));
  const createdAt = new Date().toISOString();
  const probes: ProbeBake = {
    createdAt,
    spacing: settings.spacing,
    bounces: settings.bounces,
    grids: grids.map((g, i) => ({ min: g.min, max: g.max, resolution: g.resolution, asset: assets[i]! })),
    probes: baked.probes,
    moved: baked.moved,
    filled: baked.filled,
    gpuBytes: grids.reduce((n, g) => n + probeGridGpuBytes(g), 0),
    lightsHash: hashes.lightsHash,
    staticsHash: hashes.staticsHash,
    ...(skyTurn !== 0 ? { skyRotation: skyTurn } : {}),
  };
  // A scene without lightmaps gets a bake record of probes only (no atlases, no entries).
  const lighting: LightingBake =
    previous !== null
      ? { ...previous, probes }
      : { bakeId: `bake-${Date.now().toString(36)}`, createdAt, source: 'browser', range: 1, texelsPerMeter: 1, samples: 1, bounces: settings.bounces, atlases: [], entries: [], bakedLights: [], lightsHash: hashes.lightsHash, staticsHash: hashes.staticsHash, probes };
  const res = await client.command('setLighting', { sceneId, lighting }, client.projection.revision);
  if (!res.ok) return { ok: false, message: `the probes were refused: ${(res.response as { message?: string }).message ?? 'unknown'}` };
  deps.onProgress('done', 1);
  return { ok: true, probes, millis: baked.millis, fileBytes };
}

/** The scene's bake without its probes (null when nothing else is left). */
export function withoutProbes(bake: LightingBake): LightingBake | null {
  if (bake.atlases.length === 0) return null;
  const rest = { ...bake };
  delete rest.probes;
  return rest;
}

/** The scene's bake without its lightmaps (null when it has no probes either). */
export function withoutLightmaps(bake: LightingBake): LightingBake | null {
  if (bake.probes === undefined) return null;
  return { ...bake, atlases: [], entries: [], bakedLights: [] };
}

/**
 * Whether the probes no longer match the scene's static objects, baked
 * lights or the sky's turn (`skyTurn`, degrees: the probes hold the sky as it
 * was turned at the bake) — they are still used.
 */
export function probesAreStale(probes: ProbeBake, sceneEntities: readonly ProjectedEntity[], cellsOf: Parameters<typeof bakeHashEntity>[1], skyTurn = 0): boolean {
  const h = bakeHashes(sceneEntities.map((e) => bakeHashEntity(e, cellsOf)));
  return h.staticsHash !== probes.staticsHash || h.lightsHash !== probes.lightsHash || Math.abs((probes.skyRotation ?? 0) - skyTurn) > 1e-6;
}

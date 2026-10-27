/**
 * "Bake lighting" of a scene: the Scene view's live lighting run to settled
 * on its WebGPU device (`SceneAdapter.bakeLighting`), saved as texture
 * assets holding the saved file (`surface-bake-file.ts`; a re-bake
 * publishes new versions of the previous bake's files) and recorded by
 * `setLighting` as the scene's bake (`surface`). The same run answers the
 * Lighting window's button and an agent's `tl_bake_lighting` (the backend
 * asks the editor page): every change it makes goes through the commands.
 *
 * Browser-only.
 */
import { bakeHashes, hash16, type BakeHashEntity } from '@thirdlight/protocol';
import { encodeSavedSurface, savedSurfaceFiles, skyTurnDegrees, SURFACE_TEXEL_METRES } from '@thirdlight/three-adapter';
import type { BlockChunk, LightingBake, SurfaceBake } from '@thirdlight/project-model';

import type { SessionClient } from '../session/client';
import type { ProjectedEntity } from '../session/projection';
import { publishFileAsset } from '../session/publish-file';
import type { Viewport } from './viewport';

/** A block layer's stored cells, per layer entity (what a bake of the layer was made from). */
export type BlockCellsOf = (entityId: string) => ReadonlyMap<string, BlockChunk> | undefined;

const cellDigests = new WeakMap<ReadonlyMap<string, BlockChunk>, string>();

/** A digest of a layer's chunks (cached per stored chunk map: the client replaces the map when cells change). */
function cellsDigest(chunks: ReadonlyMap<string, BlockChunk>): string {
  let d = cellDigests.get(chunks);
  if (d === undefined) {
    d = hash16(JSON.stringify([...chunks.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
    cellDigests.set(chunks, d);
  }
  return d;
}

/** The hash view of a projected entity (the same for the bake and the stale check); a block layer carries its cells' digest. */
export function bakeHashEntity(e: ProjectedEntity, cellsOf?: BlockCellsOf): BakeHashEntity {
  const layer = e.components['blockLayer'];
  const chunks = layer !== undefined ? cellsOf?.(e.id) : undefined;
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
      ...(layer !== undefined ? { blockLayer: { ...(layer as Record<string, unknown>), ...(chunks !== undefined ? { cells: cellsDigest(chunks) } : {}) } } : {}),
      ...(e.components['architecture'] !== undefined ? { architecture: e.components['architecture'] } : {}),
    },
  };
}

/** Two turns in degrees are the same turn (0 and 360, 180 and −180 are). */
export function sameTurn(a: number, b: number): boolean {
  const d = (((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d) < 1e-6;
}

export interface LightingBakeDeps {
  client: SessionClient;
  viewport: Viewport;
  sceneId: string;
  sceneName: string;
  onProgress: (text: string, fraction: number) => void;
  signal?: AbortSignal;
}

export type LightingBakeResult = { ok: true; bake: LightingBake; millis: number } | { ok: false; message: string };

/** What a bake reports in words (the Lighting window's message, an agent's answer). */
export function lightingBakeSummary(s: SurfaceBake): string {
  return `Baked lighting in ${(s.millis / 1000).toFixed(1)} s: ${s.tiles} surface tiles at ${(SURFACE_TEXEL_METRES * 2 ** s.level * 100).toFixed(0)} cm texels on ${s.pages} pages, ${s.probes} probes, ${(s.bytes / 1024).toFixed(0)} KB of files.`;
}

export async function runLightingBake(deps: LightingBakeDeps): Promise<LightingBakeResult> {
  const { client, viewport, sceneId } = deps;
  if (viewport.getLighting() !== 'game') viewport.setLighting('game');
  const ran = await viewport.bakeLighting({ onProgress: (text, f) => deps.onProgress(text, f * 0.9), ...(deps.signal !== undefined ? { signal: deps.signal } : {}) });
  if (!ran.ok) return ran;
  // A user-timing mark (DevTools, the e2e): the light is settled and read back; what follows is saving it.
  performance.mark('tl:lighting:baked');
  const sceneEntities = client.projection.listEntities().filter((e) => (e.sceneId ?? sceneId) === sceneId) as ProjectedEntity[];
  // Only this scene's surfaces (other open scenes' tiles were lit beside them); a tile's key starts with its entity's id.
  const own = new Set(sceneEntities.map((e) => e.id));
  const saved = { ...ran.saved, tiles: ran.saved.tiles.filter((t) => own.has(t.key.split('/')[0]!)) };
  if (saved.tiles.length === 0 && saved.probes.length === 0) return { ok: false, message: 'nothing to bake: the scene has no static surfaces the lighting keeps (block layers, generated architecture, static models)' };
  deps.onProgress('saving…', 0.9);
  const files = await savedSurfaceFiles(encodeSavedSurface(saved));
  const previous = client.getLighting()[sceneId] ?? null;
  const ids: string[] = [];
  let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    deps.onProgress(`saving ${i + 1}/${files.length}`, 0.9 + (0.1 * i) / files.length);
    const id = await publishFileAsset(client, files[i]!, `lighting ${deps.sceneName}${files.length > 1 ? ` ${i + 1}` : ''}`, previous?.surface?.files[i], 'lighting file');
    if (typeof id !== 'string') return { ok: false, message: id.message };
    ids.push(id);
    bytes += files[i]!.byteLength;
  }
  const hashes = bakeHashes(sceneEntities.map((e): BakeHashEntity => bakeHashEntity(e, (id) => client.getBlockLayers().get(id)?.chunks)));
  const skyTurn = skyTurnDegrees(client.getSceneEnvironment(sceneId)?.sky);
  const createdAt = new Date().toISOString();
  const surface: SurfaceBake = {
    createdAt,
    files: ids,
    level: ran.saved.level,
    tiles: saved.tiles.length,
    pages: ran.saved.pages,
    probes: saved.probes.reduce((n, p) => n + p.validity.length, 0),
    bytes,
    millis: ran.millis,
    lightsHash: hashes.lightsHash,
    staticsHash: hashes.staticsHash,
    ...(skyTurn !== 0 ? { skyRotation: skyTurn } : {}),
  };
  // The baked lights leave per-pixel drawing while the bake is used (the cache holds their light).
  const bakedLights = sceneEntities.filter((e) => e.active && (e.light as { mode?: string } | undefined)?.mode === 'baked').map((e) => e.id);
  const bake: LightingBake = {
    bakeId: `bake-${Date.now().toString(36)}`,
    createdAt,
    source: 'cache',
    range: 1,
    texelsPerMeter: 1 / (SURFACE_TEXEL_METRES * 2 ** ran.saved.level),
    samples: 1,
    bounces: 0,
    atlases: [],
    entries: [],
    bakedLights,
    lightsHash: hashes.lightsHash,
    staticsHash: hashes.staticsHash,
    surface,
  };
  const res = await client.command('setLighting', { sceneId, lighting: bake }, client.projection.revision);
  if (!res.ok) return { ok: false, message: `the bake was refused: ${(res.response as { message?: string }).message ?? 'unknown'}` };
  deps.onProgress('done', 1);
  return { ok: true, bake, millis: ran.millis };
}

/** Whether a scene's saved lighting no longer matches its static objects, baked or mixed lights or the sky's turn (it is still drawn). */
export function surfaceBakeIsStale(surface: SurfaceBake, sceneEntities: readonly ProjectedEntity[], cellsOf: BlockCellsOf, skyTurn = 0): boolean {
  const h = bakeHashes(sceneEntities.map((e) => bakeHashEntity(e, cellsOf)));
  return h.staticsHash !== surface.staticsHash || h.lightsHash !== surface.lightsHash || !sameTurn(surface.skyRotation ?? 0, skyTurn);
}

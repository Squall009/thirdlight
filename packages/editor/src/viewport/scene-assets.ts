/**
 * What the Scene view loads from assets, held in one resource manager — the
 * same manager a game page holds its resources in (`@thirdlight/runtime`).
 *
 * The model files the placements show are held by the objects that show them
 * (the scene adapter's realization, as in Play) and the decoded textures by
 * the materials that draw with them; when the editor opens another scene, the
 * objects of the one before let go and what no object of the new scene holds
 * is freed (a model both scenes use stays). The frees run in a task after the
 * change, once the view's objects for the new scene took their holds. The
 * editor's own reads (a file's pieces, a thumbnail, a preview) go through
 * the same manager, so a file is parsed once whoever asks.
 *
 * The authoring token never reaches the renderer: the bytes come through the
 * session client's authenticated reads.
 */
import * as THREE from 'three';
import { createResourceManager, type ResourceManager, type ResourceObservation } from '@thirdlight/runtime';
import { createMaterialLibrary, decodeTexture, isKtx2, type MaterialLibrary, type SceneAdapterModelAsset, type SceneAdapterModels } from '@thirdlight/three-adapter';

import type { SessionClient } from '../session/client';
import { parseSlotTextureKey } from '../session/texture-slots';
import { ModelFiles } from './model-files';

export interface SceneViewAssets {
  readonly resources: ResourceManager;
  /** A texture asset's current version, decoded (lights' cookies, the environment, lightmaps). */
  readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  readonly loadBytes: (assetId: string) => Promise<Uint8Array>;
  readonly materialLibrary: MaterialLibrary;
  /** The model rows and bytes the scene adapter realizes placements from (rows follow reimports). */
  readonly models: SceneAdapterModels;
  /** The editor's own reads of model files (pieces, colliders, thumbnails, previews). */
  readonly files: ModelFiles;
  /** What decides how an asset's placements are drawn (its version, vertex colours, default materials, images). */
  assetKey(assetId: string): string;
  /** Report what is resident now (a model or texture arrived). */
  report(): void;
  dispose(): void;
}

/** A copy of exactly these bytes (the adapter keeps what it is handed). */
const ownBuffer = (b: ArrayBufferView): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export function createSceneViewAssets(o: {
  readonly client: SessionClient;
  /** Something the Scene view draws changed (a material's texture arrived, a preview attached). */
  readonly changed: () => void;
  /** What is resident after each settle, load or change (the view shows it as `data-resources`). */
  readonly onResources?: (observation: ResourceObservation) => void;
  readonly onSetBuilt?: (entityId: string, chunks: number) => void;
  readonly onFailuresChanged?: (failures: ReadonlyMap<string, { code: string; message: string }>) => void;
}): SceneViewAssets {
  const { client } = o;
  const report = (): void => o.onResources?.(resources.observe());
  const resources = createResourceManager({
    schedule: (settle) =>
      setTimeout(() => {
        settle();
        report();
      }, 0),
  });
  const loadTexture = async (assetId: string): Promise<THREE.Texture | null> => {
    // A material's per-layer slots: the array the backend assembles from them.
    const slots = parseSlotTextureKey(assetId);
    if (slots !== null) return decodeTexture(await client.textureSlotBytes(slots.layers, slots.mode));
    // A texture the editor has not read the facts of yet is read by id first (the editor holds no whole catalog).
    await client.catalog.ensureAssets([assetId]);
    const v = client.content.resolveVersion(assetId);
    if (v === null) return null;
    const bytes = await client.assetBytes(assetId, v.version);
    // A KTX2 texture transcodes with three's Basis files next to the editor page.
    if (isKtx2(bytes)) return decodeTexture(bytes);
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
    t.needsUpdate = true;
    return t;
  };
  // Project materials (shared by boxes, models and instance sets).
  const materialLibrary = createMaterialLibrary({
    loadTexture,
    resources,
    onChange: () => {
      o.changed();
      report();
    },
  });
  /** A model asset's row as the adapter reads it (one object per version, so it compares equal while nothing changed). */
  const rows = new Map<string, SceneAdapterModelAsset>();
  const rowOf = (assetId: string): SceneAdapterModelAsset | undefined => {
    const v = client.content.resolveVersion(assetId);
    if (v === null || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) return undefined;
    const a = client.content.getAsset(assetId);
    const key = `${assetId}@${v.version}`;
    const hit = rows.get(key);
    if (hit !== undefined && hit.materials === a?.materials && hit.textures === a?.textures && hit.vertexColors === (a?.vertexColors === 'tint' ? 'tint' : undefined) && hit.clipsFor === a?.clipsFor) return hit;
    const row: SceneAdapterModelAsset = {
      assetId,
      version: v.version,
      sourceDigest: v.sourceDigest,
      ...(a?.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
      ...(a?.materials !== undefined ? { materials: a.materials } : {}),
      ...(a?.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
      ...(a?.textures !== undefined ? { textures: a.textures } : {}),
    };
    rows.set(key, row);
    return row;
  };
  const models: SceneAdapterModels = {
    assets: [],
    animation: [],
    liveRows: true,
    rowOf,
    findRow: async (assetId) => {
      await client.catalog.ensureAssets([assetId]);
      return rowOf(assetId);
    },
    resolveBytes: async (assetId, version) => ownBuffer(await client.assetBytes(assetId, version)),
    resolveBuffer: async (digest) => ownBuffer(await client.instanceBufferBytes(digest)),
    loadTexture,
    ...(o.onSetBuilt !== undefined ? { onInstanceSetBuilt: o.onSetBuilt } : {}),
  };
  const files = new ModelFiles({
    resolve: client.assetByteResolver(),
    resources,
    descriptorFor: (assetId) => {
      const v = client.content.resolveVersion(assetId);
      if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) return null;
      return { assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength };
    },
    ensureDescriptor: (assetId) => client.catalog.ensureAssets([assetId]),
    onChanged: () => {
      o.changed();
      report();
    },
    loadTexture,
    assetTexturesFor: (assetId) => client.content.getAsset(assetId)?.textures ?? null,
    ...(o.onFailuresChanged !== undefined ? { onFailuresChanged: o.onFailuresChanged } : {}),
  });
  /** A texture asset's stored bytes (the probe tiles' files are data, never decoded as images). */
  const loadBytes = async (assetId: string): Promise<Uint8Array> => {
    await client.catalog.ensureAssets([assetId]);
    const v = client.content.resolveVersion(assetId);
    if (v === null) throw new Error(`${assetId} is not an asset of this project`);
    return client.assetBytes(assetId, v.version);
  };
  return {
    resources,
    loadTexture,
    loadBytes,
    materialLibrary,
    models,
    files,
    assetKey: (assetId) => {
      const row = rowOf(assetId);
      return row === undefined ? '' : JSON.stringify([row.version, row.vertexColors ?? null, row.materials ?? null, row.textures ?? null, row.clipsFor ?? null]);
    },
    report,
    dispose() {
      materialLibrary.dispose();
      files.dispose();
      resources.dispose();
    },
  };
}

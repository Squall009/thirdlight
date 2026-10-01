/**
 * What the Scene view loads from assets, held in one resource manager — the
 * same manager a game page holds its resources in (`@thirdlight/runtime`).
 *
 * The model files the placements show are held by the objects that show them
 * and the decoded textures by the materials that draw with them; when the
 * editor opens another scene, the objects of the one before let go and what
 * no object of the new scene holds is freed (a model both scenes use stays).
 * The frees run in a task after the change, once the view's objects for the
 * new scene took their holds.
 *
 * The authoring token never reaches the renderer: the bytes come through the
 * session client's authenticated reads.
 */
import * as THREE from 'three';
import { createResourceManager, type ResourceManager, type ResourceObservation } from '@thirdlight/runtime';
import { createMaterialLibrary, decodeTexture, isKtx2, type MaterialLibrary } from '@thirdlight/three-adapter';

import type { SessionClient } from '../session/client';
import { ModelInstances } from './model-instances';
import type { Viewport } from './viewport';

export interface SceneViewAssets {
  readonly resources: ResourceManager;
  /** A texture asset's current version, decoded (lights' cookies, the environment, lightmaps). */
  readonly loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  readonly materialLibrary: MaterialLibrary;
  readonly models: ModelInstances;
  dispose(): void;
}

export function createSceneViewAssets(o: {
  readonly client: SessionClient;
  readonly viewport: Viewport;
  /** What is resident after each settle, load or change (the view shows it as `data-resources`). */
  readonly onResources?: (observation: ResourceObservation) => void;
  readonly onSetBuilt?: (entityId: string, chunks: number) => void;
  readonly onFailuresChanged?: (failures: ReadonlyMap<string, { code: string; message: string }>) => void;
}): SceneViewAssets {
  const { client, viewport } = o;
  const report = (): void => o.onResources?.(resources.observe());
  const resources = createResourceManager({
    schedule: (settle) =>
      setTimeout(() => {
        settle();
        report();
      }, 0),
  });
  const loadTexture = async (assetId: string): Promise<THREE.Texture | null> => {
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
      viewport.requestRender();
      report();
    },
  });
  const models = new ModelInstances(viewport.scene, {
    resolve: client.assetByteResolver(),
    resources,
    descriptorFor: (assetId) => {
      const v = client.content.resolveVersion(assetId);
      if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) return null;
      return { assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength };
    },
    ensureDescriptor: (assetId) => client.catalog.ensureAssets([assetId]),
    onChanged: () => {
      viewport.refreshLightmaps();
      viewport.requestRender();
      report();
    },
    parentFor: (entityId) => viewport.objectFor(entityId),
    resolveBuffer: (digest) => client.instanceBufferBytes(digest),
    vertexColorsFor: (assetId) => (client.content.getAsset(assetId)?.vertexColors === 'tint' ? 'tint' : 'data'),
    materialLibrary,
    assetMaterialsFor: (assetId) => client.content.getAsset(assetId)?.materials ?? null,
    loadTexture,
    assetTexturesFor: (assetId) => client.content.getAsset(assetId)?.textures ?? null,
    // The project's instance chunk size; the Inspector shows each set's chunk count.
    instanceChunkSize: () => {
      const v = client.getSettings()?.['instance_chunk_m'];
      return typeof v === 'number' && v > 0 ? v : undefined;
    },
    ...(o.onSetBuilt !== undefined ? { onSetBuilt: o.onSetBuilt } : {}),
    ...(o.onFailuresChanged !== undefined ? { onFailuresChanged: o.onFailuresChanged } : {}),
  });
  return {
    resources,
    loadTexture,
    materialLibrary,
    models,
    dispose() {
      materialLibrary.dispose();
      models.dispose();
      resources.dispose();
    },
  };
}

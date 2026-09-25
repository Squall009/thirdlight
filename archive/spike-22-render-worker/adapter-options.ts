/**
 * SPIKE 22.2: the scene adapter's options as the export bootstrap builds them
 * (export-bootstrap-m3.ts at main 8818453), in one function the page
 * (`?render=main`) and the render worker both call — so both modes draw
 * exactly the same adapter; only the thread differs.
 */
import { bufferResolver, type ManifestBufferRow, type ManifestSceneRow, type FlowConfigLike } from '@thirdlight/game-host';
import { createSceneAdapter, decodeTexture, effectsOptionFrom, environmentHasLook } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { EffectDefLike, EnvironmentLike, LightingBakeLike, MaterialDefLike, MaterialFunctionLike, SceneAdapterModels, WindLike } from '@thirdlight/three-adapter';
import type { GameplaySettings, Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import type { InputConfigLike } from '@thirdlight/input';

export interface ExportManifestV2 {
  manifestVersion: number;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  gameDigest: string;
  settingsDigest: string;
  mediaDigest: string;
  settings: GameplaySettings;
  game: Record<string, unknown> | null;
  tags?: { bit: number; name: string }[];
  materials?: MaterialDefLike[];
  materialFunctions?: MaterialFunctionLike[];
  effects?: EffectDefLike[];
  environment?: EnvironmentLike & { wind?: WindLike };
  lighting?: Record<string, LightingBakeLike>;
  animators?: unknown[];
  prefabs?: unknown[];
  input?: InputConfigLike;
  scenes?: ManifestSceneRow[];
  buffers?: ManifestBufferRow[];
  assets: ReadonlyArray<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number; kind: string; path: string }>;
  media: { cues: Record<string, unknown>; animation: ReadonlyArray<{ entityId: string; assetId: string; version: number; profileDigest: string; roles: Record<string, unknown> }> };
  behaviors: ReadonlyArray<Record<string, unknown>>;
  modules: ReadonlyArray<Record<string, unknown>>;
  enginePins: ReadonlyArray<Record<string, unknown>>;
  recipes: Record<string, number>;
  toolchain: Record<string, unknown>;
  buildOptionsDigest: string;
  buildId: string;
}

export type SceneAdapterOptions = Parameters<typeof createSceneAdapter>[1];

export interface AdapterInputs {
  readonly manifest: ExportManifestV2;
  readonly snapshot: RuntimeSnapshot;
  /** The model asset ids the game can show (the page computes them from the scene and the manifest). */
  readonly referenced: readonly string[];
  /** The verified asset bytes by `assetId@version`. */
  readonly bytes: ReadonlyMap<string, ArrayBuffer>;
  readonly renderer: { preference: string; source: string };
  readonly batching: boolean;
  /** Absolute (a worker resolves relative URLs against its script). */
  readonly decoderBase: string;
  /** Relative artifact reads (instance buffers) and the digest function. */
  readonly io: { read(path: string): Promise<ArrayBuffer>; sha256Hex(bytes: Uint8Array): Promise<string> };
}

export function modelsBlock(i: AdapterInputs): SceneAdapterModels | null {
  const { manifest, bytes } = i;
  const referenced = new Set(i.referenced);
  if (referenced.size === 0) return null;
  const settings = manifest.settings;
  const modelRows = (manifest.assets ?? []).filter((a) => a.kind === 'model' && referenced.has(a.assetId));
  return {
    assets: modelRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest, ...((r as { vertexColors?: unknown }).vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}), ...((r as { materials?: Record<string, string> }).materials !== undefined ? { materials: (r as unknown as { materials: Record<string, string> }).materials } : {}), ...(typeof (r as { clipsFor?: unknown }).clipsFor === 'string' ? { clipsFor: (r as unknown as { clipsFor: string }).clipsFor } : {}) })),
    animation: (manifest.media?.animation ?? []).map((r) => ({ entityId: r.entityId, roles: r.roles as never, version: r.version })),
    ...(settings.animation_crossfade_s !== undefined ? { crossfadeSeconds: settings.animation_crossfade_s } : {}),
    resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
      const buf = bytes.get(`${assetId}@${version}`);
      if (buf === undefined) return Promise.reject(new Error(`no wrapper-verified bytes for ${assetId} v${version}`));
      return Promise.resolve(buf);
    },
    ...(manifest.buffers !== undefined ? { resolveBuffer: bufferResolver(manifest.buffers, i.io) } : {}),
  };
}

export function adapterOptions(i: AdapterInputs, runtime: Runtime, models: SceneAdapterModels | null): SceneAdapterOptions {
  const { manifest, bytes } = i;
  const levelLooks = ((manifest as unknown as { flow?: FlowConfigLike }).flow?.levels ?? []).some((l) => l.environment !== undefined);
  const loadTexture = (assetId: string) => {
    const row = (manifest.assets ?? []).find((r) => r.kind === 'texture' && r.assetId === assetId);
    const buf = row !== undefined ? bytes.get(`${row.assetId}@${row.version}`) : undefined;
    return buf !== undefined ? decodeTexture(buf) : Promise.resolve(null);
  };
  return {
    runtime,
    snapshot: i.snapshot,
    renderer: i.renderer as never,
    batching: i.batching,
    ...(models !== null ? { models, modelsLoader: createGltfLoaderPort({ decoderBase: i.decoderBase }) } : {}),
    ...(environmentHasLook(manifest.environment) || levelLooks ? { environment: { value: manifest.environment ?? {}, loadTexture } } : {}),
    ...(manifest.lighting !== undefined ? { lighting: { bakes: manifest.lighting, loadTexture } } : {}),
    ...(manifest.effects !== undefined && manifest.effects.length > 0
      ? {
          effects: effectsOptionFrom({
            defs: manifest.effects,
            wind: manifest.environment?.wind ?? null,
            assets: (manifest.assets ?? []) as never,
            bytes: (assetId: string, version: number) => bytes.get(`${assetId}@${version}`),
            ...(JSON.stringify(manifest.effects).includes('"model"') ? { loader: createGltfLoaderPort({ decoderBase: i.decoderBase }) } : {}),
          }),
        }
      : {}),
    ...(manifest.materials !== undefined || manifest.environment !== undefined || levelLooks
      ? { materials: { defs: manifest.materials ?? [], functions: manifest.materialFunctions ?? [], wind: manifest.environment?.wind ?? null, loadTexture } }
      : {}),
  } as SceneAdapterOptions;
}

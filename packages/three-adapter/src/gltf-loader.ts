/**
 * The pinned three.js GLTFLoader-backed port (packet 26;
 * `dependencies.md` §7 "GLB loading | no new pin: the pinned `three@0.186.0`
 * package's `examples/jsm/loaders/GLTFLoader.js` (+ its animation subpath)").
 *
 * This module is the ONLY place this package imports the loader, and it is
 * exposed on the `@thirdlight/three-adapter/gltf-loader` subpath — not from the
 * package root. Rationale (recorded as a contract-change request in the packet
 * handoff): the M1 export/play-preview bundle graphs import the three-adapter
 * **root**, and `export.md` §5.4.1 binding 4 requires those bundles' recorded
 * exception counts to stay exact; a root-level loader import would add
 * GLTFLoader's own inert `https://`/`process.` occurrences to them today.
 * Packets 35/36 need the loader inside those bundles and must re-measure
 * §5.4.1 first.
 *
 * Bounds and honesty:
 *  - the port never fetches: it parses supplied bytes only, and `GLTFLoader`
 *    resolves every buffer/image from the single BIN chunk (the M2 profile
 *    rejects external URIs at import time);
 *  - it pre-guards the container (magic/version/length, JSON chunk, the
 *    extension lists) so an unsupported-extension GLB fails closed instead of
 *    being realized with silently-ignored semantics. This is a *rendering*
 *    guard, not the import-profile validator (`asset-pipeline` owns
 *    project-model §18.7); the renderer never re-implements the import profile;
 *  - it owns everything it creates: it counts the geometries/materials/textures
 *    reachable from the loaded scene (plus the parser's cached textures from
 *    `parser.associations`) at load time and disposes exactly that set, once,
 *    through `LoadedGlb.dispose()`;
 *  - a parse that completes after the caller aborted is discarded and released
 *    by the port itself (no leak, no late hand-off).
 */
import {
  BufferGeometry,
  Material,
  Object3D,
  Texture,
  type AnimationClip,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  visualLoadFailure,
  type AssetVersionDescriptor,
  type GlbLoaderPort,
  type LoadedGlb,
} from './visual';

/** The extensions this realization path honors (the import allowlist, restated: no import edge exists). */
export const GLTF_LOADER_ALLOWED_EXTENSIONS: readonly string[] = Object.freeze([
  'EXT_meshopt_compression',
  'EXT_texture_webp',
  'KHR_draco_mesh_compression',
  'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_texture_transform',
]);

/** Defensive copies of the profile bounds (asset-pipeline owns the originals; no import edge exists). */
const GLB_JSON_CHUNK_BYTES_MAX = 8_388_608;
const GLB_IMAGE_ENTRY_LIMIT = 4_096;

export interface GltfLoaderPortOptions {
  /** Extensions this path may honor; default: GLTF_LOADER_ALLOWED_EXTENSIONS. */
  readonly allowedExtensions?: readonly string[];
  /**
   * Where three's Draco and Basis decoder files are served (`<base>draco/`,
   * `<base>basis/`, a URL ending in `/`). Without it a GLB that needs one of
   * them fails with `unsupported_extension` (meshopt needs no files).
   */
  readonly decoderBase?: string;
}

/** Extensions whose payload needs decoder files at load time. */
const DECODER_EXTENSIONS: Readonly<Record<string, 'draco' | 'basis'>> = {
  KHR_draco_mesh_compression: 'draco',
  KHR_texture_basisu: 'basis',
};

/**
 * KTX2Loader picks the GPU format to transcode to from the renderer's
 * compressed-texture extensions. The port does not own the game's renderer, so
 * it asks a small WebGL2 context of its own (same browser and GPU).
 */
function textureSupport(): { isWebGPURenderer: false; extensions: { has(name: string): boolean; get(name: string): unknown } } {
  const doc = (globalThis as { document?: { createElement(tag: string): { getContext(kind: string): unknown } } }).document;
  const gl = doc?.createElement('canvas').getContext('webgl2') as { getExtension(name: string): unknown } | null | undefined;
  const get = (name: string): unknown => (gl ? gl.getExtension(name) : null);
  return { isWebGPURenderer: false, extensions: { has: (name) => get(name) !== null, get } };
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown loader error';
}

/** A bounded read of the GLB header + JSON-chunk extension/image declarations. */
type ContainerGuard =
  | { readonly ok: true; readonly used: readonly string[]; readonly required: readonly string[]; readonly images: number }
  | { readonly ok: false; readonly failure: ReturnType<typeof visualLoadFailure> };

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) return null;
    out.push(entry);
    if (out.length > 64) return null;
  }
  return out;
}

function readContainerGuard(bytes: Uint8Array): ContainerGuard {
  const corrupt = (message: string): ContainerGuard => ({ ok: false, failure: visualLoadFailure('corrupt', message) });
  if (bytes.byteLength < 20) return corrupt('the GLB container is shorter than a header plus one chunk');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return corrupt('the GLB magic is not "glTF"');
  if (view.getUint32(4, true) !== 2) return corrupt('the GLB container version is not 2');
  if (view.getUint32(8, true) !== bytes.byteLength) return corrupt('the declared GLB length does not match the supplied bytes');
  if (view.getUint32(16, true) !== 0x4e4f534a) return corrupt('the first GLB chunk is not the JSON chunk');
  const jsonLength = view.getUint32(12, true);
  if (jsonLength === 0 || jsonLength % 4 !== 0 || 20 + jsonLength > bytes.byteLength) {
    return corrupt('the JSON chunk framing is invalid');
  }
  if (jsonLength > GLB_JSON_CHUNK_BYTES_MAX) return corrupt('the JSON chunk exceeds the profile bound');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  } catch {
    return corrupt('the JSON chunk is not parseable');
  }
  if (typeof json !== 'object' || json === null) return corrupt('the GLB JSON root is not an object');
  const root = json as { extensionsUsed?: unknown; extensionsRequired?: unknown; images?: unknown };
  const used = stringList(root.extensionsUsed);
  const required = stringList(root.extensionsRequired);
  if (used === null || required === null) return corrupt('the extension lists are not bounded string arrays');
  const images = Array.isArray(root.images) ? root.images.length : 0;
  if (images > GLB_IMAGE_ENTRY_LIMIT) return corrupt('the image list exceeds the profile bound');
  return { ok: true, used, required, images };
}

type OwnedSets = {
  readonly geometries: Set<BufferGeometry>;
  readonly materials: Set<Material>;
  readonly textures: Set<Texture>;
};

/** Collect every GPU resource this load owns (scene graph + parser cache). */
function collectOwned(gltf: GLTF): OwnedSets {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  gltf.scene.traverse((object: Object3D) => {
    const mesh = object as { geometry?: unknown; material?: unknown };
    if (mesh.geometry instanceof BufferGeometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) if (m instanceof Material) materials.add(m);
    } else if (material instanceof Material) {
      materials.add(material);
    }
  });
  // `parser.associations` also holds the cached source textures that materials
  // clone from; disposing only the clones would keep those GPU resources alive.
  try {
    for (const object of gltf.parser.associations.keys()) {
      if (object instanceof BufferGeometry) geometries.add(object);
      else if (object instanceof Material) materials.add(object);
      else if (object instanceof Texture) textures.add(object);
    }
  } catch {
    /* the association map is best-effort (implementation detail of the loader) */
  }
  return { geometries, materials, textures };
}

/** The GLTFLoader-backed loader port (one instance may serve many loads). */
export function createGltfLoaderPort(options: GltfLoaderPortOptions = {}): GlbLoaderPort {
  const allowed = new Set(options.allowedExtensions ?? GLTF_LOADER_ALLOWED_EXTENSIONS);
  // The Draco/KTX2 loaders start decoder workers: created on first need, then shared.
  let draco: DRACOLoader | null = null;
  let ktx2: KTX2Loader | null = null;
  return {
    async load(
      bytes: Uint8Array,
      loadOptions: { readonly signal: AbortSignal; readonly descriptor: AssetVersionDescriptor },
    ): Promise<LoadedGlb> {
      const guard = readContainerGuard(bytes);
      if (!guard.ok) throw guard.failure;
      const unsupported = [...guard.used, ...guard.required].find((name) => !allowed.has(name));
      if (unsupported !== undefined) {
        throw visualLoadFailure('unsupported_extension', `the GLB declares extension '${unsupported}', which this visual path cannot honor`);
      }

      const needs = new Set([...guard.used, ...guard.required].map((name) => DECODER_EXTENSIONS[name]).filter((d) => d !== undefined));
      if (needs.size > 0 && options.decoderBase === undefined) {
        throw visualLoadFailure('unsupported_extension', `the GLB needs the ${[...needs].join(' and ')} decoder, which is not available here`);
      }

      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      if (needs.has('draco')) {
        if (draco === null) {
          draco = new DRACOLoader();
          draco.setDecoderPath(`${options.decoderBase}draco/`);
        }
        loader.setDRACOLoader(draco);
      }
      if (needs.has('basis')) {
        if (ktx2 === null) {
          ktx2 = new KTX2Loader();
          ktx2.setTranscoderPath(`${options.decoderBase}basis/`);
          ktx2.detectSupport(textureSupport() as unknown as Parameters<KTX2Loader['detectSupport']>[0]);
        }
        loader.setKTX2Loader(ktx2);
      }
      let gltf: GLTF;
      try {
        gltf = await loader.parseAsync(arrayBuffer, '');
      } catch (e) {
        throw classify(e, guard.images > 0);
      }

      const owned = collectOwned(gltf);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        for (const geometry of owned.geometries) {
          try {
            geometry.dispose();
          } catch {
            /* best effort */
          }
        }
        for (const material of owned.materials) {
          try {
            material.dispose();
          } catch {
            /* best effort */
          }
        }
        for (const texture of owned.textures) {
          try {
            texture.dispose();
          } catch {
            /* best effort */
          }
        }
      };

      if (loadOptions.signal.aborted) {
        // The caller cancelled while the loader was parsing: release the whole
        // result here and report an abort (the adapter turns it into
        // `asset_load_cancelled`).
        release();
        const abort = new Error('the GLB load was aborted before it completed');
        abort.name = 'AbortError';
        throw abort;
      }

      const animations: readonly AnimationClip[] = gltf.animations;
      return {
        root: gltf.scene,
        animations,
        // SkeletonUtils.clone rebinds skinned meshes to the clone's own bones
        // (Object3D.clone would leave them driven by the original skeleton).
        createInstance: () => cloneSkinned(gltf.scene),
        dispose: release,
        ownership: {
          geometries: owned.geometries.size,
          materials: owned.materials.size,
          textures: owned.textures.size,
          listeners: 0,
          objectUrls: 0,
        },
      };
    },
  };
}

/** Map a loader error onto the port's stable failure reasons (bounded by message). */
function classify(e: unknown, containerHasImages: boolean): unknown {
  const message = messageOf(e);
  if (/draco|meshopt|ktx|basis|extension|EXT_|KHR_/i.test(message)) {
    return visualLoadFailure('unsupported_extension', message);
  }
  if (/texture|image|bitmap/i.test(message)) return visualLoadFailure('invalid_image', message);
  if (/animation|track|clip|keyframe/i.test(message)) return visualLoadFailure('invalid_clip', message);
  if (containerHasImages) return visualLoadFailure('invalid_image', message);
  return visualLoadFailure('corrupt', message);
}

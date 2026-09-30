/**
 * A model file's tile thumbnails, made off the page: the file is parsed and
 * drawn on an `OffscreenCanvas` in the editor worker (its own renderer, kept
 * for the next file), the whole file and — for a file of several pieces —
 * each piece, from a three-quarter front view on a transparent background.
 * The PNGs go to the import cache (the caller stores them), so a tile is
 * drawn from the cache from then on; the page never parses a model to draw
 * its tile.
 *
 * DOM-free: runs in a dedicated worker, or on the page where no worker can.
 */
import * as THREE from 'three';
import { createRenderer, prepareVisualResource, suppliedBytes, type RendererHandle, type RendererPreference, type RendererPreferenceSource, type VertexColorMode } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { ASSET_THUMBNAIL_EDGE } from '@thirdlight/project-model/limits';

import { encodePngOffscreen } from './png-offscreen';

export interface ModelThumbnailInput {
  readonly bytes: Uint8Array;
  readonly assetId: string;
  readonly version: number;
  readonly digest: string;
  readonly vertexColors: VertexColorMode;
  readonly renderer: { preference: RendererPreference; source: RendererPreferenceSource };
}

export interface ModelThumbnailOutput {
  /** The whole file (null: it could not be drawn). */
  readonly file: Uint8Array | null;
  /** Each piece of a file with two or more. */
  readonly pieces: readonly { readonly name: string; readonly png: Uint8Array }[];
}

/** The renderer is kept between files (made again when the backend choice changes). */
let kept: { key: string; handle: RendererHandle; canvas: OffscreenCanvas } | null = null;
const loader = createGltfLoaderPort({ decoderBase: './decoders/' });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x40362c, 1.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);

function rendererFor(choice: ModelThumbnailInput['renderer']): { handle: RendererHandle; canvas: OffscreenCanvas } {
  const key = `${choice.preference}|${choice.source}`;
  if (kept !== null && kept.key === key) return kept;
  kept?.handle.dispose();
  const canvas = new OffscreenCanvas(ASSET_THUMBNAIL_EDGE, ASSET_THUMBNAIL_EDGE);
  // A transparent background: the tile's own colour shows around the model.
  const handle = createRenderer({ canvas, preference: choice.preference, source: choice.source, alpha: true, antialias: true, clearColor: 0x000000, clearAlpha: 0, loseContextOnDispose: true });
  kept = { key, handle, canvas };
  return kept;
}

export async function renderModelThumbnails(input: ModelThumbnailInput): Promise<ModelThumbnailOutput> {
  const handle = prepareVisualResource(suppliedBytes({ assetId: input.assetId, version: input.version, sourceDigest: input.digest, sourceByteLength: input.bytes.byteLength }, input.bytes), { loader });
  const prepared = await handle.result;
  if (!prepared.ok) return { file: null, pieces: [] };
  const resource = prepared.resource;
  try {
    const { handle: rh, canvas } = rendererFor(input.renderer);
    if (!(await rh.whenReady())) return { file: null, pieces: [] };
    const renderer = rh.current();
    if (renderer === null) return { file: null, pieces: [] };
    renderer.setPixelRatio(1);
    renderer.setSize(ASSET_THUMBNAIL_EDGE, ASSET_THUMBNAIL_EDGE, false);
    const draw = async (piece: string | null): Promise<Uint8Array | null> => {
      const created = resource.createInstance({ ...(piece !== null ? { piece } : {}), vertexColors: input.vertexColors });
      if (!created.ok) return null;
      const instance = created.instance;
      let bitmap: ImageBitmap;
      try {
        scene.add(instance.root);
        instance.root.updateMatrixWorld(true);
        const box = resource.bounds(piece);
        if (box.isEmpty()) box.setFromObject(instance.root);
        if (box.isEmpty()) return null;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const dir = new THREE.Vector3(0.55, 0.45, 1).normalize();
        const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05;
        camera.position.copy(sphere.center).addScaledVector(dir, distance);
        camera.near = Math.max(0.001, distance - sphere.radius * 2);
        camera.far = distance + sphere.radius * 2;
        camera.lookAt(sphere.center);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        // WebGPU keeps no drawing buffer: the picture is taken in the task that drew it.
        bitmap = canvas.transferToImageBitmap();
      } finally {
        scene.remove(instance.root);
        instance.dispose();
      }
      return encodePngOffscreen({ bitmap });
    };
    const file = await draw(null);
    const pieces: { name: string; png: Uint8Array }[] = [];
    const list = resource.pieces();
    if (list.length >= 2) {
      for (const pc of list) {
        const png = await draw(pc.name);
        if (png !== null) pieces.push({ name: pc.name, png });
      }
    }
    return { file, pieces };
  } finally {
    resource.dispose();
  }
}

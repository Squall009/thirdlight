/**
 * "Align the sky's sun to the key light" (Environment window): find the sun
 * in the sky image (`findSkySun`: the centre of its brightest area) and the
 * turn that puts it at the key light's azimuth (`alignedSkyRotation`).
 * Only the azimuth is matched: a turn about +Y cannot move a painted sun up
 * or down.
 *
 * The image is read at a reduced size (the sun is a patch, not a pixel):
 * 512 × 256 for an equirect, 64 × 64 per cube face.
 *
 * Browser-only (canvas).
 */
import { alignedSkyRotation, findSkySun, type SkyPixels } from '@thirdlight/three-adapter';
import type { SkyConfig } from '@thirdlight/project-model';
import type * as THREE from 'three';

const EQUIRECT_READ = { width: 512, height: 256 };
const FACE_READ = 64;

export type SkyAlignResult = { ok: true; rotation: number; note: string } | { ok: false; message: string };

/** A texture's pixels at `width` × `height` (null: the image is not drawable, e.g. a compressed KTX2 texture). */
function pixelsOf(t: THREE.Texture, width: number, height: number): SkyPixels | null {
  const image = t.image as CanvasImageSource & { width?: number; height?: number; data?: unknown };
  if (image === null || image === undefined || typeof image.width !== 'number' || image.width === 0 || image.data !== undefined) return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (g === null) return null;
  g.drawImage(image, 0, 0, width, height);
  return g.getImageData(0, 0, width, height);
}

/** The turn (degrees) that puts `sky`'s sun at the azimuth the key light comes from; `lightDirection` is the way the light travels. */
export async function alignSkyToKeyLight(sky: SkyConfig, lightDirection: readonly number[] | null, loadTexture: (assetId: string) => Promise<THREE.Texture | null>): Promise<SkyAlignResult> {
  if (sky.mode !== 'texture') return { ok: false, message: 'only an image sky turns' };
  if (lightDirection === null) return { ok: false, message: 'the scene has no directional light to align to' };
  let sun;
  if (sky.cube !== undefined) {
    const faces = await Promise.all(sky.cube.map((id) => loadTexture(id)));
    const pixels = faces.map((f) => (f === null ? null : pixelsOf(f, FACE_READ, FACE_READ)));
    if (pixels.some((p) => p === null)) return { ok: false, message: 'a cube face could not be read (missing, or a compressed texture)' };
    sun = findSkySun({ cube: pixels as SkyPixels[] });
  } else if (sky.texture !== undefined) {
    const t = await loadTexture(sky.texture);
    const pixels = t === null ? null : pixelsOf(t, EQUIRECT_READ.width, EQUIRECT_READ.height);
    if (pixels === null) return { ok: false, message: 'the sky image could not be read (missing, or a compressed texture)' };
    sun = findSkySun({ equirect: pixels });
  } else return { ok: false, message: 'the sky has no image' };
  if (sun === null) return { ok: false, message: 'the sky image is empty' };
  const rotation = alignedSkyRotation(sun.direction, lightDirection);
  if (rotation === null) return { ok: false, message: 'the key light or the sun is straight overhead: there is no azimuth to match' };
  const note = `sun found at azimuth ${sun.azimuth.toFixed(0)}°, elevation ${sun.elevation.toFixed(0)}° in the image (centre of its brightest area, ${sun.samples} samples); rotation ${rotation}° puts it where the key light comes from`;
  return { ok: true, rotation, note };
}

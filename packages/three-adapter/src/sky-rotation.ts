/**
 * A texture sky's turn about +Y, and finding where its sun is.
 *
 * The turn is three's `scene.backgroundRotation` and
 * `scene.environmentRotation` (both renderers' node paths read them: the
 * background through `backgroundRotation`, every lit material's
 * environment lookup through `materialEnvRotation`), so the background and
 * the image-based lighting cannot disagree; cross-fade domes turn their mesh
 * by the same angle. A turn of θ moves what the image shows in direction d to
 * Ry(θ)·d (counter-clockwise seen from above).
 *
 * "Align the sky's sun to the key light" needs the sun's direction in the
 * image. Sky images carry no stored sun direction, so it is the centre of the
 * brightest area: the samples within a small margin of the brightest one,
 * gathered round the 10° cell that holds most of them (a painted sun is the
 * largest saturated patch; a lone bright cloud pixel elsewhere does not pull
 * the centre away). Browser-free: the editor reads the pixels.
 */
import type * as THREE from 'three';

/** The fields of a sky the turn reads. */
export interface RotatableSky {
  readonly mode: string;
  readonly rotation?: number;
}

/** The turn a sky draws with (degrees about +Y): only texture skies turn; the others are built from the light or colours. */
export function skyTurnDegrees(sky: RotatableSky | null | undefined): number {
  return sky === null || sky === undefined || sky.mode !== 'texture' ? 0 : (sky.rotation ?? 0);
}

/** The same in radians. */
export function skyRotationRadians(sky: RotatableSky | null | undefined): number {
  return (skyTurnDegrees(sky) * Math.PI) / 180;
}

/** Turn the scene's background and environment lighting together (a uniform each: no new program). */
export function applySkyRotation(scene: THREE.Scene, radians: number): void {
  if (scene.backgroundRotation.y !== radians || scene.backgroundRotation.x !== 0 || scene.backgroundRotation.z !== 0) scene.backgroundRotation.set(0, radians, 0);
  if (scene.environmentRotation.y !== radians || scene.environmentRotation.x !== 0 || scene.environmentRotation.z !== 0) scene.environmentRotation.set(0, radians, 0);
}

/** RGBA pixels, row 0 at the top (canvas `getImageData`). */
export interface SkyPixels {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** The direction an equirect pixel shows (three's `equirectUV`: u = atan2(z, x)/2π + 0.5; the image's top row is up). */
export function equirectPixelDirection(x: number, y: number, width: number, height: number): [number, number, number] {
  const azimuth = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
  const elevation = (0.5 - (y + 0.5) / height) * Math.PI;
  const c = Math.cos(elevation);
  return [c * Math.cos(azimuth), Math.sin(elevation), c * Math.sin(azimuth)];
}

/**
 * The direction a cube face pixel shows (faces px, nx, py, ny, pz, nz as a
 * `cube` sky lists them). The face is the GPU cube map's (the GL table: s
 * right, t down); three samples a cube image with x mirrored, so +X's image
 * is seen towards world −X.
 */
export function cubePixelDirection(face: number, x: number, y: number, size: number): [number, number, number] {
  const sc = (2 * (x + 0.5)) / size - 1;
  const tc = (2 * (y + 0.5)) / size - 1;
  let d: [number, number, number];
  switch (face) {
    case 0: d = [1, -tc, -sc]; break;
    case 1: d = [-1, -tc, sc]; break;
    case 2: d = [sc, 1, tc]; break;
    case 3: d = [sc, -1, -tc]; break;
    case 4: d = [sc, -tc, 1]; break;
    default: d = [-sc, -tc, -1];
  }
  const n = Math.hypot(d[0], d[1], d[2]);
  return [-d[0] / n, d[1] / n, d[2] / n];
}

/** Luminance of an sRGB-encoded pixel (0–255). */
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** How far under the brightest sample a sample still counts as the sun (0–255 luminance). */
const SUN_MARGIN = 3;
/** The gathering cells (degrees of azimuth and elevation). */
const CELL_DEG = 10;

export interface SkySun {
  /** Unit direction towards the sun as the unturned image shows it. */
  readonly direction: [number, number, number];
  /** Its azimuth (degrees, atan2(z, x)) and elevation (degrees). */
  readonly azimuth: number;
  readonly elevation: number;
  /** The brightest luminance (0–255) and how many samples formed the centre. */
  readonly luminance: number;
  readonly samples: number;
}

/**
 * Where the sun is in a sky image: an equirect (`pixels`) or six cube faces.
 * Null when the image has no pixels.
 */
export function findSkySun(image: { readonly equirect: SkyPixels } | { readonly cube: readonly SkyPixels[] }): SkySun | null {
  // Every sample as (direction, luminance, solid-angle weight).
  const dirs: number[] = [];
  const lum: number[] = [];
  const weight: number[] = [];
  const add = (d: readonly number[], l: number, w: number): void => {
    dirs.push(d[0]!, d[1]!, d[2]!);
    lum.push(l);
    weight.push(w);
  };
  if ('equirect' in image) {
    const { width, height, data } = image.equirect;
    for (let y = 0; y < height; y++) {
      const w = Math.cos((0.5 - (y + 0.5) / height) * Math.PI);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        add(equirectPixelDirection(x, y, width, height), luma(data[i]!, data[i + 1]!, data[i + 2]!), w);
      }
    }
  } else {
    image.cube.forEach((face, f) => {
      const size = face.width;
      for (let y = 0; y < face.height; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const sc = (2 * (x + 0.5)) / size - 1;
          const tc = (2 * (y + 0.5)) / size - 1;
          // A cube texel's solid angle falls off as (1 + s² + t²)^-3/2.
          add(cubePixelDirection(f, x, y, size), luma(face.data[i]!, face.data[i + 1]!, face.data[i + 2]!), Math.pow(1 + sc * sc + tc * tc, -1.5));
        }
      }
    });
  }
  const n = lum.length;
  if (n === 0) return null;
  let max = -1;
  for (const l of lum) if (l > max) max = l;
  // The candidates into 10° cells; the cell whose 3 × 3 neighbourhood (azimuth wraps) holds most of them wins.
  const cols = Math.round(360 / CELL_DEG);
  const rows = Math.round(180 / CELL_DEG);
  const cellOf = (k: number): [number, number] => {
    const az = Math.atan2(dirs[k * 3 + 2]!, dirs[k * 3]!);
    const el = Math.asin(Math.max(-1, Math.min(1, dirs[k * 3 + 1]!)));
    const c = Math.min(cols - 1, Math.floor(((az + Math.PI) / (2 * Math.PI)) * cols));
    const r = Math.min(rows - 1, Math.floor(((el + Math.PI / 2) / Math.PI) * rows));
    return [c, r];
  };
  const cells = new Float64Array(cols * rows);
  const candidates: number[] = [];
  for (let k = 0; k < n; k++) {
    if (lum[k]! < max - SUN_MARGIN) continue;
    candidates.push(k);
    const [c, r] = cellOf(k);
    cells[r * cols + c]! += weight[k]!;
  }
  const near = (c: number, r: number, c2: number, r2: number): boolean => Math.abs(r - r2) <= 1 && Math.min((c - c2 + cols) % cols, (c2 - c + cols) % cols) <= 1;
  let best = 0;
  let bestSum = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] === 0) continue;
      let s = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (r + dr >= 0 && r + dr < rows) s += cells[(r + dr) * cols + ((c + dc + cols) % cols)]!;
      if (s > bestSum) {
        bestSum = s;
        best = r * cols + c;
      }
    }
  }
  const bc = best % cols;
  const br = Math.floor(best / cols);
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;
  for (const k of candidates) {
    const [c, r] = cellOf(k);
    if (!near(c, r, bc, br)) continue;
    const w = weight[k]!;
    sx += dirs[k * 3]! * w;
    sy += dirs[k * 3 + 1]! * w;
    sz += dirs[k * 3 + 2]! * w;
    count++;
  }
  const len = Math.hypot(sx, sy, sz);
  if (count === 0 || len === 0) return null;
  const direction: [number, number, number] = [sx / len, sy / len, sz / len];
  return { direction, azimuth: azimuthDeg(direction), elevation: (Math.asin(Math.max(-1, Math.min(1, direction[1]))) * 180) / Math.PI, luminance: max, samples: count };
}

/** A direction's azimuth in degrees (atan2(z, x), the same angle the turn adds to). */
export function azimuthDeg(d: readonly number[]): number {
  return (Math.atan2(d[2]!, d[0]!) * 180) / Math.PI;
}

/** An angle in degrees brought into (−180, 180]. */
export function wrapDegrees(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/**
 * The sky rotation (degrees, in (−180, 180]) that puts the image's sun at the
 * key light's azimuth. `lightDirection` is the way the light travels (the sun
 * is the other way). Null for a light straight up or down (no azimuth).
 */
export function alignedSkyRotation(sunInImage: readonly number[], lightDirection: readonly number[]): number | null {
  const tx = -lightDirection[0]!;
  const tz = -lightDirection[2]!;
  if (Math.hypot(tx, tz) < 1e-6 || Math.hypot(sunInImage[0]!, sunInImage[2]!) < 1e-6) return null;
  // Ry(θ) takes azimuth α to α − θ (atan2(z, x) measured from +X towards +Z).
  const rot = azimuthDeg(sunInImage) - (Math.atan2(tz, tx) * 180) / Math.PI;
  return Math.round(wrapDegrees(rot) * 10) / 10;
}

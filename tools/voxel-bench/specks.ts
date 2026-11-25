/**
 * Speck pixels of a still picture: the bench's count of the light read's outliers at the reference cameras, so "specks
 * 0/0" is one `light-shots` run. A speck is a pixel no lit surface of the town draws: white (every channel at least
 * {@link SPECK_WHITE_MIN}), grass green on a wall or roof (green {@link SPECK_GREEN_OVER} over red and blue and over
 * {@link SPECK_GREEN_MIN}), or black amid light (every channel at most {@link SPECK_BLACK_MAX} while at least
 * {@link SPECK_BLACK_RING_SHARE} of the ring two pixels round it is at least {@link SPECK_BLACK_RING_MIN} in luminance:
 * the edge of a dark area, a shadow or a window's inside, is no speck; a dark window a few pixels across far off is).
 * The white and green rules are the ones the reference cameras were first counted by; the black one catches the dark
 * clusters the read draws on shaded walls without the temporal upscale. What a count cannot tell: a lit white surface,
 * real grass or a small dark window in view counts too, so a count is compared between shots of one camera, never
 * read on its own.
 */
import type { Picture } from './lighting-cameras';

/** Each channel at least this: a white speck. */
export const SPECK_WHITE_MIN = 235;
/** Green over red and over blue by more than this, and over {@link SPECK_GREEN_MIN}: a green speck. */
export const SPECK_GREEN_OVER = 40;
export const SPECK_GREEN_MIN = 150;
/** Each channel at most this, inside a ring {@link SPECK_BLACK_RING_SHARE} of whose pixels are at least {@link SPECK_BLACK_RING_MIN} in luminance: a black speck. */
export const SPECK_BLACK_MAX = 16;
export const SPECK_BLACK_RING_MIN = 64;
export const SPECK_BLACK_RING_SHARE = 0.75;

/** The specks of a picture by kind, and their 8-connected clusters (all kinds together). */
export interface SpeckCounts {
  readonly white: number;
  readonly green: number;
  readonly black: number;
  readonly clusters: number;
}

const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;

/** The specks of `img` (see the module's rules). */
export function speckCounts(img: Picture): SpeckCounts {
  const { width: w, height: h } = img;
  const kind = new Uint8Array(w * h);
  let white = 0;
  let green = 0;
  let black = 0;
  let lit = 0;
  const ringPixel = (x: number, y: number): void => void (lum(img.pixel(x, y)) >= SPECK_BLACK_RING_MIN && lit++);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = img.pixel(x, y);
    if (p[0] >= SPECK_WHITE_MIN && p[1] >= SPECK_WHITE_MIN && p[2] >= SPECK_WHITE_MIN) {
      kind[y * w + x] = 1;
      white++;
    } else if (p[1] > p[0] + SPECK_GREEN_OVER && p[1] > p[2] + SPECK_GREEN_OVER && p[1] > SPECK_GREEN_MIN) {
      kind[y * w + x] = 2;
      green++;
    } else if (p[0] <= SPECK_BLACK_MAX && p[1] <= SPECK_BLACK_MAX && p[2] <= SPECK_BLACK_MAX && x >= 2 && y >= 2 && x < w - 2 && y < h - 2) {
      lit = 0;
      for (let d = -2; d <= 2; d++) {
        ringPixel(x + d, y - 2);
        ringPixel(x + d, y + 2);
        if (d > -2 && d < 2) {
          ringPixel(x - 2, y + d);
          ringPixel(x + 2, y + d);
        }
      }
      if (lit >= SPECK_BLACK_RING_SHARE * 16) {
        kind[y * w + x] = 3;
        black++;
      }
    }
  }
  let clusters = 0;
  const stack: number[] = [];
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] === 0) continue;
    clusters++;
    kind[i] = 0;
    stack.push(i);
    while (stack.length > 0) {
      const j = stack.pop()!;
      const jx = j % w;
      const jy = (j - jx) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = jx + dx;
        const ny = jy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (kind[k] !== 0) {
          kind[k] = 0;
          stack.push(k);
        }
      }
    }
  }
  return { white, green, black, clusters };
}

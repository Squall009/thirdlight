/**
 * Chunk-edge costs that do not depend on a world: the apron of width R a
 * meshing job reads beyond its chunk, and how many chunks an edit rebuilds
 * when every result within R of an edited cell depends on it.
 */
import { mulberry32 } from '@thirdlight/shared';

const SAMPLES = 200_000;

/** Cells a job reads beyond its chunk: the shell of width r round an edge³ chunk. */
export function apronCells(edge: number, r: number): number {
  return (edge + 2 * r) ** 3 - edge ** 3;
}

/**
 * Mean chunks rebuilt by a box edit of half-width `s` cells (a stroke's
 * bounds) at a uniformly random position when results within `r` cells of
 * an edited cell depend on it: the chunks the box grown by r touches.
 */
export function meanChunksRebuilt(edge: number, s: number, r: number, samples = SAMPLES, seed = 1): number {
  const rand = mulberry32(seed);
  let total = 0;
  const reach = s + r;
  for (let k = 0; k < samples; k++) {
    let n = 1;
    for (let axis = 0; axis < 3; axis++) {
      const c = Math.floor(rand() * edge);
      n *= Math.floor((c + reach) / edge) - Math.floor((c - reach) / edge) + 1;
    }
    total += n;
  }
  return total / samples;
}


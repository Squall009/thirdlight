/**
 * The 24 rotations of a cube, as a kit's alias names one (a case drawn by
 * another case's mesh turned onto its side: an edge's bottom from its top,
 * a vertical edge from a horizontal one). Each is a 3 × 3 matrix of 0 and
 * ±1 with determinant +1, so an aliased mesh is never mirrored and its
 * normals stay out.
 *
 * **The numbering is part of the kit format** and never changes: rotation
 * `i` is the i-th signed permutation matrix with determinant +1, taking the
 * permutations of the columns in lexicographic order ([0,1,2], [0,2,1],
 * [1,0,2], …) and for each the row signs in binary order (row 0's sign the
 * high bit, + before −). Rotation 0 is the identity. Row `r` of a matrix has
 * its ±1 in column `perm[r]`: the rotated point's coordinate r is
 * ±(the point's coordinate perm[r]).
 */

/** How many rotations a cube has. */
export const CUBE_ROTATION_COUNT = 24;

/** A rotation as a row-major 3 × 3 matrix (9 numbers, each 0 or ±1). */
export type CubeRotation = readonly [number, number, number, number, number, number, number, number, number];

function build(): CubeRotation[] {
  const perms = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const out: CubeRotation[] = [];
  for (const p of perms) {
    // A permutation's parity: even ones need an even number of minus signs.
    const inversions = (p[0]! > p[1]! ? 1 : 0) + (p[0]! > p[2]! ? 1 : 0) + (p[1]! > p[2]! ? 1 : 0);
    for (let s = 0; s < 8; s++) {
      const signs = [s & 4 ? -1 : 1, s & 2 ? -1 : 1, s & 1 ? -1 : 1];
      const det = (inversions & 1 ? -1 : 1) * signs[0]! * signs[1]! * signs[2]!;
      if (det !== 1) continue;
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 3; r++) m[r * 3 + p[r]!] = signs[r]!;
      out.push(Object.freeze(m) as unknown as CubeRotation);
    }
  }
  return out;
}

/** Every rotation, by its index (see the file comment for the order). */
export const CUBE_ROTATIONS: readonly CubeRotation[] = Object.freeze(build());

/** A point turned by rotation `i`. */
export function applyCubeRotation(i: number, p: readonly [number, number, number]): [number, number, number] {
  const m = CUBE_ROTATIONS[i]!;
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + 0, m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + 0, m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + 0];
}

/** The index of a rotation given as a row-major matrix, or −1 when it is none of the 24 (a mirror, a scale). */
export function cubeRotationIndex(m: readonly number[]): number {
  return CUBE_ROTATIONS.findIndex((r) => r.every((v, k) => v === m[k]));
}

/** A quarter turn about +x (+y to +z): a top edge's piece onto the bottom edge of the same side. */
export const CUBE_ROTATION_X90 = cubeRotationIndex([1, 0, 0, 0, 0, -1, 0, 1, 0]);

/** A quarter turn about −z (+y to +x): a top edge's piece (along x) onto the vertical edge of the same side. */
export const CUBE_ROTATION_ZM90 = cubeRotationIndex([0, 1, 0, -1, 0, 0, 0, 0, 1]);

/**
 * The mesh axis (0 x, 1 y, 2 z) cube rotation `i` carries onto the case's x: a mirrored case (x → −x in the case's
 * own orientation) drawn through an alias mirrors its mesh across that axis.
 */
export function mirrorAxisOf(i: number): 0 | 1 | 2 {
  const m = CUBE_ROTATIONS[i]!;
  return m[0] !== 0 ? 0 : m[1] !== 0 ? 1 : 2;
}

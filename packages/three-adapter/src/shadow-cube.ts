/**
 * A light seen through several faces in the shadow atlas (a point light's
 * six, an area light's five): the faces' cameras and the light loop's face
 * pick, as plain code. The shader in `cluster-lights.ts` follows
 * {@link cubeFaceOf} line for line; the vitest suite holds both to the
 * cameras the atlas draws the faces with.
 *
 * - **The faces** are three's point-light shadow faces (`PointShadowNode`'s
 *   WebGL table, as `WebGLShadowMap` has them): +X, −X, +Y, −Y, +Z, −Z, each
 *   a 90° camera at the light looking along {@link CUBE_DIRECTIONS} with
 *   {@link CUBE_UPS} up. One table on both renderers: each face is drawn
 *   into its own atlas tile and read back through the same numbers, so
 *   three's WebGPU cube-texture swap of the Y faces does not apply.
 * - **In the light's frame**: a point light's faces follow the world's axes;
 *   an area light's turn with it, and the face behind its emitter (+Y, its
 *   local up: it shines along −Y) is not drawn unless it is two-sided.
 * - **The pick**: the axis the point lies farthest along (x before y before
 *   z on a tie, where both faces see it on their edge), and the point's place
 *   on that face's image: x right, y up, both over its depth along the axis.
 */
import * as THREE from 'three';

/** Faces a light seen all round takes. */
export const CUBE_FACES = 6;
/** The face behind an area light's emitter (+Y in its frame): left out unless it is two-sided. */
export const AREA_BACK_FACE = 2;

/** The faces' directions and ups, in face order (three's point-light shadow table). */
export const CUBE_DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
export const CUBE_UPS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
  [0, -1, 0],
];

/**
 * The face a point `local` (in the light's frame, from the light) falls in,
 * and its place on that face's image: `x`, `y` in −1–1 (right, up) and its
 * depth `d` along the face's axis.
 */
export function cubeFaceOf(lx: number, ly: number, lz: number): { face: number; x: number; y: number; d: number } {
  const ax = Math.abs(lx);
  const ay = Math.abs(ly);
  const az = Math.abs(lz);
  if (ax >= ay && ax >= az) return { face: lx > 0 ? 0 : 1, x: lx > 0 ? -lz / ax : lz / ax, y: -ly / ax, d: ax };
  if (ay >= az) return { face: ly > 0 ? 2 : 3, x: lx / ay, y: ly > 0 ? lz / ay : -lz / ay, d: ay };
  return { face: lz > 0 ? 4 : 5, x: lz > 0 ? lx / az : -lx / az, y: -ly / az, d: az };
}

const _target = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * `camera` as face `face` of a light at `position` whose frame turns by
 * `turn` (null: the world's axes): 90°, square, looking along the face's
 * direction with its up, as three draws a point light's face.
 */
export function placeCubeFace(camera: THREE.PerspectiveCamera, face: number, position: THREE.Vector3, turn: THREE.Quaternion | null): void {
  const d = CUBE_DIRECTIONS[face]!;
  const u = CUBE_UPS[face]!;
  _dir.set(d[0], d[1], d[2]);
  _up.set(u[0], u[1], u[2]);
  if (turn !== null) {
    _dir.applyQuaternion(turn);
    _up.applyQuaternion(turn);
  }
  camera.position.copy(position);
  camera.up.copy(_up);
  camera.lookAt(_target.copy(position).add(_dir));
  camera.updateMatrixWorld(true);
}

/**
 * The depth a face's tile stores for a point `d` metres along its axis, as
 * `a + b / d`: the face camera's `projection` (column-major), then the
 * atlas's depth convention (`z` scale and offset from clip z over w to the
 * stored depth: 0.5, 0.5 on WebGL 2's −1–1 range, 1, 0 otherwise).
 */
export function cubeDepthTerms(projection: ArrayLike<number>, zScale: number, zOffset: number): [number, number] {
  // clip z = p10 · z + p14 with view z = −d, clip w = d: z / w = −p10 + p14 / d.
  return [zOffset - zScale * projection[10]!, zScale * projection[14]!];
}

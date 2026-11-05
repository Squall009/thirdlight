/**
 * One detail piece instance's matrix, as the chunk view draws it: the mesh
 * (metres, centred on its cell, in the mesh's case orientation) is first
 * turned by its alias's cube rotation into the drawn case's orientation,
 * then staggered there (moved into the solid along the edge's bisector and
 * twisted about it through the edge's middle, by the instance's hash:
 * piece-placement.ts), shifted to the cell's middle line (half a cell in
 * and half a cell down) for a centred piece, squeezed onto half its run for a `half` one, tipped onto the cell's top or bottom face for a tipped one, turned
 * by the case's quarter turns about +y, scaled to the level's cell and put
 * at the cell's centre. Every step but the stagger is exact (quarter turns,
 * half cells); the stagger is the only thing that differs between two
 * instances of one case, and it never reaches collision or light (they read
 * voxels, not pieces).
 */
import * as THREE from 'three';
import { CUBE_ROTATIONS, INSTANCE_FLAG, INSTANCE_PLACE, pieceStagger, VOXEL_SIZE_M, type PieceStaggerFrame } from '@thirdlight/voxel';

/** How a draw's instances are placed beyond their instance bytes. */
export interface PiecePlacement {
  /** The sign of the case's quarter turn about +y in three (kit pieces −1: a turn takes +x to +z). */
  readonly turnSign: number;
  /** The alias's cube rotation (0: none). */
  readonly rotation: number;
  /** The drawn case's stagger frame and hash inputs (null: not staggered). */
  readonly stagger: { readonly frame: PieceStaggerFrame; readonly seed: number; readonly caseIndex: number } | null;
  /** How the drawn case's piece covers half its run when the instance is flagged `half` (voxel `pieceHalfRun`; absent: never). */
  readonly halfRun?: 'x' | 'diagonal' | null;
}

const quat = new THREE.Quaternion();
const tip = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const xAxis = new THREE.Vector3(1, 0, 0);
const at = new THREE.Vector3();
const scale = new THREE.Vector3();
const local = new THREE.Matrix4();
const step = new THREE.Matrix4();
const axis = new THREE.Vector3();
const anchor = new THREE.Vector3();

/** The half-run squeezes in a case's own orientation, level-0 metres (voxel `pieceHalfRun`). */
const HALF_RUN: Readonly<Record<'x' | 'diagonal', THREE.Matrix4>> = (() => {
  const c = VOXEL_SIZE_M;
  // Along x: x from −½ … ½ cell onto 0 … ½.
  const x = new THREE.Matrix4().makeTranslation(0.25 * c, 0, 0).multiply(new THREE.Matrix4().makeScale(0.5, 1, 1));
  // Along a hip's line u = (−1, 1, −1)/√3 from its low end (½, ½, ½) cell: I − ½ u uᵀ about that end.
  const u = new THREE.Vector3(-1, 1, -1).normalize();
  const a = new THREE.Matrix4().set(
    1 - 0.5 * u.x * u.x, -0.5 * u.x * u.y, -0.5 * u.x * u.z, 0,
    -0.5 * u.y * u.x, 1 - 0.5 * u.y * u.y, -0.5 * u.y * u.z, 0,
    -0.5 * u.z * u.x, -0.5 * u.z * u.y, 1 - 0.5 * u.z * u.z, 0,
    0, 0, 0, 1,
  );
  const diagonal = new THREE.Matrix4().makeTranslation(0.5 * c, 0.5 * c, 0.5 * c).multiply(a).multiply(new THREE.Matrix4().makeTranslation(-0.5 * c, -0.5 * c, -0.5 * c));
  return { x, diagonal };
})();

/** The rotation matrices of the 24 cube rotations (made once). */
const ROTATIONS = CUBE_ROTATIONS.map((m) => new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));

/** Cube rotation `i` as a matrix (shared: never change it). */
export function cubeRotationMatrix(i: number): THREE.Matrix4 {
  return ROTATIONS[i]!;
}

/** The quaternion of the case's tip and turns (no alias, no stagger): what a trim piece's run direction reads. */
export function pieceTurn(out: THREE.Quaternion, rotationByte: number, place: number, turnSign: number): THREE.Quaternion {
  out.setFromAxisAngle(up, (turnSign * (rotationByte & 3) * Math.PI) / 2);
  if (place === INSTANCE_PLACE.faceUp || place === INSTANCE_PLACE.faceDown) out.multiply(tip.setFromAxisAngle(xAxis, place === INSTANCE_PLACE.faceUp ? -Math.PI / 2 : Math.PI / 2));
  return out;
}

/**
 * Writes the matrix of an instance into `out`: its rotation byte and placement, its cell's centre `centre`
 * (metres, the draw's space), `cellMetres` its level's cell, `cell0` its cell in level-0 cells and `level`
 * (the stagger's hash), placed as `p` says.
 */
export function pieceMatrix(out: THREE.Matrix4, rotationByte: number, place: number, centre: THREE.Vector3, cellMetres: number, cell0: readonly number[], level: number, p: PiecePlacement): THREE.Matrix4 {
  pieceTurn(quat, rotationByte, place, p.turnSign);
  const s = cellMetres / VOXEL_SIZE_M;
  out.compose(at.copy(centre), quat, scale.set(s, s, s));
  // The steps in the case's own orientation, level-0 metres: centred shift · stagger · alias.
  let any = false;
  local.identity();
  if (place === INSTANCE_PLACE.centred) {
    local.makeTranslation(0, -0.5 * VOXEL_SIZE_M, -0.5 * VOXEL_SIZE_M);
    any = true;
  }
  const half = (rotationByte & INSTANCE_FLAG.half) !== 0 ? p.halfRun : null;
  if (half !== undefined && half !== null) {
    local.multiply(HALF_RUN[half]);
    any = true;
  }
  if (p.stagger !== null) {
    const f = p.stagger.frame;
    const slot = (p.stagger.caseIndex << 4) | (place << 2) | (rotationByte & 3);
    const st = pieceStagger(p.stagger.seed, cell0[0]!, cell0[1]!, cell0[2]!, level, slot, f.reach);
    axis.set(f.out[0], f.out[1], f.out[2]);
    anchor.set(f.anchor[0], f.anchor[1], f.anchor[2]).multiplyScalar(VOXEL_SIZE_M);
    // Twist about the bisector through the edge's middle, after moving into the solid along it.
    local.multiply(step.makeTranslation(anchor.x, anchor.y, anchor.z));
    local.multiply(step.makeRotationAxis(axis, st.twist));
    local.multiply(step.makeTranslation(-anchor.x - axis.x * st.inward * VOXEL_SIZE_M, -anchor.y - axis.y * st.inward * VOXEL_SIZE_M, -anchor.z - axis.z * st.inward * VOXEL_SIZE_M));
    any = true;
  }
  if (p.rotation !== 0) {
    local.multiply(ROTATIONS[p.rotation]!);
    any = true;
  }
  if (any) out.multiply(local);
  return out;
}

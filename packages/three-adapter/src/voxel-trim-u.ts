/**
 * World-anchored U for kit pieces that follow a trim layout: a piece is
 * authored over one cell with U = (distance from the cell's −x face along
 * its run) ÷ the sheet's metres, and the draw adds the run offset from the
 * instance's world cell, so every section of a run reads the same world
 * coordinate and the pattern repeats with the sheet, whichever chunk, turn or
 * mirror placed the cell.
 *
 * - **Which faces:** a triangle whose face is not end-on to the piece's run
 *   (the mesh axis its slot rotation turns onto the case's run:
 *   |normal along it| < 0.05, the kit check's run faces) and whose UVs are not in a
 *   cap region. End faces and caps keep their authored UVs. The choice is
 *   made per triangle on the CPU (a vertex attribute `trimRun`, the mesh made
 *   non-indexed), because smooth normals shared by a run face and an end face
 *   would split the choice inside a triangle.
 * - **Which way:** U grows along the world's positive axis of the run (x, z,
 *   or y for vertical edges), not along the piece's own run direction: two cells of one run placed with
 *   different turns or mirrors (a thin wall's symmetric case) then still meet
 *   without a seam. The price is that text on a debug sheet reads mirrored on
 *   faces seen from the axis' negative side; a real trim texture has no
 *   reading direction.
 * - **How:** each copy carries its (offset, factor), and the piece's wetness,
 *   which every piece draw reads, in its matrix's spare fourth row
 *   ({@link PIECE_RIDER_FLOATS}), with U' = offset + factor × U. The offset is taken modulo one
 *   sheet in 64 bits on the CPU, so a cell kilometres out keeps full
 *   precision; the factor is ± the cell's size in level-0 cells (a level-1
 *   node's piece spans 1 m, so its authored U is stretched to keep the
 *   world density).
 */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { trimRegionAt, type TrimLayout } from '@thirdlight/project-model';
import { VOXEL_SIZE_M } from '@thirdlight/voxel';
import { buildHasInstanceColumns, instanceColumn } from './attribute-instancing';
import { cameraRelative } from './camera-relative';
import { NODE_OPS } from './voxel-surface-sets';
import { wetLook } from './voxel-surface-wetness';

import type { N as AnyNode } from './effects-tsl';

const { attribute, float, texture, uv, varying, vec2 } = TSL;
/** Untyped: a build function's node reads the builder (three's typings take no builder argument). */
const { Fn } = TSL as unknown as AnyNode;

/** The per-vertex flag (1: the run offset applies). */
export const TRIM_RUN_ATTRIBUTE = 'trimRun';
/** Floats a piece's data takes (offset, factor, wetness 0 … 1, unused), as a chunk gives it, and where its wetness is. */
export const PIECE_DATA_FLOATS = 4;
export const PIECE_WET_FLOAT = 2;
/**
 * Where a drawn copy carries its data's first three floats among its 16: the matrix's fourth row, which an
 * affine matrix leaves unused and the columns' transform never reads (float 11 is the surface cache's slot).
 */
export const PIECE_RIDER_FLOATS = [3, 7, 15] as const;

type N = ReturnType<typeof float>;
type B = { hasGeometryAttribute(name: string): boolean };

/** Column `i`'s `w`: the rider in the copy's fourth row (vertex stage; through the culler's list where it culls). */
const riderOf = (i: number): N => (instanceColumn(i) as unknown as { w: N }).w;

/**
 * The drawn copy's (offset, factor) from its columns, passed on to the fragment stage (constant over the copy;
 * a culled draw reads the columns through its list, which only the vertex stage can); (0, 1) on a geometry
 * without columns: the authored U.
 */
const pieceUOf = (): ReturnType<typeof vec2> =>
  Fn((builder: B) => (buildHasInstanceColumns(builder as never) ? varying(vec2(riderOf(0), riderOf(1))) : vec2(0, 1)))() as unknown as ReturnType<typeof vec2>;

/** The drawn copy's wetness, 0 dry … 1 the wettest level (0 on a geometry without columns). */
const pieceWetOf = (): N => Fn((builder: B) => (buildHasInstanceColumns(builder as never) ? varying(riderOf(3)) : float(0)))() as unknown as N;

/**
 * What its cell's wetness does to a kit piece (the voxel surface's R111 look, `voxel-surface-wetness.ts`): the
 * albedo and roughness multipliers and how far the normal detail flattens. A piece stands proud of its faces, so
 * it is measured at its top (height 1): it darkens, smooths and flattens, but water never stands on it.
 */
export function pieceWetLook(): { readonly albedo: N; readonly roughness: N; readonly flatten: N } {
  const w = wetLook(NODE_OPS, pieceWetOf(), float(1));
  return { albedo: w.albedo, roughness: w.roughness, flatten: w.flatten };
}

/** The world-anchored U of a trim piece's vertex: its authored UV with the run offset applied on run faces. */
export function trimRunUv(): ReturnType<typeof vec2> {
  const authored = uv();
  const run = attribute(TRIM_RUN_ATTRIBUTE, 'float');
  const p = pieceUOf();
  // run ? offset + factor × U : U
  return vec2(authored.x.add(run.mul(p.x.add(p.y.sub(1).mul(authored.x)))), authored.y);
}

/** A face is end-on to the piece's x (its U runs across it, not along the run) past this |normal x|. */
const END_ON = 0.05;

/** Sheet U a metre of a layout. */
export function trimUPerMetre(layout: TrimLayout): number {
  return layout.pxPerMetre / layout.size;
}

/** A non-indexed copy of a trim piece's geometry with `trimRun` set on the triangles the run offset applies to (the run along the mesh's `runAxis`). */
export function trimRunGeometry(g: THREE.BufferGeometry, layout: TrimLayout, runAxis: 0 | 1 | 2 = 0): THREE.BufferGeometry {
  const out = g.index === null ? g.clone() : g.toNonIndexed();
  const pos = out.getAttribute('position') as THREE.BufferAttribute;
  const uvs = out.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const flag = new Float32Array(pos.count);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t + 2 < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1).sub(a);
    c.fromBufferAttribute(pos, t + 2).sub(a);
    const n = b.cross(c);
    const len = n.length();
    if (len === 0 || uvs === undefined || Math.abs(n.getComponent(runAxis) / len) >= END_ON) continue;
    const region = trimRegionAt(layout, uvs.getX(t), uvs.getY(t));
    if (region === null || region.kind === 'cap') continue;
    flag[t] = flag[t + 1] = flag[t + 2] = 1;
  }
  out.setAttribute(TRIM_RUN_ATTRIBUTE, new THREE.BufferAttribute(flag, 1));
  return out;
}

/** The material of a trim kit's pieces: `map` (the layout's sheet) sampled at the world-anchored U. */
export function trimMaterial(map: THREE.Texture): THREE.Material {
  // `map` stays on the material for whoever reads which sheet it draws; the colour node is what samples it.
  const m = new MeshLambertNodeMaterial({ color: 0xffffff, map });
  m.colorNode = texture(map, trimRunUv()).mul(pieceWetLook().albedo);
  return cameraRelative(m);
}

/**
 * An instance's (offset, factor): cell `local` of a draw whose corner is
 * `corner` (level-0 cells) and whose cells are `cellMetres` across, its
 * mesh's run (where authored U grows) placed along world axis `axis` (0 x,
 * 1 y, 2 z) with `sign`, read from the instance's whole rotation (its slot
 * rotation, the tip, the case's turns) and the mirror: a vertical edge's U runs
 * up the world's y.
 */
export function pieceU(uPerMetre: number, corner: readonly number[], local: readonly number[], cellMetres: number, axis: number, sign: number): [number, number] {
  const k = cellMetres / VOXEL_SIZE_M;
  const low = (corner[axis]! + local[axis]! * k) * VOXEL_SIZE_M;
  const at = uPerMetre * (sign > 0 ? low : low + cellMetres);
  return [at - Math.floor(at), sign * k];
}

/** The world axis (0–2) and sign a mesh's run axis takes under a rotation (a quarter-turn quaternion: the axis is exact). */
export function runAxisOf(q: THREE.Quaternion, runAxis: 0 | 1 | 2, mirror: boolean, mirrorAxis = 0): [axis: number, sign: number] {
  // A mirrored mesh has its `mirrorAxis` negated: the run flips only when it lies along that axis.
  const flip = mirror && mirrorAxis === runAxis ? -1 : 1;
  const v = new THREE.Vector3(runAxis === 0 ? flip : 0, runAxis === 1 ? flip : 0, runAxis === 2 ? flip : 0).applyQuaternion(q);
  const a = Math.abs(v.x) >= Math.abs(v.y) && Math.abs(v.x) >= Math.abs(v.z) ? 0 : Math.abs(v.y) >= Math.abs(v.z) ? 1 : 2;
  return [a, v.getComponent(a) > 0 ? 1 : -1];
}


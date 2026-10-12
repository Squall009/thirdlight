/**
 * The terrain's stamps in the Scene view (its Stack mode): each stamp's
 * square laid on the ground, turned as the stamp is, and the picked stamp's
 * handles — its body to move it, a corner to resize it (it stays square),
 * a knob beyond its far edge to turn it. A drag shows the square where it
 * goes; its release is one command (the layer list with the stamp changed),
 * and the backend combines the ground under it again.
 *
 * A stamp's frame is the command's: its image's +x and +z turned about +y
 * by the stamp's rotation (`terrainStampRect`, `terrain-layers.ts`).
 *
 * Drawn only, never depth-tested; picked by the editor in screen space.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { TERRAIN_STAMP_SIZE_LIMITS } from '@thirdlight/runtime';

import type { StampRef } from '../session/terrain-brush';
import { tokenColour } from './brush-cursor';

/** A part of the picked stamp under the pointer. */
export type StampHandle = 'move' | 'size' | 'turn';

/** Lifted off the ground. */
const LIFT = 0.1;
/** Points along each side of a square (it follows the ground). */
const SIDE_POINTS = 16;
/** How far beyond the far edge the turn knob sits (a share of the side). */
const KNOB_OUT = 0.18;
/** Screen pixels a handle catches the pointer within. */
export const STAMP_HANDLE_PX = 12;
/** A handle's size on screen (a share of the view's height, as the icon billboards are sized). */
const HANDLE_SCREEN = 0.012;

/** A stamp's place as dragged: its centre, side and turn. */
export interface StampPose {
  at: [number, number];
  size: number;
  rotation: number;
}

/** World (x, z) of a point of a stamp's frame (u, v in its own metres from the centre). */
export function stampPoint(p: StampPose, u: number, v: number): [number, number] {
  const r = (p.rotation * Math.PI) / 180;
  return [p.at[0] + u * Math.cos(r) + v * Math.sin(r), p.at[1] - u * Math.sin(r) + v * Math.cos(r)];
}

/** A world (x, z) in a stamp's frame (u, v). */
export function stampLocal(p: StampPose, x: number, z: number): [number, number] {
  const r = (p.rotation * Math.PI) / 180;
  const dx = x - p.at[0];
  const dz = z - p.at[1];
  return [dx * Math.cos(r) - dz * Math.sin(r), dx * Math.sin(r) + dz * Math.cos(r)];
}

export const poseOf = (r: StampRef): StampPose => ({ at: [r.stamp.at[0], r.stamp.at[1]], size: r.stamp.size, rotation: r.stamp.rotation ?? 0 });

export class TerrainStampHandles {
  private readonly root = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly picked: THREE.LineSegments;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly pickMat: THREE.LineBasicMaterial;
  /** The picked stamp's handles, a screen size whatever the distance: four corners and the turn knob. */
  private readonly corners: THREE.Sprite[];
  private readonly knob: THREE.Sprite;
  private readonly cornerMat: THREE.SpriteMaterial;
  private readonly knobMat: THREE.SpriteMaterial;
  private list: readonly StampRef[] = [];
  private pick: { layer: string; index: number } | null = null;
  /** The picked stamp's pose while it is dragged (null: as stored). */
  private dragged: StampPose | null = null;
  private heightAt: (x: number, z: number) => number | null = () => null;
  private handlesOn = false;

  constructor(parent: THREE.Object3D) {
    this.root.name = 'terrain-stamp-handles';
    this.root.visible = false;
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false });
    this.pickMat = new THREE.LineBasicMaterial({ color: tokenColour('--select'), transparent: true, depthTest: false, depthWrite: false });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
    this.picked = new THREE.LineSegments(new THREE.BufferGeometry(), this.pickMat);
    this.lines.renderOrder = 18;
    this.picked.renderOrder = 19;
    for (const o of [this.lines, this.picked]) {
      o.frustumCulled = false;
      o.raycast = () => undefined;
    }
    this.cornerMat = new THREE.SpriteMaterial({ color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
    this.knobMat = new THREE.SpriteMaterial({ color: tokenColour('--select'), sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, rotation: Math.PI / 4 });
    this.corners = [0, 1, 2, 3].map(() => new THREE.Sprite(this.cornerMat));
    this.knob = new THREE.Sprite(this.knobMat);
    for (const sp of [...this.corners, this.knob]) {
      sp.scale.set(HANDLE_SCREEN, HANDLE_SCREEN, 1);
      sp.renderOrder = 22;
      sp.visible = false;
      sp.raycast = () => undefined;
    }
    this.knob.scale.set(HANDLE_SCREEN * 1.25, HANDLE_SCREEN * 1.25, 1);
    this.root.add(this.lines, this.picked, ...this.corners, this.knob);
    parent.add(this.root);
  }

  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  /** The stamps drawn, the picked one, whether its handles show (the Select tool), the ground. */
  set(list: readonly StampRef[], pick: { layer: string; index: number } | null, handles: boolean, heightAt: (x: number, z: number) => number | null): void {
    this.list = list;
    this.pick = pick;
    this.handlesOn = handles;
    this.heightAt = heightAt;
    this.dragged = null;
    this.draw();
  }

  /** The picked stamp drawn at a pose while dragged (null: as stored). */
  drag(pose: StampPose | null): void {
    this.dragged = pose;
    this.draw();
  }

  pickedRef(): StampRef | null {
    const p = this.pick;
    return p === null ? null : (this.list.find((r) => r.layer === p.layer && r.index === p.index) ?? null);
  }

  /** The picked stamp's handle points (world): its corners, its knob and the knob's base. */
  handlePoints(pose: StampPose): { corners: THREE.Vector3[]; knob: THREE.Vector3 } {
    const h = pose.size / 2;
    const at = (u: number, v: number): THREE.Vector3 => {
      const [x, z] = stampPoint(pose, u, v);
      return new THREE.Vector3(x, (this.heightAt(x, z) ?? 0) + LIFT, z);
    };
    return { corners: [at(-h, -h), at(h, -h), at(h, h), at(-h, h)], knob: at(0, h + pose.size * KNOB_OUT) };
  }

  private draw(): void {
    const pts: number[] = [];
    const pk: number[] = [];
    const yAt = (x: number, z: number): number => (this.heightAt(x, z) ?? 0) + LIFT;
    const square = (out: number[], p: StampPose): void => {
      const h = p.size / 2;
      const corners: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]];
      for (let c = 0; c < 4; c++) {
        const [u0, v0] = corners[c]!;
        const [u1, v1] = corners[(c + 1) % 4]!;
        for (let i = 0; i < SIDE_POINTS; i++) {
          const [xa, za] = stampPoint(p, u0 + ((u1 - u0) * i) / SIDE_POINTS, v0 + ((v1 - v0) * i) / SIDE_POINTS);
          const [xb, zb] = stampPoint(p, u0 + ((u1 - u0) * (i + 1)) / SIDE_POINTS, v0 + ((v1 - v0) * (i + 1)) / SIDE_POINTS);
          out.push(xa, yAt(xa, za), za, xb, yAt(xb, zb), zb);
        }
      }
    };
    const picked = this.pickedRef();
    for (const r of this.list) if (r !== picked) square(pts, poseOf(r));
    if (picked !== null) {
      const pose = this.dragged ?? poseOf(picked);
      square(pk, pose);
      if (this.handlesOn) {
        const { corners, knob } = this.handlePoints(pose);
        corners.forEach((c, i) => this.corners[i]!.position.copy(c));
        this.knob.position.copy(knob);
        // The knob's stem from the far edge's middle.
        const base = stampPoint(pose, 0, pose.size / 2);
        pk.push(base[0], yAt(base[0], base[1]), base[1], knob.x, knob.y, knob.z);
      }
    }
    for (const sp of [...this.corners, this.knob]) sp.visible = picked !== null && this.handlesOn;
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.picked.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pk, 3));
    this.lines.geometry.computeBoundingSphere();
    this.picked.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.root.removeFromParent();
    this.lines.geometry.dispose();
    this.picked.geometry.dispose();
    this.lineMat.dispose();
    this.pickMat.dispose();
    this.cornerMat.dispose();
    this.knobMat.dispose();
  }
}

/** A drag of a picked stamp's handle: the pose it gives for the pointer's ground point. */
export function draggedPose(handle: StampHandle, start: StampPose, from: readonly [number, number], to: readonly [number, number]): StampPose {
  if (handle === 'move') return { ...start, at: [start.at[0] + to[0] - from[0], start.at[1] + to[1] - from[1]] };
  if (handle === 'size') {
    // Scaled by how much farther from the middle the pointer is than where it began (it stays square).
    const reach = (p: readonly [number, number]): number => {
      const [u, v] = stampLocal(start, p[0], p[1]);
      return Math.max(Math.abs(u), Math.abs(v));
    };
    const r0 = reach(from);
    return r0 <= 1e-6 ? start : { ...start, size: Math.max(TERRAIN_STAMP_SIZE_LIMITS.min, (start.size * reach(to)) / r0) };
  }
  const a0 = Math.atan2(from[0] - start.at[0], from[1] - start.at[1]);
  const a1 = Math.atan2(to[0] - start.at[0], to[1] - start.at[1]);
  return { ...start, rotation: start.rotation + ((a1 - a0) * 180) / Math.PI };
}

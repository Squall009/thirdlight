/**
 * The rooms a page's see-through subjects stand in, from its voxel worlds (`SeeThroughRooms` for see-through.ts).
 *
 * Where the worlds run, their open regions are stitched (open-region-stitch.ts); the page sends where the subjects
 * stand (world cells, once they move to another cell) and each world's batches answer, whenever the answer changes,
 * the enclosed region each stands in with its parts' boxes (ChunkDrawBatcher.setFocus). Nothing is walked for it on
 * either side: the answer is the regions' summaries as kept. A subject outdoors, in a doorway or where the regions
 * are not known yet has no room.
 */
import * as THREE from 'three/webgpu';
import { SEE_THROUGH_SUBJECTS } from '@thirdlight/project-model';
import { VOXEL_SIZE_M, type FocusRoomsWire } from '@thirdlight/voxel';

import type { SeeThroughRoom, SeeThroughRooms } from './see-through';

/** Focus messages kept for their answers to find their slots (answers come back in a few frames). */
const FOCUS_KEPT = 8;

export class VoxelFocusRooms implements SeeThroughRooms {
  private n = 0;
  private sent = '';
  /** The slots each focus sent named, in the order of its points. */
  private readonly slotsOf = new Map<number, readonly number[]>();
  /** Each world's last answer, by slot. */
  private readonly answers = new Map<string, readonly (SeeThroughRoom | null)[]>();
  private made = 0;
  /** Answers received (diagnostics). */
  received = 0;

  constructor(private readonly send: (n: number, cells: readonly number[]) => void) {}

  focus(points: readonly (THREE.Vector3 | null)[]): void {
    const cells: number[] = [];
    const slots: number[] = [];
    points.forEach((p, k) => {
      if (p === null) return;
      slots.push(k);
      cells.push(Math.floor(p.x / VOXEL_SIZE_M), Math.floor(p.y / VOXEL_SIZE_M), Math.floor(p.z / VOXEL_SIZE_M));
    });
    const key = `${slots.join(',')}|${cells.join(',')}`;
    if (key === this.sent) return;
    this.sent = key;
    this.n++;
    this.slotsOf.set(this.n, slots);
    this.slotsOf.delete(this.n - FOCUS_KEPT);
    this.send(this.n, cells);
  }

  room(k: number): SeeThroughRoom | null {
    for (const rooms of this.answers.values()) {
      const r = rooms[k] ?? null;
      if (r !== null) return r;
    }
    return null;
  }

  /** A world's answer for one of the focuses sent. */
  answer(world: string, wire: FocusRoomsWire): void {
    const slots = this.slotsOf.get(wire.focus);
    if (slots === undefined) return;
    this.received++;
    const rooms: (SeeThroughRoom | null)[] = [];
    wire.rooms.forEach((r, i) => {
      const k = slots[i];
      if (k === undefined) return;
      if (r === null) {
        rooms[k] = null;
        return;
      }
      const boxes: THREE.Box3[] = [];
      for (let j = 0; j + 5 < r.boxes.length; j += 6) {
        const b = r.boxes;
        boxes.push(new THREE.Box3(new THREE.Vector3(b[j]! * VOXEL_SIZE_M, b[j + 1]! * VOXEL_SIZE_M, b[j + 2]! * VOXEL_SIZE_M), new THREE.Vector3((b[j + 3]! + 1) * VOXEL_SIZE_M, (b[j + 4]! + 1) * VOXEL_SIZE_M, (b[j + 5]! + 1) * VOXEL_SIZE_M)));
      }
      rooms[k] = Object.freeze({ key: `${world}:${r.id}:${++this.made}`, boxes, cell: VOXEL_SIZE_M });
    });
    this.answers.set(world, rooms);
  }

  /** A world closed: its rooms go. */
  drop(world: string): void {
    this.answers.delete(world);
  }

  /** The rooms by slot as last answered (diagnostics, tests): the region's id and its boxes in metres. */
  state(): { readonly received: number; readonly slots: readonly ({ readonly key: string; readonly boxes: readonly number[][] } | null)[] } {
    const slots: ({ key: string; boxes: number[][] } | null)[] = [];
    for (let k = 0; k < SEE_THROUGH_SUBJECTS; k++) {
      const r = this.room(k);
      slots.push(r === null ? null : { key: r.key, boxes: r.boxes.map((b) => [...b.min.toArray(), ...b.max.toArray()]) });
    }
    return { received: this.received, slots };
  }
}

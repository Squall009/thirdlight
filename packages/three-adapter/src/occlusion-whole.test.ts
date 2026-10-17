import * as THREE from 'three';
import { OCCLUSION_MIN_COPIES_TRIANGLES } from '@thirdlight/runtime';
import { describe, expect, it } from 'vitest';

import type { Occludee } from './occludees';
import type { InstanceOcclusion, WholeRow } from './occlusion-instances';
import { culledWhole, viewRangeOf, WholeOcclusion } from './occlusion-whole';

/** The part of the instanced copies' culler a draw culled whole uses, on the CPU. */
class FakeHost {
  next = 0;
  released: number[] = [];
  boxes = new Map<number, number[]>();
  rows: WholeRow[] = [];
  secondListed = true;
  readonly args = { name: 'args' };
  placeWhole(): number {
    return this.next++;
  }
  releaseWhole(base: number): void {
    this.released.push(base);
  }
  wholeBox(base: number, box: ArrayLike<number>): void {
    this.boxes.set(base, Array.from(box));
  }
  addWhole(w: WholeRow): void {
    w.row = this.rows.length;
    this.rows.push(w);
  }
  secondArgs(row: number): { args: unknown; offset: number } {
    return { args: this.args, offset: (row * 10 + 5) * 4 };
  }
}

/** A sphere-ish mesh of about `triangles` triangles at `z` (in front of a camera at the origin looking down -z). */
function meshAt(z: number, triangles = 2 * OCCLUSION_MIN_COPIES_TRIANGLES): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9).fill(0).map((_, i) => (i % 3 === 0 ? i / 3 : 0)), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles * 3), 1));
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -0.5, -0.25), new THREE.Vector3(1, 0.5, 0.25));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  m.position.set(0, 0, z);
  m.updateMatrixWorld();
  return m;
}

const camera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  c.updateMatrixWorld();
  return c;
};

describe('draws culled whole', () => {
  it('are block and architecture chunks, merged cells and models alone', () => {
    expect(['merged', 'blocks', 'architecture', 'single'].every((k) => culledWhole(k as never))).toBe(true);
    expect(['instanced', 'terrain', 'transparent'].some((k) => culledWhole(k as never))).toBe(false);
  });

  it('draw one range: the draw range within the index and the one group, never several groups or a wireframe', () => {
    const m = meshAt(-10, 100);
    const c = camera();
    expect(viewRangeOf(m, c)).toEqual({ count: 300, first: 0 });
    m.geometry.setDrawRange(30, 120);
    expect(viewRangeOf(m, c)).toEqual({ count: 120, first: 30 });
    m.geometry.addGroup(60, 300, 0);
    expect(viewRangeOf(m, c), 'the group cuts the draw range').toEqual({ count: 90, first: 60 });
    m.geometry.addGroup(0, 60, 1);
    expect(viewRangeOf(m, c), 'two groups: not one range').toBeNull();
    const w = meshAt(-10, 100);
    (w.material as THREE.MeshStandardMaterial).wireframe = true;
    expect(viewRangeOf(w, c), 'a wireframe draws its own index').toBeNull();
  });

  it('are listed in the first pass until an answer says hidden, then tested in the second until seen again', () => {
    const host = new FakeHost();
    const wholes = new WholeOcclusion(host as unknown as InstanceOcclusion);
    const near = meshAt(-10);
    const behind = meshAt(-30);
    const glassy = meshAt(-20);
    const list: Occludee[] = [
      { object: near, kind: 'single', role: 'surface' },
      { object: behind, kind: 'blocks', role: 'early' },
      { object: glassy, kind: 'single', role: 'none' },
    ];
    const c = camera();
    const frame = (): void => {
      host.rows = [];
      wholes.update(list, c, (o) => o.role !== 'none')(host as unknown as InstanceOcclusion);
    };
    frame();
    expect(host.rows.length).toBe(3);
    expect(wholes.count).toBe(3);
    // No answer yet: occluders in the first pass, the rest in the second.
    expect([wholes.second(near), wholes.second(behind), wholes.second(glassy)]).toEqual([false, false, true]);
    expect(host.boxes.get((host.rows[1] as WholeRow).base), 'tested as its world box').toEqual([-1, -0.5, -30.25, 1, 0.5, -29.75]);
    // The read-back: `behind` hidden.
    host.rows[1]!.answer(false);
    frame();
    expect(wholes.second(behind), 'hidden: tested in the second pass').toBe(true);
    expect(wholes.second(near)).toBe(false);
    host.rows[1]!.answer(true);
    frame();
    expect(wholes.second(behind), 'seen again: the first pass draws it').toBe(false);
  });

  it('leave out what the frustum, the layers or the triangle count rule out, and give unlisted places back', () => {
    const host = new FakeHost();
    const wholes = new WholeOcclusion(host as unknown as InstanceOcclusion);
    const behindCamera = meshAt(20);
    const small = meshAt(-10, OCCLUSION_MIN_COPIES_TRIANGLES - 1);
    const hidden = meshAt(-10);
    hidden.visible = false;
    const shown = meshAt(-10);
    const list: Occludee[] = [behindCamera, small, hidden, shown].map((object) => ({ object, kind: 'single', role: 'surface' }));
    const c = camera();
    wholes.update(list, c, () => true)(host as unknown as InstanceOcclusion);
    expect(host.rows.map((r) => (r as unknown as { mesh: THREE.Mesh }).mesh)).toEqual([shown]);
    // Out of the list for long enough: its place goes back.
    for (let i = 0; i < 130; i += 1) wholes.update([], c, () => true)(host as unknown as InstanceOcclusion);
    expect(host.released).toEqual([0]);
    expect(wholes.second(shown)).toBe(false);
  });

  it('set the indirect draw only while the second pass draws it, and draw whole when the test did not run', () => {
    const host = new FakeHost();
    const wholes = new WholeOcclusion(host as unknown as InstanceOcclusion);
    const m = meshAt(-10);
    const list: Occludee[] = [{ object: m, kind: 'single', role: 'none' }];
    wholes.update(list, camera(), () => false)(host as unknown as InstanceOcclusion);
    const g = m.geometry as THREE.BufferGeometry & { indirect: unknown; indirectOffset: number };
    let during: unknown = 'not drawn';
    wholes.drawSecond(m, g, () => {
      during = [g.indirect, g.indirectOffset];
    });
    expect(during).toEqual([host.args, 20]);
    expect(g.indirect, 'cleared after the draw (shadow maps draw it whole)').toBeNull();
    host.secondListed = false;
    wholes.drawSecond(m, g, () => {
      during = g.indirect;
    });
    expect(during, 'no test this frame: drawn whole').toBeNull();
  });
});

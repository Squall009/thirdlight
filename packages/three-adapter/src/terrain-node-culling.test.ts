import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CULLABLE_COPIES_KEY, CULLED_COPIES_ATTRIBUTE, INSTANCE_CULLER_KEY } from './attribute-instancing';
import { COPY_BOX_FLOAT } from './occlusion-instances-rule';
import { TerrainNodeCopies } from './terrain-node-culling';
import { PageNodes, TERRAIN_NODE_FLOATS } from './terrain-quadtree';

/** A page's draw: three nodes (two in view), the mesh placed at (100, 5, -40). */
function page(): { copies: TerrainNodeCopies; mesh: THREE.Mesh; nodes: PageNodes; target: { geometry: THREE.InstancedBufferGeometry; buffer: THREE.InstancedInterleavedBuffer }; selected: { now: boolean } } {
  const nodes = new PageNodes();
  nodes.begin();
  nodes.push(true, 0, 0, 16, 2, 0, 0, 30, 0.1, [0, 0, 0, 16, 2, 16]);
  nodes.push(false, 16, 0, 16, 2, 16, 0, 30, 0.1, [16, 0, 0, 32, 2, 16]);
  nodes.push(true, 0, 16, 32, 3, 0, 16, 60, 0.05, [0, 1, 16, 32, 3, 48]);
  nodes.end();
  const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(8 * TERRAIN_NODE_FLOATS), TERRAIN_NODE_FLOATS, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(100, 5, -40);
  mesh.updateMatrixWorld();
  const target = { geometry, buffer };
  const selected = { now: true };
  const copies = new TerrainNodeCopies(mesh, () => target, nodes, () => selected.now);
  return { copies, mesh, nodes, target, selected };
}

describe('a terrain page\'s nodes culled on the GPU', () => {
  it('hand the culler the nodes in view: their floats in each copy\'s first half, their world boxes after them', () => {
    const { copies, mesh } = page();
    expect(mesh.userData[CULLABLE_COPIES_KEY]).toBe(copies);
    expect(copies.capacity).toBe(8);
    const vd = copies.viewDraw()!;
    expect(vd.count, 'the nodes in view lead').toBe(2);
    expect(Array.from(vd.drawn.subarray(0, 8))).toEqual([0, 0, 16, 2, 0, 0, 30, Math.fround(0.1)]);
    expect(Array.from(vd.drawn.subarray(16, 24))).toEqual([0, 16, 32, 3, 0, 16, 60, Math.fround(0.05)]);
    // The box: min xyz at float 8, max xyz at float 12 (the mesh at (100, 5, -40)).
    expect([...vd.drawn.subarray(COPY_BOX_FLOAT, COPY_BOX_FLOAT + 3), ...vd.drawn.subarray(COPY_BOX_FLOAT + 4, COPY_BOX_FLOAT + 7)]).toEqual([100, 5, -40, 116, 7, -24]);
    expect(Array.from(vd.spheres.subarray(4, 7)), 'the sphere round the box').toEqual([116, 7, -8]);
    expect(vd.spheres[7]).toBeCloseTo(Math.hypot(16, 1, 16), 5);
    expect([vd.order[0], vd.order[1]]).toEqual([0, 1]);
  });

  it('are new to the culler when uploaded again or moved, and not culled for a selection made for another view', () => {
    const { copies, mesh, selected } = page();
    const v0 = copies.viewDraw()!.version;
    expect(copies.viewDraw()!.version, 'unchanged').toBe(v0);
    copies.uploaded();
    const v1 = copies.viewDraw()!.version;
    expect(v1).not.toBe(v0);
    mesh.position.x += 1;
    mesh.updateMatrixWorld();
    const moved = copies.viewDraw()!;
    expect(moved.version).not.toBe(v1);
    expect(moved.drawn[COPY_BOX_FLOAT]).toBe(101);
    selected.now = false;
    expect(copies.viewDraw()).toBeNull();
  });

  it('are adopted at their first draw and marked; a geometry made anew is let go and adopted again', () => {
    const { copies, target } = page();
    const adopted: unknown[] = [];
    let released = 0;
    const drawn: boolean[] = [];
    const scene = new THREE.Scene();
    scene.userData[INSTANCE_CULLER_KEY] = {
      adopt(c: TerrainNodeCopies) {
        adopted.push(c);
        c.indirect = { draw: (_g, view) => drawn.push(view), release: () => (released += 1) };
        c.markCulled(true);
      },
    };
    copies.beforeDraw(scene, true);
    copies.beforeDraw(scene, false);
    expect(adopted).toEqual([copies]);
    expect(drawn).toEqual([true, false]);
    expect(target.geometry.getAttribute(CULLED_COPIES_ATTRIBUTE)).toBeDefined();
    copies.renewed();
    expect(released).toBe(1);
    copies.beforeDraw(scene, true);
    expect(adopted.length, 'adopted again').toBe(2);
    copies.markCulled(false);
    expect(target.geometry.getAttribute(CULLED_COPIES_ATTRIBUTE)).toBeUndefined();
  });
});

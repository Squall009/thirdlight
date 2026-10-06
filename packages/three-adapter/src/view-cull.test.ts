/**
 * Culling inside one draw: a batch's members and a merged cell's objects in
 * view lead its draw, nearest first, and only the view's camera draws just
 * those; any other camera (a shadow map) draws everything. Pure three.js in
 * Node: the draw's count is read after its `onBeforeRender`, as the renderer
 * calls it per pass.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createAttributeInstancedMesh } from './attribute-instancing';
import { BATCH_KEY, createAutoBatcher } from './batching';
import { STATIC_KEY } from './static-merge';
import { ViewCuller } from './view-cull';

/** A camera at the origin looking down −Z. */
const viewCamera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  c.updateMatrixWorld();
  return c;
};

/** What `mesh` draws for `camera` (instances for a batch, index entries for a merged cell). */
function drawnFor(mesh: THREE.Mesh, camera: THREE.Camera): number {
  mesh.onBeforeRender(null as never, null as never, camera, mesh.geometry, mesh.material as THREE.Material, null as never);
  const g = mesh.geometry as THREE.InstancedBufferGeometry;
  return g.isInstancedBufferGeometry === true ? g.instanceCount : g.drawRange.count;
}

const at = (x: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, 0, z);

describe('view culling inside a draw', () => {
  it('instances in view lead the buffer nearest first; the view draws those, other cameras all', () => {
    const inst = createAttributeInstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 8);
    // Slots: far ahead, behind the camera, near ahead, far to the side (out of view).
    [at(0, -50), at(0, 30), at(0, -5), at(200, -10)].forEach((m, i) => m.toArray(inst.array, i * 16));
    inst.count = 4;
    inst.markChanged();
    inst.mesh.updateMatrixWorld();
    const culler = new ViewCuller();
    culler.add(inst);
    const cam = viewCamera();
    culler.update(cam);
    expect(inst.inView).toBe(2);
    expect(drawnFor(inst.mesh, cam)).toBe(2);
    const drawn = (inst.mesh.geometry.getAttribute('tlInstanceMatrix3') as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    // Nearest first (z −5, then −50), then the two out of view.
    expect([drawn[14], drawn[16 + 14]]).toEqual([-5, -50]);
    // A shadow camera, or the view camera moved since, draws all four.
    const shadow = new THREE.OrthographicCamera();
    expect(drawnFor(inst.mesh, shadow)).toBe(4);
    cam.position.x = 1;
    cam.updateMatrixWorld();
    expect(drawnFor(inst.mesh, cam)).toBe(4);
    // A still view culls nothing again: no reorder, no upload.
    culler.update(cam);
    const version = (inst.mesh.geometry.getAttribute('tlInstanceMatrix0') as THREE.InterleavedBufferAttribute).data.version;
    culler.update(cam);
    expect(culler.diagnostics().reorders).toBe(0);
    expect((inst.mesh.geometry.getAttribute('tlInstanceMatrix0') as THREE.InterleavedBufferAttribute).data.version).toBe(version);
    // A matrix written since the cull: all are drawn until the next cull.
    inst.markChanged();
    expect(drawnFor(inst.mesh, cam)).toBe(4);
  });

  it("a batch spread over the scene and a merged cell draw only what the view sees; the slots' order is the writers'", () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry();
    const shared = new THREE.MeshLambertMaterial();
    // Four repeated boxes (a batch), two in view, two behind the camera (at z 32).
    const repeated = [at(0, -20), at(2, 40), at(-2, -30), at(0, 60)].map((m) => {
      const mesh = new THREE.Mesh(geometry, shared);
      mesh.applyMatrix4(m);
      mesh.userData[BATCH_KEY] = true;
      scene.add(mesh);
      return mesh;
    });
    // Two static objects of one material in one cell (the camera stands at z 32), one in view and one behind (merged).
    const cellMaterial = new THREE.MeshLambertMaterial();
    const statics = [at(1, 5), at(1, 60)].map((m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), cellMaterial);
      mesh.applyMatrix4(m);
      mesh.userData[BATCH_KEY] = true;
      mesh.userData[STATIC_KEY] = 'scene-main';
      scene.add(mesh);
      return mesh;
    });
    const culler = new ViewCuller();
    const batcher = createAutoBatcher(scene, { viewCull: culler });
    for (const o of [...scene.children]) batcher.listed(o);
    const cam = viewCamera();
    cam.position.z = 32;
    cam.updateMatrixWorld();
    batcher.update(cam);
    culler.update(cam);
    const batch = scene.children.find((o) => o.name.startsWith('tl-batch')) as THREE.Mesh;
    const cell = scene.children.find((o) => o.name.startsWith('tl-merged')) as THREE.Mesh;
    expect(drawnFor(batch, cam)).toBe(2);
    expect(drawnFor(batch, new THREE.OrthographicCamera())).toBe(4);
    const boxIndices = geometry.index!.count;
    expect(drawnFor(cell, cam)).toBe(boxIndices);
    expect(drawnFor(cell, new THREE.OrthographicCamera())).toBe(2 * boxIndices);
    // A member moving behind the camera leaves the view's part on the next frame.
    repeated[0]!.position.z = 50;
    repeated[0]!.updateMatrixWorld();
    batcher.moved(repeated[0]!);
    batcher.update(cam);
    culler.update(cam);
    expect(drawnFor(batch, cam)).toBe(1);
    expect(statics).toHaveLength(2);
  });
});

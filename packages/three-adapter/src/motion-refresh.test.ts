/**
 * Draws under a target holding motion vectors: three's own material observer
 * (`NodeMaterialObserver`, the per-draw check of whether a draw's uniforms and
 * bindings need refreshing) with the engine's motion hook installed. A still
 * draw is refreshed fully once more after its last full refresh (so the last
 * frame's matrices roll over to this frame's), then no more; a moved draw again
 * gets two; outside a motion target three's own rule is unchanged.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { installMotionVectors, MOTION_TARGET, motionRefresh } from './motion-vectors';

const { FULL } = THREE.RenderObjectRefreshType;

type Observer = { needsRefresh(renderObject: object, frame: object): number };

/** One draw of a plain mesh as three's renderer hands it to its observer, and a frame counter. */
function drawOf(mrt: unknown): { mesh: THREE.Mesh; refresh(): number } {
  installMotionVectors();
  const material = new THREE.MeshBasicMaterial({ color: 0x808080 });
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld();
  const Ctor = (THREE as unknown as { NodeMaterialObserver: new (builder: object) => Observer }).NodeMaterialObserver;
  const observer = new Ctor({ material, object: mesh, context: {} });
  const lightsNode = new THREE.LightsNode();
  const renderObject = { object: mesh, material, geometry, lightsNode, bundle: null, scene: new THREE.Scene(), context: { width: 64, height: 64 } };
  const renderer = { getMRT: () => mrt };
  let renderId = 0;
  return {
    mesh,
    refresh(): number {
      renderId += 1;
      return observer.needsRefresh(renderObject, { renderer, renderId });
    },
  };
}

const motion = (): unknown => TSL.mrt({ output: TSL.vec4(1), [MOTION_TARGET]: TSL.vec4(0) });

describe('motion refresh', () => {
  it('refreshes a still draw fully twice, then not; a move gives two more', () => {
    const d = drawOf(motion());
    const kinds = [d.refresh(), d.refresh(), d.refresh(), d.refresh()];
    expect(kinds.map((k) => k === FULL)).toEqual([true, true, false, false]);
    d.mesh.position.x = 1;
    d.mesh.updateMatrixWorld();
    const moved = [d.refresh(), d.refresh(), d.refresh()];
    expect(moved.map((k) => k === FULL)).toEqual([true, true, false]);
  });

  it('keeps three’s own rule without a motion target', () => {
    const d = drawOf(TSL.mrt({ output: TSL.vec4(1) }));
    expect([d.refresh(), d.refresh(), d.refresh()].map((k) => k === FULL)).toEqual([true, false, false]);
    const none = drawOf(null);
    expect([none.refresh(), none.refresh()].map((k) => k === FULL)).toEqual([true, false]);
  });

  it('gives one more full refresh after each full one, never two', () => {
    const drawn = {};
    expect(motionRefresh(drawn, FULL, FULL)).toBe(FULL);
    expect(motionRefresh(drawn, 0, FULL)).toBe(FULL);
    expect(motionRefresh(drawn, 0, FULL)).toBe(0);
    expect(motionRefresh(drawn, 1, FULL)).toBe(1);
  });
});

/**
 * The structure tool driven by pointer events as the Scene view hands them on, in Node: a camera, a canvas
 * rectangle and a host whose voxel pick answers as the view's would. What the drags send is the command the
 * structure mode stores: a rectangle on the ground makes a house of the cells it spans, an edge handle dragged 2 m
 * widens it by four cells, the storey arrow dragged up adds storeys (a structure's hand edits are the voxel brush
 * tool's: voxel-brush-tool.test.ts). The overlay and the readout are drawing; only what is sent is checked here.
 */
import * as THREE from 'three';
import { BUILDING_GENERATOR, VOXEL_SIZE_M, type GridPlacement, type StructureDefinition } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

import { openingOnWall, wallUnderCell, withOpening } from '../session/structure-openings';
import { definitionOf, footprintMiddle, moveEdge, newStructure, storeysFor, withPolygonPoints } from '../session/structure-shape';
import type { ScenePickHit } from '../voxel-world/scene-voxels-wire';
import { StructureTool, type StructureArm, type StructureToolCallbacks } from './structure-tool';

const RECT = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600 };
const MAT = { wall: 3, floor: 3, roof: 3, foundation: 3, stair: 3 };

function rig(pick: (x: number, y: number) => ScenePickHit | null) {
  const attrs = new Map<string, string>();
  const canvas = {
    getBoundingClientRect: () => RECT,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    parentElement: null,
  } as unknown as HTMLCanvasElement;
  const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 500);
  camera.position.set(4.5, 14, 22);
  camera.lookAt(4.5, 0, 3.5);
  camera.updateMatrixWorld();
  const sent = { create: [] as unknown[][], define: [] as [string, StructureDefinition][], refused: [] as string[], selected: [] as (string | null)[] };
  const cb: StructureToolCallbacks = {
    create: async (...a) => void sent.create.push(a),
    define: async (id, def) => void sent.define.push([id, def]),
    place: async () => undefined,
    refused: (m) => void sent.refused.push(m),
    readout: () => undefined,
    selectOpening: (id) => void sent.selected.push(id),
  };
  const place: GridPlacement = { gridId: 7, position: [0, 0, 0], yawRad: 0 };
  const tool = new StructureTool(
    {
      overlay: new THREE.Group(),
      camera,
      canvas: () => canvas,
      requestRender: () => undefined,
      pick: (x, y) => Promise.resolve(pick(x, y)),
      place: () => place,
      preview: () => undefined,
    },
    cb,
  );
  /** Client px of a world point. */
  const screen = (x: number, y: number, z: number): { x: number; y: number } => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * RECT.width, y: ((1 - p.y) / 2) * RECT.height };
  };
  /** Where a client point's ray meets the plane y = h. */
  const ground = (sx: number, sy: number, h: number): THREE.Vector3 => {
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2((sx / RECT.width) * 2 - 1, -(sy / RECT.height) * 2 + 1), camera);
    return r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), new THREE.Vector3())!;
  };
  const ev = (p: { x: number; y: number }): PointerEvent => ({ clientX: p.x, clientY: p.y, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 }) as unknown as PointerEvent;
  const handles = (): { id: string; x: number; y: number }[] => {
    tool.frame();
    return (JSON.parse(canvas.getAttribute('data-structure-tool')!) as { handles: { id: string; x: number; y: number }[] }).handles;
  };
  return { tool, sent, screen, ground, ev, handles, camera };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const arm = (o: Partial<StructureArm>): StructureArm => ({ tool: 'create', navigate: false, world: 'yard', entityId: null, value: null, marker: null, ...o });

const house = () => ({ ...newStructure('yard', 16, 12, MAT).value, grid: 7 });

describe('the structure tool: pointer to command', () => {
  it('a drag on the ground creates a house of the cells it spans, at the ground the pick found; too small or on a structure is refused', async () => {
    const r = rig((x, y) => {
      // The view's pick: the ray's distance to the ground (y = 0) under the pointer.
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2((x / RECT.width) * 2 - 1, -(y / RECT.height) * 2 + 1), r.camera);
      const at = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())!;
      return { world: 'yard', grid: 0, t: at.distanceTo(raycaster.ray.origin), cell: [0, 0, 0], normal: [0, 1, 0], record: null };
    });
    r.tool.arm(arm({}));
    expect(r.tool.pointerDown(r.ev(r.screen(-2, 0, -1.5)))).toBe('capture');
    await flush();
    r.tool.pointerMove(r.ev(r.screen(2, 0, 1.5)));
    r.tool.pointerUp(r.ev(r.screen(2, 0, 1.5)));
    // As the command carries it (JSON: a ground of -0 is 0).
    expect(JSON.parse(JSON.stringify(r.sent.create))).toEqual([['yard', [-2, 0, -1.5], 4 / VOXEL_SIZE_M, 3 / VOXEL_SIZE_M]]);
    // A drag under 1.5 m a side sends nothing and says why.
    r.tool.pointerDown(r.ev(r.screen(0, 0, 0)));
    await flush();
    r.tool.pointerUp(r.ev(r.screen(0.5, 0, 0.5)));
    expect(r.sent.create).toHaveLength(1);
    expect(r.sent.refused.at(-1)).toMatch(/at least 1.5 m/);
  });

  it('a press that meets another structure, or nothing, is refused', async () => {
    let hit: ScenePickHit | null = { world: 'yard', grid: 3, t: 10, cell: [0, 0, 0], normal: [0, 1, 0], record: 1 };
    const r = rig(() => hit);
    r.tool.arm(arm({}));
    r.tool.pointerDown(r.ev({ x: 400, y: 300 }));
    await flush();
    r.tool.pointerUp(r.ev({ x: 500, y: 350 }));
    expect(r.sent.refused).toContain('Draw the building on the ground, not on another structure.');
    hit = null;
    r.tool.pointerDown(r.ev({ x: 400, y: 300 }));
    await flush();
    expect(r.sent.refused.at(-1)).toMatch(/met nothing/);
    expect(r.sent.create).toEqual([]);
  });

  it('the +x edge handle dragged 2 m out widens the house by four cells (one define); the storey arrow dragged up adds storeys', () => {
    const value = house();
    const r = rig(() => null);
    r.tool.arm(arm({ tool: 'shape', entityId: 'house-1', value }));
    // Edge 1 of the footprint runs along z at its +x end.
    const edge = r.handles().find((h) => h.id === 'edge:0:1')!;
    expect(edge).toBeDefined();
    expect(r.tool.pointerDown(r.ev(edge))).toBe('capture');
    const from = r.ground(edge.x, edge.y, VOXEL_SIZE_M);
    const to = r.screen(from.x + 2, VOXEL_SIZE_M, from.z);
    r.tool.pointerMove(r.ev(to));
    r.tool.pointerUp(r.ev(to));
    const def = definitionOf(value);
    expect(r.sent.define).toEqual([['house-1', withPolygonPoints(def, 0, moveEdge(def.footprint[0]!.points, 1, 4))]]);

    // The storey arrow: above the footprint's middle; dragged 3.5 m up on the plane facing the camera.
    const storey = r.handles().find((h) => h.id === 'storey')!;
    const box = BUILDING_GENERATOR.box(def);
    const mid = footprintMiddle(def);
    const at = new THREE.Vector3(mid[0], (box.maxY + 1) * VOXEL_SIZE_M + 1.2, mid[2]);
    const pressAt = r.screen(at.x, at.y, at.z);
    expect(Math.hypot(pressAt.x - storey.x, pressAt.y - storey.y)).toBeLessThan(1);
    r.tool.pointerDown(r.ev(storey));
    const up = r.screen(at.x, at.y + 3.5, at.z);
    r.tool.pointerMove(r.ev(up));
    r.tool.pointerUp(r.ev(up));
    const storeys = storeysFor(1, 3.5, value.storeyHeight);
    expect(storeys).toBeGreaterThan(1);
    expect(r.sent.define[1]).toEqual(['house-1', { ...def, storeys }]);
  });

  it('a click on a wall cell with the Openings tool places a door there (one define, selected); a click on no wall is refused', async () => {
    const value = house();
    const def = definitionOf(value);
    const door = { kind: 'door' as const, width: 2, height: 4, sill: 0 };
    // A cell of the wall along the footprint's first edge (z = 1 cell), facing out (−z), a storey's row up.
    const cell: [number, number, number] = [6, value.foundationDepth + 1, 1];
    const wall = wallUnderCell(def, cell, [0, 0, -1]);
    expect(wall).not.toBeNull();
    let hit: ScenePickHit = { world: 'yard', grid: 7, t: 20, cell, normal: [0, 0, -1], record: 77 };
    const r = rig(() => hit);
    r.tool.arm(arm({ tool: 'openings', entityId: 'house-1', value, opening: { shape: door, selected: null } }));
    r.tool.pointerMove(r.ev({ x: 400, y: 300 }));
    await flush();
    expect(r.tool.pointerDown(r.ev({ x: 400, y: 300 }))).toBe('consume');
    const o = openingOnWall(def, wall!, door);
    expect(r.sent.define).toEqual([['house-1', withOpening(def, o)]]);
    expect(r.sent.selected).toEqual([o.id]);
    // The roof's top (no wall under it): refused in words, nothing sent.
    hit = { world: 'yard', grid: 7, t: 20, cell: [6, 30, 6], normal: [0, 1, 0], record: 77 };
    r.tool.pointerMove(r.ev({ x: 410, y: 300 }));
    await flush();
    r.tool.pointerDown(r.ev({ x: 410, y: 300 }));
    expect(r.sent.define).toHaveLength(1);
    expect(r.sent.refused.at(-1)).toMatch(/an opening goes in a wall/);
  });
});

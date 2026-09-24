/**
 * Phase 9.9: the overlay's gameplay helpers — a mover's path and the areas of
 * triggers, switches and enemies follow the projection (three.js objects, no
 * pixels; how they look in the browser is unverified here).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { ZoneOverlay } from './zone-overlay';
import { commitValue } from '../session/handles';
import type { ProjectedEntity } from '../session/projection';

/** A hand-made slice of the descriptor registry (the editor may not import project-model values; the real one is checked in tests/integration/m15-handles). */
const num = (key: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'number', key, label: key, tooltip: key, ...o });
const obj = (key: string, fields: unknown[], o: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'object', key, label: key, tooltip: key, fields, ...o });
const REG = {
  version: 1,
  components: [
    {
      name: 'controller',
      value: obj('controller', [obj('capsule', [num('radius', { required: true, min: 0.05, max: 5, default: 0.3 }), num('height', { required: true, min: 0.1, max: 20, default: 1.8 }), { type: 'vec2', key: 'offset', label: 'o', tooltip: 'o', min: -10, max: 10, default: [0, 0] }])]),
      handles: [{ kind: 'capsule', label: 'Capsule', bind: { radius: 'capsule/radius', height: 'capsule/height', offset: 'capsule/offset' }, space: 'local' }],
    },
    {
      name: 'trigger',
      value: obj('trigger', [
        { type: 'enum', key: 'shape', label: 's', tooltip: 's', options: [], default: 'box' },
        { type: 'vec2', key: 'size', label: 's', tooltip: 's', required: true, when: { key: 'shape', in: ['box'] }, min: 0.05, max: 500 },
        num('radius', { required: true, when: { key: 'shape', in: ['circle'] }, min: 0.025, max: 250 }),
      ]),
      handles: [
        { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', when: { key: 'shape', in: ['box'] } },
        { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: { key: 'shape', in: ['circle'] } },
      ],
    },
    {
      name: 'mover',
      value: obj('mover', [{ type: 'list', key: 'waypoints', label: 'w', tooltip: 'w', required: true, minItems: 1, maxItems: 16, item: { type: 'vec3', key: '*', label: 'p', tooltip: 'p', min: -1000, max: 1000 } }, { type: 'enum', key: 'mode', label: 'm', tooltip: 'm', options: [], default: 'pingpong' }]),
      handles: [{ kind: 'path', label: 'Waypoints', bind: { points: 'waypoints' }, space: 'local', loop: { key: 'mode', in: ['loop'] } }],
    },
  ],
} as unknown as DescriptorRegistry;

const entity = (id: string, blocks: ProjectedEntity['blocks']): ProjectedEntity =>
  ({ id, name: id, parentId: null, kind: 'box', active: true, locked: false, static: false, tags: 0, position: [2, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], blocks, components: { ...(blocks ?? {}) } }) as ProjectedEntity;

/** A camera looking straight at the game plane, 10 m out, on a 1000 px square view. */
function frontView(): { scene: THREE.Scene; overlay: ZoneOverlay; screen: (x: number, y: number, z?: number) => [number, number] } {
  const scene = new THREE.Scene();
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) } as unknown as HTMLCanvasElement;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const overlay = new ZoneOverlay(scene, camera, canvas);
  overlay.setHandleSources(REG, () => null);
  const screen = (x: number, y: number, z = 0): [number, number] => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return [((p.x + 1) / 2) * 1000, ((1 - p.y) / 2) * 1000];
  };
  return { scene, overlay, screen };
}


describe('zone overlay gameplay helpers', () => {
  it('draws a mover path through its stops and outlines trigger/switch/enemy areas; follows removal', () => {
    const scene = new THREE.Scene();
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLCanvasElement;
    const overlay = new ZoneOverlay(scene, new THREE.PerspectiveCamera(), canvas);
    overlay.sync([
      entity('lift', { mover: { waypoints: [[0, 3, 0], [4, 3, 0]], speed: 1, mode: 'loop' } }),
      entity('plate', { switch: { mode: 'stand', signal: 'open', size: [1, 1] } }),
      entity('slime', { enemy: { patrol: 'points', range: [-2, 2], speed: 1, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 } }),
    ]);
    const h = overlay.blockHelpers();
    expect(h.moverPaths).toEqual(['lift']);
    const path = scene.getObjectByName('mover-path:lift') as THREE.Line;
    const pos = path.geometry.getAttribute('position');
    expect(pos.count).toBe(4); // start, two stops, back to the start (loop)
    expect([pos.getX(1), pos.getY(1)]).toEqual([2, 4]);
    expect(h.count).toBe(1 + 3 + 1 + 1 + 1); // path + a dot per stop (3), switch area, enemy area + range
    overlay.sync([entity('plate', { switch: { mode: 'stand', signal: 'open', size: [1, 1] } })]);
    expect(overlay.blockHelpers()).toEqual({ moverPaths: [], count: 1, colliders: 0, capsules: 0, sizeHandles: 0, chaseBands: 0 });
    overlay.dispose();
  });

  it('phase 15.2: an enemy with a chase distance gets its band drawn', () => {
    const { scene, overlay } = frontView();
    overlay.sync([entity('slime', { enemy: { patrol: 'edges', speed: 1, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1, chase: 3, chaseHeight: 1 } })]);
    expect(overlay.blockHelpers().chaseBands).toBe(1);
    const band = scene.getObjectByName('enemy-chase:slime') as THREE.Line;
    const pos = band.geometry.getAttribute('position');
    const xs = Array.from({ length: pos.count }, (_, i) => pos.getX(i));
    const ys = Array.from({ length: pos.count }, (_, i) => pos.getY(i));
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-1, 5, 0, 2]);
    overlay.dispose();
  });

  it("phase 9.12/15.2: collider outlines; the selected mover's path points drag, an insert grip adds a point, the last point stays", () => {
    const { scene, overlay, screen } = frontView();
    const lift = { ...entity('lift', { mover: { waypoints: [[2, 0, 0]], speed: 1, mode: 'once' } }), position: [0, 0, 0], collider: { shape: { type: 'box', hx: 1, hy: 0.2 } } } as ProjectedEntity;
    const ramp = { ...entity('ramp', undefined), collider: { shape: { type: 'polygon', vertices: [[0, 0], [2, 0], [2, 1]] } } } as ProjectedEntity;
    overlay.sync([lift, ramp]);
    expect(overlay.blockHelpers().colliders).toBe(2);
    expect((scene.getObjectByName('collider-outline:lift') as THREE.Line).geometry.getAttribute('position').count).toBe(5);
    // Only the selection has grips.
    expect(overlay.pickHandle(...screen(2, 0))).toBeNull();
    overlay.setSelected('lift');
    expect(overlay.sizeHandleClientPoints().map((h) => `${h.kind}:${h.handle}:${h.role}`)).toEqual(['path:p0:vertex', 'path:i0:insert']);
    const ref = overlay.pickHandle(...screen(2, 0))!;
    expect(ref).toMatchObject({ entityId: 'lift', grip: 'p0', role: 'vertex' });
    expect(overlay.beginHandleDrag(ref)).toBe(true);
    overlay.moveHandleDrag(...screen(3.1, 0.9), true);
    const moved = overlay.endHandleDrag()!;
    expect(commitValue(moved)).toEqual({ ok: true, component: 'mover', value: { waypoints: [[3, 1, 0]] } });
    // The insert grip halfway along the first segment adds a point there, then drags it.
    const ins = overlay.pickHandle(...screen(1, 0))!;
    expect(ins).toMatchObject({ grip: 'i0', role: 'insert' });
    overlay.beginHandleDrag(ins);
    overlay.moveHandleDrag(...screen(1, 2), true);
    expect(commitValue(overlay.endHandleDrag()!)).toEqual({ ok: true, component: 'mover', value: { waypoints: [[1, 2, 0], [2, 0, 0]] } });
    // Alt+click: the last point cannot go (a path keeps one).
    expect(overlay.deleteHandlePoint(ref)).toEqual({ ok: false, message: 'Waypoints keeps at least 1 point' });
    overlay.dispose();
  });

  it("phase 14.0/15.2: the player capsule outline is drawn and picked; the selected player's capsule grips drag (feet kept, snapped)", () => {
    const { scene, overlay, screen } = frontView();
    const player = { ...entity('player', undefined), position: [0, 0, 0], controller: true, components: { controller: {} } } as ProjectedEntity;
    const plate = { ...entity('plate', { trigger: { size: [2, 2], signal: 's' } }), position: [3, 0, 0] } as ProjectedEntity;
    overlay.sync([player, plate]);
    expect(overlay.blockHelpers()).toMatchObject({ capsules: 1, sizeHandles: 0 });
    expect(scene.getObjectByName('capsule-outline:player')).toBeDefined();
    expect(overlay.capsuleAt(...screen(0.3, 0, 0.03))).toEqual({ entityId: 'player', onOutline: true });
    expect(overlay.capsuleAt(...screen(0, 0, 0.03))).toEqual({ entityId: 'player', onOutline: false });
    expect(overlay.capsuleAt(...screen(2, 2, 0.03))).toBeNull();
    overlay.setSelected('player');
    expect(overlay.blockHelpers().sizeHandles).toBe(2);
    const top = overlay.sizeHandleClientPoints().find((h) => h.handle === 'top')!;
    expect(top).toMatchObject({ component: 'controller', kind: 'capsule' });
    const ref = overlay.pickHandle(top.x, top.y)!;
    expect(ref).toMatchObject({ entityId: 'player', shapeIndex: 0, grip: 'top' });
    overlay.beginHandleDrag(ref);
    overlay.moveHandleDrag(...screen(0, 0.12), true);
    // The top at 0.1 above the origin with the feet at −0.9: height 1.0, the offset follows.
    expect(commitValue(overlay.endHandleDrag()!)).toEqual({ ok: true, component: 'controller', value: { capsule: { radius: 0.3, height: 1, offset: [0, -0.4] } } });
    overlay.setSelected('plate');
    expect(overlay.sizeHandleClientPoints().map((h) => `${h.component}:${h.handle}`)).toEqual(['trigger:top', 'trigger:side']);
    overlay.setGizmos({ colliders: false, gameplay: true });
    expect(overlay.capsuleAt(...screen(0.3, 0, 0.03))).toBeNull();
    overlay.dispose();
  });

  it('phase 14.2/15.2: a circle trigger is drawn as a circle with one radius grip that drags', () => {
    const { scene, overlay, screen } = frontView();
    const ring = { ...entity('ring', { trigger: { shape: 'circle', radius: 1.5, signal: 's' } }), position: [1, 2, 0] } as ProjectedEntity;
    overlay.sync([ring]);
    const circle = scene.getObjectByName('trigger-circle:ring') as THREE.Line;
    const pos = circle.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(Math.hypot(pos.getX(i) - 1, pos.getY(i) - 2)).toBeCloseTo(1.5, 6);
    overlay.setSelected('ring');
    const handles = overlay.sizeHandleClientPoints();
    expect(handles.map((h) => `${h.component}:${h.kind}:${h.handle}`)).toEqual(['trigger:radius:side']);
    overlay.beginHandleDrag(overlay.pickHandle(handles[0]!.x, handles[0]!.y)!);
    overlay.moveHandleDrag(...screen(1, 4.52), true);
    expect(commitValue(overlay.endHandleDrag()!)).toEqual({ ok: true, component: 'trigger', value: { radius: 2.5 } });
    overlay.dispose();
  });
});

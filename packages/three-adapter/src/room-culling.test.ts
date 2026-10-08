/**
 * Rooms on the page: drawables and lamps take the room they are in, a chunk
 * spanning rooms takes them per vertex (or one key when all its faces look
 * into one), the walk hides what no portal shows (still drawn by the shadow
 * cameras) and shows it again, a closed door piece hides the rooms behind
 * it, a lamp lights only its room's drawables, the room is part of a batch's
 * key, and a page without rooms is left alone. Browser-free.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { architectureStylesOf, expandArchitecture, type ArchitectureComponent, type ArchitectureOutline } from '@thirdlight/runtime';

import { batchKey, batchKeyParts, BATCH_KEY } from './batching';
import { LayeredPointLight, lightsObject, ROOM_ATTRIBUTE, ROOM_KEY, ROOM_VERTEX_KEYS } from './light-layers';
import { portalsFromUrl, RoomCulling, ROOM_TAG_KEY } from './room-culling';
import { OFF_VIEW_LAYER } from './view-hidden';

const box = (x0: number, z0: number, x1: number, z1: number): [number, number, number][] => [
  [x0, 0, z0],
  [x1, 0, z0],
  [x1, 0, z1],
  [x0, 0, z1],
];
const room = (id: string, pts: [number, number, number][], extra: Partial<ArchitectureOutline> = {}): ArchitectureOutline => ({ id, preset: 'starter-room', path: { points: pts, closed: true }, ...extra });
/** Three 4 m rooms along x (a 0–4, b 4–8, c 8–12), doors a–b at x = 4 and b–c at x = 8 (z 1–2), drawn on layer `floor` (1 m cells). */
const ROW: ArchitectureComponent = {
  elements: [],
  layer: 'floor',
  outlines: [room('a', box(0, 0, 4, 4)), room('b', box(4, 0, 8, 4), { openings: [{ id: 'door', at: 14.5, width: 1, bottom: 0, top: 2.1 }] }), room('c', box(8, 0, 12, 4), { openings: [{ id: 'door', at: 14.5, width: 1, bottom: 0, top: 2.1 }] })],
};

function setup(culling = true): { rooms: RoomCulling; scene: THREE.Scene; closed: Set<string>; regrouped: THREE.Object3D[]; bound: boolean[] } {
  const scene = new THREE.Scene();
  const closed = new Set<string>();
  const regrouped: THREE.Object3D[] = [];
  const bound: boolean[] = [];
  const rooms = new RoomCulling({ scene, edgeClosed: (layer, x, y, z, axis) => closed.has(`${layer}:${x},${y},${z},${axis}`), regroup: (o) => void regrouped.push(o), roomLights: (on) => void bound.push(on), culling, changed: () => undefined });
  return { rooms, scene, closed, regrouped, bound };
}

const placeRooms = (rooms: RoomCulling): void => {
  const x = expandArchitecture(ROW, [0, 0, 0], architectureStylesOf([]));
  rooms.setObject('house', [0, 0, 0], x.rooms, { id: 'floor', origin: [0, 0, 0], cellSize: [1, 0.5, 1] });
};

/** A 0.4 m box at (x, 0.5, z), listed like the render graph lists a drawable. */
function prop(scene: THREE.Scene, rooms: RoomCulling, x: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial());
  m.position.set(x, 0.5, z);
  m.updateMatrixWorld(true);
  m.matrixAutoUpdate = false;
  m.matrixWorldAutoUpdate = false;
  scene.children.push(m);
  rooms.listed(m);
  return m;
}

function camera(eye: [number, number, number], at: [number, number, number]): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  c.position.set(...eye);
  c.lookAt(...at);
  c.updateMatrixWorld();
  return c;
}

const inView = (m: THREE.Object3D): boolean => m.layers.isEnabled(0);

describe('room culling', () => {
  it('the URL switch', () => {
    expect(portalsFromUrl('')).toBe(true);
    expect(portalsFromUrl('?portals=off')).toBe(false);
  });

  it('drawables take their room; the walk hides what no open portal shows, the shadow cameras still draw it', () => {
    const { rooms, scene, closed, bound } = setup();
    placeRooms(rooms);
    expect(bound).toEqual([true]);
    const [a, b, c] = [prop(scene, rooms, 2, 2), prop(scene, rooms, 6, 2), prop(scene, rooms, 10, 2)];
    const outdoor = prop(scene, rooms, 6, -5);
    // In a, looking down the row through both doors.
    const look = camera([1, 1.6, 1.5], [12, 1.2, 1.5]);
    rooms.update(look);
    expect([a, b, c, outdoor].map((m) => m.userData[ROOM_KEY])).toEqual([1, 2, 3, 0]);
    expect([a, b, c].map(inView)).toEqual([true, true, true]);
    // No window: the outside is not seen from in here.
    expect(inView(outdoor)).toBe(false);
    expect(outdoor.layers.isEnabled(OFF_VIEW_LAYER)).toBe(true);
    // The door between b and c shut (a closed piece on its foot's cell edge: the line x = 8, row 0, column z 1).
    closed.add('floor:8,0,1,0');
    rooms.update(look);
    expect([a, b, c].map(inView)).toEqual([true, true, false]);
    expect(rooms.diagnostics()).toMatchObject({ rooms: 3, doors: 2, doorsClosed: 1, seen: 2, outside: false, eyeRoom: 'house/a' });
    // Opened again; then looking away from the doors: only a.
    closed.clear();
    rooms.update(look);
    expect(inView(c)).toBe(true);
    rooms.update(camera([3, 1.6, 1.5], [-10, 1.2, 1.5]));
    expect([a, b, c].map(inView)).toEqual([true, false, false]);
  });

  it('without culling (?portals=off) nothing is hidden, the room tests stay', () => {
    const { rooms, scene } = setup(false);
    placeRooms(rooms);
    const c = prop(scene, rooms, 10, 2);
    rooms.update(camera([3, 1.6, 1.5], [-10, 1.2, 1.5]));
    expect(c.userData[ROOM_KEY]).toBe(3);
    expect(inView(c)).toBe(true);
  });

  it('a lamp lights only its room\'s drawables; a chunk spanning rooms by the room each face looks into', () => {
    const { rooms, scene } = setup();
    placeRooms(rooms);
    const [a, b] = [prop(scene, rooms, 2, 2), prop(scene, rooms, 6, 2)];
    const lamp = new LayeredPointLight(0xffffff, 1, 6);
    lamp.position.set(2, 2, 2);
    lamp.updateMatrixWorld();
    scene.children.push(lamp);
    rooms.listed(lamp);
    expect(lamp.userData[ROOM_KEY]).toBe(1);
    expect([lightsObject(lamp, a), lightsObject(lamp, b)]).toEqual([true, false]);
    // A floor plane under all three rooms facing up, opted in: per vertex (its corners in a and c, two vertices each).
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(11, 3).rotateX(-Math.PI / 2).translate(6, 0, 2), new THREE.MeshStandardMaterial());
    floor.userData[ROOM_TAG_KEY] = 'floor';
    floor.updateMatrixWorld(true);
    scene.children.push(floor);
    rooms.listed(floor);
    const attr = floor.geometry.getAttribute(ROOM_ATTRIBUTE);
    expect(attr).toBeDefined();
    expect([...(floor.userData[ROOM_VERTEX_KEYS] as Set<number>)].sort()).toEqual([1, 3]);
    expect(lightsObject(lamp, floor)).toBe(true);
    // A chunk all in b: one key, no attribute.
    const inB = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2).translate(6, 0, 2), new THREE.MeshStandardMaterial());
    inB.userData[ROOM_TAG_KEY] = true;
    inB.updateMatrixWorld(true);
    rooms.listed(inB);
    expect(inB.geometry.getAttribute(ROOM_ATTRIBUTE)).toBeUndefined();
    expect(inB.userData[ROOM_KEY]).toBe(2);
    expect(lightsObject(lamp, inB)).toBe(false);
    // A chunk of a layer no room is drawn on: no room.
    const other = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
    other.userData[ROOM_TAG_KEY] = 'elsewhere';
    rooms.listed(other);
    expect(other.userData[ROOM_KEY]).toBeUndefined();
  });

  it('the room is part of a batch\'s key; a drawable that changes room is grouped again', () => {
    const { rooms, scene, regrouped } = setup();
    placeRooms(rooms);
    const a = prop(scene, rooms, 2, 2);
    a.userData[BATCH_KEY] = true;
    const b = prop(scene, rooms, 6, 2);
    b.userData[BATCH_KEY] = true;
    b.geometry = a.geometry;
    b.material = a.material;
    expect(batchKey(batchKeyParts(a)!, null, 8)).not.toBe(batchKey(batchKeyParts(b)!, null, 8));
    expect(regrouped).toContain(a);
    regrouped.length = 0;
    a.position.set(6, 0.5, 3);
    a.updateMatrix();
    a.matrixWorld.copy(a.matrix);
    rooms.moved(a);
    expect(a.userData[ROOM_KEY]).toBe(2);
    expect(regrouped).toEqual([a]);
  });

  it('a page whose rooms go leaves everything as it was', () => {
    const { rooms, scene, bound } = setup();
    placeRooms(rooms);
    const c = prop(scene, rooms, 10, 2);
    rooms.update(camera([3, 1.6, 1.5], [-10, 1.2, 1.5]));
    expect(inView(c)).toBe(false);
    rooms.setObject('house', [0, 0, 0], null);
    rooms.update(camera([3, 1.6, 1.5], [-10, 1.2, 1.5]));
    expect(inView(c)).toBe(true);
    expect(c.userData[ROOM_KEY]).toBeUndefined();
    expect(bound).toEqual([true, false]);
  });
});

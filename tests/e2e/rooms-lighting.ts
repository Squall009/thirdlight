/**
 * Rooms light and cull by room (shared by the layered-material spec, whose
 * trim sheet, fixed Play camera and export they are read with).
 *
 * Three starter rooms (walls, floor and ceiling) on a floor of cells right
 * of the camera's view, past the columns: R and L side by side (L right of
 * R) sharing a wall without an opening, each with an arch in its front wall
 * toward the camera; C behind R, through a door in R's back wall that a
 * closed door piece shuts; a box in C. A white lamp without a shadow (2 m
 * range) stands low in R by the shared wall. The camera looks in at a
 * slant, so the floors are read just inside the arches.
 *
 * - Lighting: R's floor by the lamp is lit by it; L's floor just across the
 *   wall from the lamp (1.2 m from it) is as bright as L's floor out of the
 *   lamp's range (no light through the wall), where without the rooms'
 *   light layer the lamp would light it.
 * - Culling: C is not seen (its only portal is shut), so its box is not
 *   drawn (Play's diagnostics, the export canvas' `data-tl-rooms`).
 * - Furniture: kit copies of one grey cube model placed by an architecture
 *   object of their own (one chunk, one model): one in L just across the
 *   wall from the lamp, one far in R. Copies are drawn per room, so the L
 *   cube's face toward the lamp is lit no more than its face toward the
 *   camera (the sun lights both); drawn as one draw, the draw's bounds'
 *   middle lies in R and the lamp would light the L cube through the wall.
 */
import { multiPieceGlb } from './multi-piece-glb';
import { expect } from './pw';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type V3 = readonly [number, number, number];

/** The floor layer's min corner (world); the rooms object stands at the layer's place, so its frame is the layer's. */
const LAYER_AT = [210, -1, -28] as const;

/** The reads (world, 0.8 m inside the front walls): R's floor lit by the lamp, L's floor across the wall from it, L's floor out of its range. */
export const ROOM_LIGHT_READS = {
  lit: [212.5, 0.02, -20.8] as V3,
  across: [213.6, 0.02, -20.8] as V3,
  off: [215.2, 0.02, -20.8] as V3,
} as const;

/** The cubes' side (m), the floor's height (world) they stand on, and their feet (world): in L across the wall from the lamp, far in R. */
const CUBE = 0.5;
const FLOOR_Y = 0.02;
const CUBES = { across: [214.1, FLOOR_Y, -20.75], far: [210.6, FLOOR_Y, -21.9] } as const;
/** The reads on the L cube: its face toward −x (toward the lamp; the camera, far to the left, sees it) and its face toward the camera (+z). */
export const CUBE_READS = {
  toLamp: [CUBES.across[0] - CUBE / 2, FLOOR_Y + CUBE / 2, CUBES.across[2]] as V3,
  front: [CUBES.across[0], FLOOR_Y + CUBE / 2, CUBES.across[2] + CUBE / 2] as V3,
} as const;

const box = (x0: number, z0: number, x1: number, z1: number): number[][] => [
  [x0, 1, z0],
  [x1, 1, z0],
  [x1, 1, z1],
  [x0, 1, z1],
];

/** Make the rooms, the door piece, the box in C, the lamp in R and the cubes (`publishModel` publishes a model asset). */
export async function makeLitRooms(cmd: Cmd, trimId: string, publishModel: (bytes: Uint8Array, assetId: string) => Promise<void>): Promise<void> {
  await publishModel(new Uint8Array(multiPieceGlb([{ name: 'cube', lods: [[CUBE, CUBE, CUBE]], colors: [[0.6, 0.6, 0.6]], vertexColor: [1, 1, 1, 1] }], { centred: true })), 'e2e-lit-cube');
  // A kit copy at a foot (world), as the rooms object's element (its frame is the layer's).
  const cube = (id: string, foot: readonly number[]): Record<string, unknown> => {
    const [x, y, z] = [foot[0]! - LAYER_AT[0], foot[1]! - LAYER_AT[1], foot[2]! - LAYER_AT[2]];
    return { id, kind: 'repeat', path: { points: [[x, y, z], [x + 1, y, z]] }, spacing: 100, piece: { model: { assetId: 'e2e-lit-cube' } } };
  };
  await cmd('setBlockType', { block: { blockId: 'e2e-lit-ground', name: 'Lit ground', variants: [{ color: '#303030' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'e2e-lit-door', name: 'Lit door', variants: [{ color: '#6b4a2b' }], shape: 'full', placement: 'edge' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Lit floor', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [7, 4, 9] } } });
  // The floor's cells, and the closed door on the cell edges across the doorway's foot (the line z = 4, column x 1, rows 1–2).
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 7, 1, 9], cell: { block: 'e2e-lit-ground' } }, { kind: 'edges', at: [1, 1, 4, 1, 1, 2, 4, 1], edge: { block: 'e2e-lit-door' } }] });
  const rooms = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Lit rooms', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', {
    entityId: rooms,
    component: 'architecture',
    value: {
      elements: [],
      layer,
      outlines: [
        // R (x 0–3): an arch in its front wall (the third side, from (3, 8) back to (0, 8): 8.5 m along is x 1.5), the door into C in its back wall (1.5 m along: x 1.5).
        { id: 'lit-r', preset: 'starter-room', path: { points: box(0, 4, 3, 8), closed: true }, openings: [{ id: 'arch', at: 8.5, width: 2.4, bottom: 0, top: 2.4 }, { id: 'door', at: 1.5, width: 1, bottom: 0, top: 2.1 }] },
        // L (x 3–6): an arch from the shared wall nearly to its far side (8.5 m along: x 4.5).
        { id: 'lit-l', preset: 'starter-room', path: { points: box(3, 4, 6, 8), closed: true }, openings: [{ id: 'arch', at: 8.5, width: 2.8, bottom: 0, top: 2.4 }] },
        { id: 'lit-c', preset: 'starter-room', path: { points: box(0, 0, 3, 4), closed: true } },
      ],
    },
  });
  await cmd('setComponent', { entityId: rooms, component: 'materials', value: { '*': trimId } });
  // The cubes: an object of their own, so they wear their model's grey (the rooms' `*` would put the trim sheet on them).
  const furniture = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Lit furniture', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: furniture, component: 'architecture', value: { elements: Object.entries(CUBES).map(([id, foot]) => cube(`cube-${id}`, foot)) } });
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Box in C', box: { size: [0.6, 0.6, 0.6], material: { color: '#40ff40' } }, transform: { position: [LAYER_AT[0] + 1.5, 0.3, LAYER_AT[2] + 2] } });
  // Low by the shared wall, near the arches (the floor reads are 1.2 m from it across the wall, 2.6 m off).
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Lamp in R', transform: { position: [LAYER_AT[0] + 2.75, 0.8, LAYER_AT[2] + 7] }, components: { light: { type: 'point', color: '#ffffff', intensity: 15, range: 2, decay: 2 } } });
}

/** Brightness (the channels' sum) of each read, and whether the lamp lights R and not L through the wall, neither L's floor nor its cube. */
export function judgeLitRooms(read: (p: V3) => readonly number[]): { lum: Record<keyof typeof ROOM_LIGHT_READS | 'cubeToLamp' | 'cubeFront', number>; ok: boolean } {
  const sum = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!;
  const lum = { lit: sum(read(ROOM_LIGHT_READS.lit)), across: sum(read(ROOM_LIGHT_READS.across)), off: sum(read(ROOM_LIGHT_READS.off)), cubeToLamp: sum(read(CUBE_READS.toLamp)), cubeFront: sum(read(CUBE_READS.front)) };
  // The sun reaches the cube's front a little more than its side (0.36 against 0.27 of its light); the lamp would light the side four times over.
  return { lum, ok: lum.off > 20 && lum.lit > lum.off * 1.5 && lum.across < lum.off * 1.1 && lum.cubeFront > 20 && lum.cubeToLamp < lum.cubeFront * 1.1 };
}

/** Play's room diagnostics show C not seen and its box not drawn, one door closed. */
export function expectCulled(rooms: { rooms?: number; seen?: number; hidden?: number; doorsClosed?: number } | undefined): void {
  expect(rooms, 'the rooms in Play\'s diagnostics').toBeDefined();
  expect(rooms!.doorsClosed).toBe(1);
  expect(rooms!.seen!).toBeLessThan(rooms!.rooms!);
  expect(rooms!.hidden!).toBeGreaterThan(0);
}

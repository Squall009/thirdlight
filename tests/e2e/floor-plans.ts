/**
 * A building split into rooms by a room program and furnished by a
 * furnishing set, in the real editor (shared by the layered-material spec,
 * whose trim sheet, export and building script it is read with).
 *
 * A one-storey 10 × 8 m building without a roof on a floor of cells far
 * right of the main camera's view, its inside the house preset (walls'
 * tops magenta, floor red). The program (test data): a hall the front door
 * opens into, wired to two rooms. The set (test data): two grey cabinets
 * (1.2 × 0.5 m, 1.2 m tall) against walls in every room, one light per
 * room. The building inspector picks the program and the set, pins a prop,
 * lays the rooms out again from a new seed (the pinned prop stays where it
 * was, the others move) and unpins it, locks the plan (its three rooms
 * stored, the props the same) and unlocks it.
 *
 * Play and the export: a key loads a scene whose camera looks straight down
 * on the building. The reads come from the same generator the game runs
 * (the stored component and graphs expanded here): each prop's top is grey,
 * the floor just in front of it is red (it faces the room, its depth along
 * its facing), the floor in front of each door between rooms is red on both
 * sides (the clearance), and each partition's top is magenta.
 */
import { architectureStylesOf, expandArchitecture, facingDir, type ArchitectureComponent, type FurnishedProp } from '@thirdlight/project-model';

import { expect, type Page } from './pw';
import { multiPieceGlb } from './multi-piece-glb';
import { inspector } from './ui';
import { ENTER_KEY } from './buildings';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Query = (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type V3 = readonly [number, number, number];

/** The floor layer's min corner (world); the building's object stands at the layer's place (its frame is the layer's). */
const LAYER_AT = [399, -1, -9] as const;
/** The key that loads the plans scene (its camera looks down on the building). */
export const PLANS_KEY = 'KeyN';
/** The camera over the building, looking straight down (its up is −z), and its lens. */
export const PLANS_CAMERA = { at: [405, 14, -4] as V3, fovY: 50 } as const;

const PROGRAM = {
  nodes: [
    { id: 'program', type: 'program', position: [0, 0], data: { entrance: 'hall', filler: 'hall', minSide: 2.4 } },
    { id: 'hall', type: 'room', position: [240, 0], data: { type: 'hall', area: 1 } },
    { id: 'a', type: 'room', position: [480, -80], data: { type: 'room-a', area: 1.5 } },
    { id: 'b', type: 'room', position: [480, 80], data: { type: 'room-b', area: 1.2 } },
  ],
  edges: [
    { id: 'e1', from: { node: 'hall', port: 'door' }, to: { node: 'a', port: 'doors' } },
    { id: 'e2', from: { node: 'hall', port: 'door' }, to: { node: 'b', port: 'doors' } },
  ],
};
const FURNISHING = {
  nodes: [
    { id: 'furnishing', type: 'furnishing', position: [0, 0], data: { doorClearance: 1, pathWidth: 0.8, lights: 3 } },
    { id: 'cabinet', type: 'prop', position: [240, 0], data: { model: 'e2e-cabinet', place: 'wall', width: 1.2, depth: 0.5, height: 1.2, count: 2 } },
    { id: 'lamp', type: 'light', position: [240, 150], data: { intensity: 1, range: 5, height: 2.4 } },
  ],
  edges: [],
};

/** Loads the plans scene when the key is pressed. */
const PLANS_SCRIPT = (scene: string): string =>
  [
    'export default {',
    '  instantiate() { return { shown: false }; },',
    '  step(state, ctx) {',
    "    if (ctx.phase !== 'intent' || state.shown || !ctx.input.pressed('showPlans')) return;",
    `    ctx.scenes.load('${scene}');`,
    '    state.shown = true;',
    '  },',
    '};',
  ].join('\n');

export interface FloorPlanSetup {
  roomsId: string;
  plansScene: string;
  /** The editor's measures: props before and after the new seed, the pinned one's place kept. */
  editor: { props: number; moved: number; pinnedKept: boolean };
}

type Building = { id: string; program?: string; furnishing?: string; layoutSeed?: number; pins?: { id: string; position: number[] }[] };

export async function makeFloorPlans(page: Page, cmd: Cmd, query: Query, publishModel: (bytes: Uint8Array, assetId: string) => Promise<void>, publish: (name: string, source: string, entityId: string) => Promise<void>): Promise<FloorPlanSetup> {
  // A grey cabinet, its pivot at its base's middle (its front +Z), and the program and set.
  await publishModel(new Uint8Array(multiPieceGlb([{ name: 'cabinet', lods: [[1.2, 1.2, 0.5]], colors: [[0.55, 0.55, 0.55]], vertexColor: [1, 1, 1, 1] }], { centred: true })), 'e2e-cabinet');
  await cmd('setGraph', { graph: { graphId: 'e2e-program', kind: 'room-program', name: 'Test program', graph: PROGRAM } });
  await cmd('setGraph', { graph: { graphId: 'e2e-furnishing', kind: 'furnishing-set', name: 'Test furnishing', graph: FURNISHING } });
  await cmd('setBlockType', { block: { blockId: 'e2e-plan-ground', name: 'Plan ground', variants: [{ color: '#303030' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Plan floor', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [12, 4, 10] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 1, 10], cell: { block: 'e2e-plan-ground' } }] });
  // The building's footprint (layer cells, on the cells' tops): x 400–410, z −8–0 in the world; its front door on its first wall.
  const footprint = [[1, 1, 1], [11, 1, 1], [11, 1, 9], [1, 1, 9]];
  const roomsId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Plan house', transform: { position: [...LAYER_AT] } }))['createdId']);
  // The trim material is the house presets' own sheet.
  await cmd('setComponent', { entityId: roomsId, component: 'architecture', value: { elements: [], layer, buildings: [{ id: 'plan-house', path: { points: footprint, closed: true }, preset: 'e2e-house-in', openings: [{ id: 'front', at: 5, width: 1, bottom: 0, top: 2.1 }] }] } });
  const house = async (): Promise<Building | undefined> => {
    const e = (await query('queryEntity', { entityId: roomsId }))['entity'] as { components: { architecture: { buildings: Building[] } } };
    return e.components.architecture.buildings[0];
  };

  // ---- The editor: the layer's Rooms tool, the building inspector.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`).click();
  const blocks = inspector(page).getByLabel('blocks panel');
  await expect(blocks).toBeVisible();
  await blocks.getByRole('toolbar', { name: 'block tools' }).getByRole('button', { name: 'Rooms', exact: true }).click();
  const rooms = blocks.getByLabel('rooms panel');
  await rooms.getByLabel('building plan-house', { exact: true }).click();
  const panel = rooms.getByLabel('building plan-house floor plan');
  await expect(panel).toBeVisible();
  await panel.getByLabel('room program', { exact: true }).selectOption('e2e-program');
  await expect.poll(async () => (await house())?.program, { timeout: 15_000 }).toBe('e2e-program');
  await panel.getByLabel('furnishing set', { exact: true }).selectOption('e2e-furnishing');
  await expect.poll(async () => (await house())?.furnishing, { timeout: 15_000 }).toBe('e2e-furnishing');
  // The props the page made: a row each (id, its place in the title).
  const list = panel.getByLabel('props', { exact: true });
  const places = async (): Promise<Map<string, string>> => {
    const rows = list.locator('[aria-label^="prop "]');
    const out = new Map<string, string>();
    for (let i = 0; i < (await rows.count()); i++) {
      const id = (await rows.nth(i).getAttribute('aria-label'))!.slice('prop '.length);
      out.set(id, (await rows.nth(i).locator('span').getAttribute('title')) ?? '');
    }
    return out;
  };
  await expect.poll(async () => (await places()).size, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  const before = await places();
  const pinId = [...before.keys()][0]!;
  await panel.getByLabel(`pin ${pinId}`, { exact: true }).click();
  await expect.poll(async () => (await house())?.pins?.map((x) => x.id), { timeout: 15_000 }).toEqual([pinId]);
  const pinned = (await house())!.pins![0]!.position;
  // A new layout: the seed moves on, the pinned prop stays, the others are placed again.
  await panel.getByRole('button', { name: 'New layout' }).click();
  await expect.poll(async () => (await house())?.layoutSeed, { timeout: 15_000 }).toBe(1);
  await expect(panel.getByLabel(`unpin ${pinId}`, { exact: true })).toBeVisible();
  let after = await places();
  await expect.poll(async () => [...(after = await places()).entries()].filter(([id, at]) => id !== pinId && before.get(id) !== at).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const pinnedKept = after.get(pinId) === before.get(pinId) && JSON.stringify((await house())!.pins![0]!.position) === JSON.stringify(pinned);
  const moved = [...after.entries()].filter(([id, at]) => id !== pinId && before.get(id) !== at).length;
  await panel.getByLabel(`unpin ${pinId}`, { exact: true }).click();
  await expect.poll(async () => (await house())?.pins, { timeout: 15_000 }).toBeUndefined();
  // Lock: the program's rooms stored as the building's (the same plan), then unlocked again.
  const stored = async (): Promise<number> => ((((await query('queryEntity', { entityId: roomsId }))['entity'] as { components: { architecture: { outlines?: { building?: string }[] } } }).components.architecture.outlines ?? []).filter((o) => o.building === 'plan-house').length);
  await panel.getByRole('button', { name: 'Lock plan' }).click();
  await expect.poll(stored, { timeout: 15_000 }).toBe(3);
  await expect.poll(async () => (await places()).size, { timeout: 15_000 }).toBe(after.size);
  await panel.getByRole('button', { name: 'Unlock plan' }).click();
  await expect.poll(stored, { timeout: 15_000 }).toBe(0);

  // ---- The plans scene: its camera (above every other) looks straight down; a key loads it.
  const plansScene = 'e2e-plans';
  await cmd('createScene', { sceneId: plansScene, name: 'Plans' });
  const down = Math.SQRT1_2;
  await cmd('createEntity', { sceneId: plansScene, parentId: null, kind: 'group', name: 'Plans camera', transform: { position: [...PLANS_CAMERA.at], rotation: [-down, 0, 0, down] }, components: { virtualCamera: { rig: 'fixed', priority: 20, blend: 'cut', fovY: PLANS_CAMERA.fovY, near: 0.5, far: 60 } } });
  await cmd('setInput', { input: { actions: [{ name: 'enterDoor', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: ENTER_KEY }] }, { name: 'showPlans', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: PLANS_KEY }] }] } });
  await publish('show-plans', PLANS_SCRIPT(plansScene), roomsId);
  return { roomsId, plansScene, editor: { props: before.size, moved, pinnedKept } };
}

/** A world point on a picture (`w` × `h`) of the plans camera (looking down, its up toward −z). */
export function onPlans(p: V3, w: number, h: number): { x: number; y: number } {
  const [ex, ey, ez] = PLANS_CAMERA.at;
  const depth = ey - p[1];
  const t = Math.tan((PLANS_CAMERA.fovY * Math.PI) / 360);
  return { x: ((p[0] - ex) / (depth * t * (w / h)) / 2 + 0.5) * w, y: ((p[2] - ez) / (depth * t) / 2 + 0.5) * h };
}

export interface PlanReads {
  props: { id: string; top: V3; front: V3 }[];
  clearances: V3[];
  partitions: V3[];
  lights: number;
}

/** Where the plan is read (world points), from the stored component and graphs expanded with the game's generator. */
export async function planReads(query: Query, roomsId: string): Promise<PlanReads> {
  const e = (await query('queryEntity', { entityId: roomsId }))['entity'] as { components: { architecture: ArchitectureComponent; transform: { position: number[] } } };
  const graphs = ((await query('queryGameConfig'))['graphs'] ?? []) as { graphId: string; kind: string; graph: never }[];
  const o = e.components.transform.position;
  const x = expandArchitecture(e.components.architecture, o, architectureStylesOf(graphs));
  const w = (p: readonly number[]): V3 => [p[0]! + o[0]!, p[1]! + o[1]!, p[2]! + o[2]!];
  const props: FurnishedProp[] = [...(x.props ?? [])];
  const inProp = (q: FurnishedProp, px: number, pz: number, grow: number): boolean => {
    const [fx, fz] = facingDir(q.facing);
    const dx = px - q.position[0];
    const dz = pz - q.position[2];
    return Math.abs(dx * fz - dz * fx) <= q.size[0] / 2 + grow && Math.abs(dx * fx + dz * fz) <= q.size[1] / 2 + grow;
  };
  const reads: PlanReads = { props: [], clearances: [], partitions: [], lights: (x.lights ?? []).length };
  for (const p of props) {
    const [fx, fz] = facingDir(p.facing);
    const f: [number, number] = [p.position[0] + fx * (p.size[1] / 2 + 0.25), p.position[2] + fz * (p.size[1] / 2 + 0.25)];
    if (props.some((q) => q !== p && inProp(q, f[0], f[1], 0.1))) continue;
    reads.props.push({ id: p.id, top: w([p.position[0], p.position[1] + 1.2, p.position[2]]), front: w([f[0], p.position[1], f[1]]) });
  }
  // Doors between rooms (both ends inside the footprint) and the walls between rooms (sides inside it).
  const inside = (px: number, pz: number): boolean => px > 1.05 && px < 10.95 && pz > 1.05 && pz < 8.95;
  for (const r of x.rooms) {
    for (const d of r.openings) {
      const mx = (d.from[0] + d.to[0]) / 2;
      const mz = (d.from[1] + d.to[1]) / 2;
      if (!inside(mx, mz)) continue;
      const along = Math.abs(d.to[0] - d.from[0]) > Math.abs(d.to[1] - d.from[1]);
      for (const s of [-0.6, 0.6]) reads.clearances.push(w([along ? mx : mx + s, r.floor + 0.01, along ? mz + s : mz]));
    }
    const n = r.points.length;
    for (let i = 0; i < n; i++) {
      const [ax, az] = r.points[i]!;
      const [bx, bz] = r.points[(i + 1) % n]!;
      const [mx, mz] = [(ax + bx) / 2, (az + bz) / 2];
      if (!inside(mx, mz)) continue;
      // A point on the wall away from its doors.
      const len = Math.hypot(bx - ax, bz - az);
      for (let t = 0.3; t < len - 0.3; t += 0.2) {
        const [px, pz] = [ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len];
        const nearDoor = x.rooms.some((q) => q.openings.some((d) => Math.hypot((d.from[0] + d.to[0]) / 2 - px, (d.from[1] + d.to[1]) / 2 - pz) < 1));
        if (nearDoor) continue;
        reads.partitions.push(w([px, r.top, pz]));
        break;
      }
    }
  }
  return reads;
}

const grey = (c: readonly number[]): boolean => c[0]! + c[1]! + c[2]! > 60 && Math.max(...c) < Math.min(...c) * 1.35;

/** The plan's colours in a picture of the plans camera and whether each is what the generator placed there. */
export function judgePlans(reads: PlanReads, read: (p: V3) => readonly number[], rowHue: (slot: string, c: readonly number[]) => boolean): { ok: boolean; bad: string[] } {
  const bad: string[] = [];
  const fmt = (c: readonly number[]): string => c.map((v) => v.toFixed(0)).join(',');
  for (const p of reads.props) {
    const top = read(p.top);
    if (!grey(top)) bad.push(`prop ${p.id} top ${fmt(top)}`);
    const front = read(p.front);
    if (!rowHue('floor', front)) bad.push(`prop ${p.id} front ${fmt(front)}`);
  }
  for (const c of reads.clearances) {
    const v = read(c);
    if (!rowHue('floor', v)) bad.push(`clearance ${c.map((k) => k.toFixed(1)).join(',')} ${fmt(v)}`);
  }
  for (const c of reads.partitions) {
    const v = read(c);
    if (!rowHue('lower_wall', v)) bad.push(`partition ${c.map((k) => k.toFixed(1)).join(',')} ${fmt(v)}`);
  }
  const ok = bad.length === 0 && reads.props.length >= 3 && reads.clearances.length >= 4 && reads.partitions.length >= 2;
  return { ok, bad };
}

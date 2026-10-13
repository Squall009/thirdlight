/**
 * Rooms and paths drawn in the block editor's Rooms & buildings mode in the real editor
 * (shared by the layered-material spec, whose trim sheet, fixed Play camera
 * and export the rooms are read with).
 *
 * A floor of cells (its layer with wall paint on) far left of the camera's
 * view; two rooms drawn on it with the Rectangle mode, the front one with
 * its inside rows blue (crown), the back one green (baseboard), outside
 * magenta (lower_wall); an arch in the front room's front wall and a door
 * in the wall the rooms share, lined up so the camera looks through both
 * into the back room; a fence path (posts and a rail, blue) drawn with the
 * Path mode in front of them, below the sight lines. The picked room's column edits the door; Move
 * walls drags the back room's back wall three cells in and back two (the Scene view
 * regenerates only that room's chunks while dragging), then the front room's east wall a cell in and the
 * wall the rooms share (now only partly) a cell back and both back again: the openings on the other
 * walls stay where they stood and the shared wall moves with the front room's. Kit pieces: a kit holding
 * the Basic Kit's door and window (set up by command) is picked for the rooms; Door and Window put its
 * pieces (picked in the column, the holes sized to them) in the back room's west wall, Wall piece puts
 * the window on a segment of the front room's west wall (out of the Play camera's reads); a third room with a
 * wall piece is deleted, its piece with it. The block
 * editor's Paint mode paints grime (paint layer 3) on the front wall's outer face.
 * Draw-to-visible and the drag's regeneration are timed from the marks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from './pw';

import { editMode, editModeTab, enterBlockEditor, leaveEditMode } from './ui';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Query = (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type V3 = readonly [number, number, number];

/** The floor layer's min corner (world); the rooms object is made at the layer's place, so its frame is the layer's. */
const LAYER_AT = [182, -1, -42] as const;

/** A room style: one wall swept on the outline (shared with a neighbour, cut by openings), its inside one row, outside another. */
function roomStyle(inside: string): Record<string, unknown> {
  return {
    nodes: [
      { id: 'outline', type: 'outline', position: [0, 0] },
      { id: 'wall', type: 'wall', position: [260, 0], data: { thickness: 0.2, height: 3, dado: 0, inside, outside: 'lower_wall', top: 'lower_wall', lower: inside } },
      { id: 'walls', type: 'sweep', position: [520, 0], data: { wall: true, openings: true } },
      { id: 'output', type: 'output', position: [780, 0] },
    ],
    edges: [
      { id: 'e1', from: { node: 'outline', port: 'path' }, to: { node: 'walls', port: 'path' } },
      { id: 'e2', from: { node: 'wall', port: 'profile' }, to: { node: 'walls', port: 'profile' } },
      { id: 'e3', from: { node: 'walls', port: 'element' }, to: { node: 'output', port: 'elements' } },
    ],
  };
}

/** A fence: 0.2 m posts every 2 m and a rail 1 m up, all blue (crown). */
const FENCE_STYLE = {
  nodes: [
    { id: 'outline', type: 'outline', position: [0, 0] },
    { id: 'square', type: 'square', position: [260, 0], data: { size: 0.2 } },
    { id: 'shaft', type: 'shaft', position: [260, 150], data: { height: 1.2, slot: 'crown' } },
    { id: 'post', type: 'sweep', position: [520, 0] },
    { id: 'posts', type: 'repeat', position: [780, 0], data: { spacing: 2 } },
    { id: 'raised', type: 'raise', position: [260, 300], data: { height: 1 } },
    { id: 'railProfile', type: 'wall', position: [260, 450], data: { thickness: 0.1, height: 0.1, inside: 'crown', outside: 'crown', top: 'crown', lower: 'crown' } },
    { id: 'rail', type: 'sweep', position: [520, 300] },
    { id: 'output', type: 'output', position: [1040, 0] },
  ],
  edges: [
    { id: 'e1', from: { node: 'square', port: 'path' }, to: { node: 'post', port: 'path' } },
    { id: 'e2', from: { node: 'shaft', port: 'profile' }, to: { node: 'post', port: 'profile' } },
    { id: 'e3', from: { node: 'outline', port: 'path' }, to: { node: 'posts', port: 'path' } },
    { id: 'e4', from: { node: 'post', port: 'element' }, to: { node: 'posts', port: 'piece' } },
    { id: 'e5', from: { node: 'outline', port: 'path' }, to: { node: 'raised', port: 'path' } },
    { id: 'e6', from: { node: 'raised', port: 'path' }, to: { node: 'rail', port: 'path' } },
    { id: 'e7', from: { node: 'railProfile', port: 'profile' }, to: { node: 'rail', port: 'profile' } },
    { id: 'e8', from: { node: 'posts', port: 'element' }, to: { node: 'output', port: 'elements' } },
    { id: 'e9', from: { node: 'rail', port: 'element' }, to: { node: 'output', port: 'elements' } },
  ],
};

const preset = (style: string, sheet: string): Record<string, unknown> => ({ nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style, base: '', sheet } }], edges: [] });

/**
 * Where the rooms are read in a picture of the fixed camera (world points)
 * and the row each shows: the front wall's outer face, the grime painted on
 * it, the shared wall's front-room face seen through the arch, the back
 * room seen through the door in it, and a fence post.
 */
export const ROOM_READS = {
  front: { at: [187, 2.5, -33.89] as V3, slot: 'lower_wall' },
  grime: { at: [184.5, 2.6, -33.89] as V3, slot: 'lower_wall' },
  shared: { at: [189.6, 1.8, -37.89] as V3, slot: 'crown' },
  door: { at: [188.5, 1.8, -38] as V3, slot: 'baseboard' },
  post: { at: [191, 0.6, -29.89] as V3, slot: 'crown' },
} as const;

export interface RoomsTimings {
  /** Pointer up on the first room → its object drawn (ms). */
  drawToVisible: number;
  /** The wall drag: regenerations seen, and input → drawn per step (median, worst; ms), objects made again besides. */
  drag: { regenerations: number; median: number; worst: number; others: number; madeMedian: number };
}

const view = (page: Page): Locator => page.locator('.tl-viewport');

/** World → client pixels through the Scene view's view-projection matrix (null: behind the camera). */
export async function screen(page: Page, p: V3): Promise<{ x: number; y: number } | null> {
  const m = JSON.parse((await view(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await view(page).boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (w <= 0) return null;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}

/** Zoom the Scene view (wheel over its middle) until every point is on screen with a margin, as close as that allows. */
export async function frameOn(page: Page, points: readonly V3[]): Promise<void> {
  const box = (await view(page).boundingBox())!;
  const fits = async (): Promise<boolean> => {
    for (const p of points) {
      const s = await screen(page, p);
      if (s === null || s.x < box.x + 40 || s.x > box.x + box.width - 40 || s.y < box.y + 40 || s.y > box.y + box.height - 40) return false;
    }
    return true;
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60 && !(await fits()); i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
  }
  expect(await fits()).toBe(true);
  for (let i = 0; i < 30 && (await fits()); i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(60);
  }
  for (let i = 0; i < 10 && !(await fits()); i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(60);
  }
  expect(await fits()).toBe(true);
}

/** Hover a world point on the floor and wait until the Rooms tool snaps to `corner` (the rooms' frame). */
export async function aimCorner(page: Page, p: V3, corner: V3): Promise<{ x: number; y: number }> {
  const s = (await screen(page, p))!;
  await page.mouse.move(s.x - 2, s.y - 2);
  await page.mouse.move(s.x, s.y);
  await expect(view(page)).toHaveAttribute('data-room-hover', corner.join(','));
  return s;
}

/** The layer's corner (cell lines) at world (x, z) on the floor: the rooms' frame is the layer's. */
const corner = (x: number, z: number): V3 => [x - LAYER_AT[0], 1, z - LAYER_AT[2]];

/** The engine's Basic Kit models (its door and window pieces), published into the project as they are. */
const BASIC_KIT_MODELS = join(import.meta.dirname, '../../packs/basic-kit/assets/models');

export async function drawRooms(page: Page, cmd: Cmd, query: Query, trimId: string, model: (bytes: Uint8Array, assetId: string) => Promise<void>): Promise<{ timings: RoomsTimings; roomsId: string }> {
  await cmd('setGraph', { graph: { graphId: 'e2e-room-a-style', kind: 'architecture-style', name: 'Room A', graph: roomStyle('crown') } });
  await cmd('setGraph', { graph: { graphId: 'e2e-room-b-style', kind: 'architecture-style', name: 'Room B', graph: roomStyle('baseboard') } });
  await cmd('setGraph', { graph: { graphId: 'e2e-fence-style', kind: 'architecture-style', name: 'Fence', graph: FENCE_STYLE } });
  await cmd('setGraph', { graph: { graphId: 'e2e-room-a', kind: 'architecture-preset', name: 'Room A', graph: preset('e2e-room-a-style', trimId) } });
  await cmd('setGraph', { graph: { graphId: 'e2e-room-b', kind: 'architecture-preset', name: 'Room B', graph: preset('e2e-room-b-style', trimId) } });
  await cmd('setGraph', { graph: { graphId: 'e2e-fence', kind: 'architecture-preset', name: 'Fence', graph: preset('e2e-fence-style', trimId) } });
  // The floor: a 10 × 8 cell layer one row deep, its top at y = 0, wall paint on.
  await cmd('setBlockType', { block: { blockId: 'e2e-ground', name: 'Ground', variants: [{ color: '#303030' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Room floor', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [10, 4, 8] }, wallPaint: true } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 10, 1, 8], cell: { block: 'e2e-ground' } }] });

  // ---- The block editor's Rooms & buildings mode on the slice's floor (row 1, the cells' top).
  await enterBlockEditor(page, layer);
  const blocks = editMode(page);
  // Home frames the layer (the view's direction kept), as F did on the selected layer before.
  await page.keyboard.press('Home');
  await editModeTab(page, 'Rooms & buildings');
  await blocks.getByLabel('slice level', { exact: true }).fill('1');
  await blocks.getByLabel('slice level', { exact: true }).press('Enter');
  const rooms = blocks.getByLabel('block rooms');
  await expect(rooms).toBeVisible();
  await frameOn(page, [[182, 0, -42], [193, 0, -42], [182, 0, -30], [193, 0, -30], [192, 3, -34]]);
  const tool = (name: string): Promise<void> => rooms.getByRole('toolbar', { name: 'room tool' }).getByRole('button', { name, exact: true }).click();
  type Opening = { id: string; at: number; top: number; bottom: number; width: number; model?: { assetId: string } };
  const roomsObject = async (): Promise<{ id: string; architecture: { kitId?: string; overrides?: { element: string; segment?: number; model: { assetId: string } }[]; outlines?: { id: string; preset: string; path: { points: number[][] }; openings?: Opening[] }[] } } | null> => {
    const ents = ((await query('queryEntities', { limit: 500, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
    const e = ents.find((x) => (x.components['architecture'] as { layer?: string } | undefined)?.layer === layer);
    return e === undefined ? null : { id: e.id, architecture: e.components['architecture'] as never };
  };
  const readyAfter = async (since: number, object: string | null): Promise<{ object: string; at: number; ms: number }[]> =>
    page.evaluate(
      ([t, id]) =>
        (performance.getEntriesByType('mark') as PerformanceMark[])
          .filter((m) => m.name === 'tl:arch:ready' && m.startTime > (t as number) && (id === null || (m.detail as { object: string }).object === id))
          .map((m) => ({ object: (m.detail as { object: string }).object, at: m.startTime, ms: (m.detail as { ms: number }).ms })),
      [since, object] as const,
    );

  // Room A (front): Rectangle from corner to corner; the release stores one command that makes the rooms object.
  await rooms.getByLabel('new room preset').selectOption('e2e-room-a');
  const a0 = await aimCorner(page, [182, 0, -38], corner(182, -38));
  await page.mouse.down();
  await page.mouse.move(a0.x + 5, a0.y + 5, { steps: 2 });
  const a1 = (await screen(page, [192, 0, -34]))!;
  await page.mouse.move(a1.x, a1.y, { steps: 6 });
  await expect(view(page)).toHaveAttribute('data-room-hover', corner(192, -34).join(','));
  const up = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.length ?? 0, { timeout: 15_000 }).toBe(1);
  const roomsId = (await roomsObject())!.id;
  await expect.poll(async () => (await readyAfter(up, roomsId)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const drawToVisible = (await readyAfter(up, roomsId))[0]!.at - up;

  // Room B (behind it, sharing its back wall), then the arch, the door on the shared wall and the fence.
  await rooms.getByLabel('new room preset').selectOption('e2e-room-b');
  const b0 = await aimCorner(page, [182, 0, -42], corner(182, -42));
  await page.mouse.down();
  await page.mouse.move(b0.x + 5, b0.y + 5, { steps: 2 });
  const b1 = (await screen(page, [192, 0, -38]))!;
  await page.mouse.move(b1.x, b1.y, { steps: 6 });
  await expect(view(page)).toHaveAttribute('data-room-hover', corner(192, -38).join(','));
  await page.mouse.up();
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.map((o) => `${o.id}:${o.preset}`), { timeout: 15_000 }).toEqual(['room-1:e2e-room-a', 'room-2:e2e-room-b']);
  // Presets in use: Room A swapped for Room B on every room (the outlines kept), one undo takes it back.
  const swap = rooms.getByLabel('swap presets');
  await swap.getByLabel('rooms wearing').selectOption('e2e-room-a');
  await swap.getByLabel('wear instead').selectOption('e2e-room-b');
  const pointsBefore = JSON.stringify((await roomsObject())?.architecture.outlines?.map((o) => o.path.points));
  await swap.getByRole('button', { name: 'Swap on 1 outline' }).click();
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.map((o) => `${o.id}:${o.preset}`), { timeout: 15_000 }).toEqual(['room-1:e2e-room-b', 'room-2:e2e-room-b']);
  expect(JSON.stringify((await roomsObject())?.architecture.outlines?.map((o) => o.path.points))).toBe(pointsBefore);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.map((o) => `${o.id}:${o.preset}`), { timeout: 15_000 }).toEqual(['room-1:e2e-room-a', 'room-2:e2e-room-b']);
  await tool('Arch');
  const arch = (await screen(page, [190, 0, -34]))!;
  await page.mouse.click(arch.x, arch.y);
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.[0]?.openings?.map((o) => o.id), { timeout: 15_000 }).toEqual(['arch-1']);
  await tool('Door');
  const door = (await screen(page, [188.5, 0, -38]))!;
  await page.mouse.click(door.x, door.y);
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.[0]?.openings?.map((o) => o.id), { timeout: 15_000 }).toEqual(['arch-1', 'door-1']);

  // The picked room's column: its openings; the door's head edited there (stored).
  await expect(rooms.getByLabel('room room-1 inspector')).toBeVisible();
  await expect(rooms.getByLabel('opening door-1')).toBeVisible();
  await rooms.getByLabel('door-1 head').fill('2.2');
  await rooms.getByLabel('door-1 head').press('Enter');
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.[0]?.openings?.find((o) => o.id === 'door-1')?.top, { timeout: 15_000 }).toBe(2.2);

  // The fence: Path mode, two clicks in front of the rooms, below the camera's sight lines through the arch (a double click ends it).
  await tool('Path');
  await rooms.getByLabel('new path preset').selectOption('e2e-fence');
  const f0 = await aimCorner(page, [189, 0, -30], corner(189, -30));
  await page.mouse.click(f0.x, f0.y);
  const f1 = await aimCorner(page, [193, 0, -30], corner(193, -30));
  await page.mouse.dblclick(f1.x, f1.y);
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.map((o) => o.id), { timeout: 15_000 }).toEqual(['room-1', 'room-2', 'run-1']);
  await expect(rooms.getByLabel('room run-1', { exact: true })).toBeVisible();

  // Move walls: drag the back room's back wall a cell in; the Scene view makes only that object again while dragging.
  await tool('Move walls');
  // Three cells in and back two (five steps of the wall), released a cell in.
  const along = async (z: number): Promise<{ x: number; y: number }> => (await screen(page, [187, 0, z]))!;
  const w0 = await along(-42);
  const path = [-41.6, -41.2, -40.8, -40.4, -40, -39.6, -39.2, -39.6, -40, -40.4, -40.8];
  const t0 = await page.evaluate(() => {
    const w = window as unknown as { __tlRoomInputs: number[] };
    w.__tlRoomInputs = [];
    document.addEventListener('pointermove', () => w.__tlRoomInputs.push(performance.now()), true);
    return performance.now();
  });
  await page.mouse.move(w0.x, w0.y);
  await page.mouse.down();
  for (const z of path) {
    const p = await along(z);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.[1]?.path.points.some((p) => p[2] === 1), { timeout: 15_000 }).toBe(true);
  const drag = await page.evaluate((since) => {
    const inputs = (window as unknown as { __tlRoomInputs: number[] }).__tlRoomInputs;
    const marks = (performance.getEntriesByType('mark') as PerformanceMark[]).filter((m) => m.startTime > since);
    return {
      ready: marks.filter((m) => m.name === 'tl:arch:ready').map((m) => ({ object: (m.detail as { object: string }).object, fromInput: m.startTime - (inputs.filter((t) => t <= m.startTime).pop() ?? since) })),
      chunks: marks.filter((m) => m.name === 'tl:arch:chunk').map((m) => (m.detail as { ms: number }).ms),
    };
  }, t0);
  const mine = drag.ready.filter((r) => r.object === roomsId).map((r) => r.fromInput).sort((x, y) => x - y);
  const med = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? NaN;
  expect(mine.length).toBeGreaterThan(0);

  // Openings stay on their own walls: the front room's east wall dragged a cell in shortens the sides before the
  // arch's wall (its distance round the room changes); the arch stays where it stood, as does the door on the shared wall.
  const dragWall = async (from: V3, to: V3): Promise<void> => {
    // The tool picks walls from the editor's copy of the outlines: it must have the last drag's command first (the
    // poll before reads the backend's), or the drag starts on a wall that is not where it was drawn.
    const want = Number((await query('queryProject')).revision);
    await expect(page.locator('.tl-statusbar__rev')).toHaveText(`revision ${want}`, { timeout: 15_000 });
    const a = (await screen(page, from))!;
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let k = 1; k <= 4; k++) {
      const p = (await screen(page, [from[0] + ((to[0] - from[0]) * k) / 4, 0, from[2] + ((to[2] - from[2]) * k) / 4]))!;
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(80);
    }
    await page.mouse.up();
  };
  const stored = await roomsObject();
  /** Where the front room's openings stand (world x, z): `at` walked round its straight sides. */
  const openingsAt = async (): Promise<Record<string, [number, number]>> => {
    const o = (await roomsObject())!.architecture.outlines!.find((x) => x.id === 'room-1')!;
    const pts = o.path.points;
    const out: Record<string, [number, number]> = {};
    for (const op of o.openings ?? []) {
      let d = op.at;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const len = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
        if (d <= len) {
          out[op.id] = [LAYER_AT[0] + a[0]! + ((b[0]! - a[0]!) * d) / len, LAYER_AT[2] + a[2]! + ((b[2]! - a[2]!) * d) / len];
          break;
        }
        d -= len;
      }
    }
    return out;
  };
  const before = await openingsAt();
  expect(before).toEqual({ 'arch-1': [190, -34], 'door-1': [188.5, -38] });
  await dragWall([192, 0, -36], [191, 0, -36]);
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.[0]?.path.points.filter((p) => p[0] === 9).length, { timeout: 15_000 }).toBe(2);
  expect(await openingsAt()).toEqual(before);
  // The shared wall, now longer on the back room's side (x 182–192 against 182–191), still moves with the front room's;
  // the door goes with its wall, the arch stays.
  await dragWall([186, 0, -38], [186, 0, -39]);
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.slice(0, 2).map((o) => o.path.points.filter((p) => p[2] === 3).length), { timeout: 15_000 }).toEqual([2, 2]);
  expect(await openingsAt()).toEqual({ 'arch-1': [190, -34], 'door-1': [188.5, -39] });
  // Both dragged back: the rooms as they were stored.
  await dragWall([186, 0, -39], [186, 0, -38]);
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.[1]?.path.points.filter((p) => p[2] === 4).length, { timeout: 15_000 }).toBe(2);
  await dragWall([191, 0, -36], [192, 0, -36]);
  await expect.poll(async () => JSON.stringify((await roomsObject())?.architecture.outlines), { timeout: 15_000 }).toBe(JSON.stringify(stored?.architecture.outlines));

  // ---- Kit pieces. The kit (its pieces' files published, the kit itself set up by command): the door and window, the window again as a wall piece.
  for (const id of ['basic-door', 'basic-window']) await model(new Uint8Array(readFileSync(join(BASIC_KIT_MODELS, `${id}.glb`))), id);
  await cmd('setKit', { kit: { kitId: 'e2e-rooms-kit', name: 'Rooms kit', pieces: { door: [{ assetId: 'basic-door', piece: 'door' }], window: [{ assetId: 'basic-window', piece: 'window' }], 'wall-override': [{ assetId: 'basic-window', piece: 'window' }] } } });
  await rooms.getByLabel('rooms kit').selectOption('e2e-rooms-kit');
  await expect.poll(async () => (await roomsObject())?.architecture.kitId, { timeout: 15_000 }).toBe('e2e-rooms-kit');
  await rooms.getByLabel('door piece', { exact: true }).selectOption('basic-door#door');
  await rooms.getByLabel('window piece', { exact: true }).selectOption('basic-window#window');
  // The holes take the pieces' sizes once the kit's check read them: the door 1 × 2 m from the floor, the window 1 × 1 m from 1 m up.
  await expect(rooms.getByLabel('door hole')).toHaveText('Door hole: 1 cell wide, 0–2 m', { timeout: 15_000 });
  await expect(rooms.getByLabel('window hole')).toHaveText('Window hole: 1 cell wide, 1–2 m');
  const backRoom = async (): Promise<Opening[] | undefined> => (await roomsObject())?.architecture.outlines?.find((o) => o.id === 'room-2')?.openings;
  await tool('Door');
  const kd = (await screen(page, [182, 0, -40.5]))!;
  await page.mouse.click(kd.x, kd.y);
  await tool('Window');
  const kw = (await screen(page, [182, 0, -39.3]))!;
  await page.mouse.click(kw.x, kw.y);
  await expect
    .poll(async () => (await backRoom())?.map((o) => `${o.id}:${o.model?.assetId}:${o.width}:${o.bottom}-${o.top}`), { timeout: 15_000 })
    .toEqual(['door-1:basic-door:1:0-2', 'window-1:basic-window:1:1-2']);
  await expect(rooms.getByLabel('room room-2 inspector').getByLabel('window-1 piece')).toHaveValue('basic-window#window');
  // Wall piece: the front room's west wall (its segment lit under the pointer), one click.
  await rooms.getByLabel('wall piece', { exact: true }).selectOption('basic-window#window');
  await tool('Wall piece');
  const wp = (await screen(page, [182, 0, -36]))!;
  await page.mouse.move(wp.x - 3, wp.y);
  await page.mouse.move(wp.x, wp.y);
  await expect(view(page)).toHaveAttribute('data-room-spot', /^room-1-.*:seg\d$/);
  await page.mouse.click(wp.x, wp.y);
  await expect.poll(async () => (await roomsObject())?.architecture.overrides?.map((o) => `${o.element.startsWith('room-1-')}:${o.segment}:${o.model.assetId}`), { timeout: 15_000 }).toEqual([`true:${JSON.parse((await view(page).getAttribute('data-room-piece'))!).segment}:basic-window`]);
  await expect(rooms.getByLabel('room room-1 inspector').getByLabel('wall pieces').getByRole('listitem')).toHaveCount(1);
  // The view still orbits after the tool's clicks (a right drag turns it to the west walls; dragged back after).
  const shots = process.env['TL_SHOTS'];
  const box = (await view(page).boundingBox())!;
  const viewProj = async (): Promise<string | null> => view(page).getAttribute('data-view-proj');
  const viewBefore = await viewProj();
  const orbit = async (dx: number, dy: number): Promise<void> => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
    await page.mouse.up({ button: 'right' });
  };
  await orbit(-230, -40);
  await expect.poll(viewProj).not.toBe(viewBefore);
  if (shots !== undefined) {
    // Closer, for a picture: the west walls filling the view.
    await frameOn(page, [[182, 0, -42], [182, 3.2, -42], [182, 0, -34], [182, 3.2, -34]]);
    await page.screenshot({ path: `${shots}/rooms-kit-pieces.png` });
    await rooms.getByLabel('room room-2', { exact: true }).click();
    await rooms.getByLabel('room room-2 inspector').getByLabel('openings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/rooms-kit-column.png` });
  }
  await orbit(230, 40);
  if (shots === undefined) await expect.poll(viewProj).toBe(viewBefore);
  else await frameOn(page, [[182, 0, -42], [193, 0, -42], [182, 0, -30], [193, 0, -30], [192, 3, -34]]);

  // A room with a wall piece deletes cleanly: its pieces go with it (a piece naming a wall nothing makes is refused).
  // A small third room in front of the layer (by command: drawing is covered above), a wall piece on its west wall, Delete.
  const current = (await roomsObject())!.architecture;
  await cmd('setComponent', { entityId: roomsId, component: 'architecture', value: { ...current, outlines: [...(current.outlines ?? []), { id: 'room-3', preset: 'e2e-room-b', path: { points: [[2, 1, 9], [2, 1, 11], [0, 1, 11], [0, 1, 9]], closed: true } }] } });
  const synced = Number((await query('queryProject')).revision);
  await expect(page.locator('.tl-statusbar__rev')).toHaveText(`revision ${synced}`, { timeout: 15_000 });
  await tool('Wall piece');
  const w3 = (await screen(page, [182, 0, -32]))!;
  await page.mouse.move(w3.x - 3, w3.y);
  await page.mouse.move(w3.x, w3.y);
  await expect(view(page)).toHaveAttribute('data-room-spot', /^room-3-.*:seg\d$/);
  await page.mouse.click(w3.x, w3.y);
  await expect.poll(async () => (await roomsObject())?.architecture.overrides?.filter((o) => o.element.startsWith('room-3-')).length, { timeout: 15_000 }).toBe(1);
  await rooms.getByLabel('room room-3', { exact: true }).click();
  await rooms.getByLabel('delete room-3', { exact: true }).click();
  await expect.poll(async () => (await roomsObject())?.architecture.outlines?.map((o) => o.id), { timeout: 15_000 }).toEqual(['room-1', 'room-2', 'run-1']);
  expect((await roomsObject())?.architecture.overrides?.map((o) => o.element.startsWith('room-1-'))).toEqual([true]);
  await expect(rooms.getByLabel('room room-3', { exact: true })).toHaveCount(0);

  // Grime: the Paint mode, layer 3 on walls, one dab on the front wall's outer face.
  await editModeTab(page, 'Paint');
  await blocks.getByRole('radio', { name: 'paint layer 3', exact: true }).click();
  await blocks.getByRole('radiogroup', { name: 'paint target' }).getByRole('radio', { name: 'Walls', exact: true }).click();
  for (const [field, value] of [['brush size', '2'], ['brush strength', '100']] as const) {
    await blocks.getByLabel(field, { exact: true }).fill(value);
    await blocks.getByLabel(field, { exact: true }).press('Enter');
  }
  await blocks.getByRole('radiogroup', { name: 'brush falloff' }).getByRole('radio', { name: 'Constant' }).click();
  const dab = (await screen(page, [184.5, 2.4, -34]))!;
  await page.mouse.click(dab.x, dab.y);
  // Stored on the layer: the wall points of its chunk (the generated faces read them).
  await expect
    .poll(async () => (((await query('queryBlocks', { entityId: layer, chunks: [[0, 0]] })) as { chunks?: { chunk: { wallPaint?: string } | null }[] }).chunks ?? []).some((c) => (c.chunk?.wallPaint ?? '') !== ''), { timeout: 15_000 })
    .toBe(true);
  await leaveEditMode(page);
  return {
    roomsId,
    timings: { drawToVisible, drag: { regenerations: mine.length, median: med(mine), worst: Math.max(...mine), others: drag.ready.filter((r) => r.object !== roomsId).length, madeMedian: med(drag.chunks) } },
  };
}

/**
 * A building drawn with a block layer's Rooms tool (Building mode) in the
 * real editor, its interior a scene of its own (shared by the
 * layered-material spec, whose trim sheet, fixed Play camera and export it
 * is read with).
 *
 * A two-storey L-shaped building (wings 4 m wide, 10 m long) on a floor of
 * cells right of the camera's view: its inside preset's walls green
 * (baseboard) with a red floor, its facade blue (crown), a hip roof on the
 * red row. Drawn by clicking the footprint's six corners; a door and a
 * window on the ground storey and a window above it put on the front wall
 * with the Door and Window modes (the upper one from the slice a storey
 * up); the building inspector sets two 3 m storeys, the roof's rise and
 * slot, takes the panes out of the windows, makes a new interior scene and
 * moves the interior 100 m along x. A fixed camera in the interior scene
 * looks at the front wall from inside. A script loads the interior scene
 * through the door's link (`ctx.grid.doorLink`) when a key is pressed.
 *
 * Reads: outside, the facade between the window and the door is blue, the
 * windows show the green inner wall behind them, the roof is red; inside,
 * the wall beside the windows is green and the windows, at the same place
 * on the wall, show the sky.
 */
import { expect, type Page } from './pw';

import { aimCorner, frameOn, screen } from './rooms-drawing';
import { inspector } from './ui';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Query = (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type V3 = readonly [number, number, number];

/** The floor layer's min corner (world); the rooms object is made at the layer's place, so its frame is the layer's. */
const LAYER_AT = [218, -1, -45] as const;
/** The footprint (world x, z), an L: a wing along z (x 219–223) and one along x (z −44 to −40). */
const FOOTPRINT: readonly [number, number][] = [[219, -34], [223, -34], [223, -40], [229, -40], [229, -44], [219, -44]];
/** Where the interior stands: the building's place moved 100 m along x. */
export const INTERIOR_OFFSET = [100, 0, 0] as const;
/** The key that makes the script go through the door. */
export const ENTER_KEY = 'KeyB';

/** A room style: one wall swept on the outline (its inside one row, outside another) and a floor. */
function style(inside: string, floor: string | null): Record<string, unknown> {
  return {
    nodes: [
      { id: 'outline', type: 'outline', position: [0, 0] },
      { id: 'wall', type: 'wall', position: [260, 0], data: { thickness: 0.2, height: 3, dado: 0, inside, outside: 'lower_wall', top: 'lower_wall', lower: inside } },
      { id: 'walls', type: 'sweep', position: [520, 0], data: { wall: true, openings: true } },
      ...(floor !== null ? [{ id: 'floor', type: 'fill', position: [520, 150], data: { shape: 'flat', slot: floor } }] : []),
      { id: 'output', type: 'output', position: [780, 0] },
    ],
    edges: [
      { id: 'e1', from: { node: 'outline', port: 'path' }, to: { node: 'walls', port: 'path' } },
      { id: 'e2', from: { node: 'wall', port: 'profile' }, to: { node: 'walls', port: 'profile' } },
      { id: 'e3', from: { node: 'walls', port: 'element' }, to: { node: 'output', port: 'elements' } },
      ...(floor !== null
        ? [
            { id: 'e4', from: { node: 'outline', port: 'path' }, to: { node: 'floor', port: 'path' } },
            { id: 'e5', from: { node: 'floor', port: 'element' }, to: { node: 'output', port: 'elements' } },
          ]
        : []),
    ],
  };
}
const preset = (s: string, sheet: string): Record<string, unknown> => ({ nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: s, base: '', sheet } }], edges: [] });

/** Goes through the first door near the building's front when the key is pressed: loads the scene its link names. */
const ENTER_SCRIPT = [
  'export default {',
  '  instantiate() { return { entered: false }; },',
  '  step(state, ctx) {',
  "    if (ctx.phase !== 'intent' || state.entered || !ctx.input.pressed('enterDoor')) return;",
  '    const link = ctx.grid.doorLink([222.5, 0, -33], 2);',
  "    if (link === null) { ctx.log('warn', 'no door near'); return; }",
  '    ctx.scenes.load(link.to.scene);',
  '    state.entered = true;',
  "    ctx.log('info', `entered ${link.id} from ${link.scene} (${link.side}) to ${link.to.scene} at ${link.to.spawn.join(',')} facing ${link.to.facing}`);",
  '  },',
  '};',
].join('\n');

/** Where the outside is read (world points, the fixed Play camera) and the row each shows. */
export const BUILDING_OUTSIDE_READS = {
  facade: { at: [221.5, 1.5, -33.89] as V3, slot: 'crown' },
  window0: { at: [220.5, 1.45, -34] as V3, slot: 'baseboard' },
  window1: { at: [220.5, 4.45, -34] as V3, slot: 'baseboard' },
  roof: { at: [221, 7, -35.33] as V3, slot: 'floor' },
} as const;

/** The interior camera: inside the wing, looking at the front wall (+z) from 5.5 m. */
export const INTERIOR_CAMERA = { at: [321, 2.5, -39.5] as V3, fovY: 70 } as const;
/** Where the inside is read (world points of the interior): the wall beside and above the windows, and the windows. */
export const BUILDING_INSIDE_READS = {
  wall0: { at: [321.5, 1.45, -34.11] as V3, wall: true },
  wall1: { at: [321.5, 4.45, -34.11] as V3, wall: true },
  window0: { at: [320.5, 1.45, -34.11] as V3, wall: false },
  window1: { at: [320.5, 4.45, -34.11] as V3, wall: false },
} as const;

/** A world point on a picture (`w` × `h`) of the interior camera (level, looking +z). */
export function onInterior(p: V3, w: number, h: number): { x: number; y: number } {
  const [ex, ey, ez] = INTERIOR_CAMERA.at;
  const z = p[2] - ez;
  const t = Math.tan((INTERIOR_CAMERA.fovY * Math.PI) / 360);
  // Looking +z, the camera's right is −x.
  return { x: ((-(p[0] - ex) / (z * t * (w / h)) + 1) / 2) * w, y: ((1 - (p[1] - ey) / (z * t)) / 2) * h };
}

/** The outside's colours and whether each shows its row. */
export function judgeOutside(read: (p: V3) => readonly number[], rowHue: (slot: string, c: readonly number[]) => boolean): { colours: Record<string, readonly number[]>; ok: boolean } {
  const colours = Object.fromEntries(Object.entries(BUILDING_OUTSIDE_READS).map(([k, r]) => [k, read(r.at)]));
  return { colours, ok: Object.entries(BUILDING_OUTSIDE_READS).every(([k, r]) => rowHue(r.slot, colours[k]!)) };
}

/** The inside's colours: the wall green beside and above the windows, the windows not. */
export function judgeInside(read: (p: V3) => readonly number[], rowHue: (slot: string, c: readonly number[]) => boolean): { colours: Record<string, readonly number[]>; ok: boolean } {
  const colours = Object.fromEntries(Object.entries(BUILDING_INSIDE_READS).map(([k, r]) => [k, read(r.at)]));
  return { colours, ok: Object.entries(BUILDING_INSIDE_READS).every(([k, r]) => rowHue('baseboard', colours[k]!) === r.wall) };
}

/** The building's corner (layer cells) at world (x, z) on the floor: the rooms' frame is the layer's. */
const corner = (x: number, z: number, y = 1): V3 => [x - LAYER_AT[0], y, z - LAYER_AT[2]];

export interface DrawnBuilding {
  roomsId: string;
  interiorScene: string;
}

type Building = { id: string; preset: string; outside?: string; storeys?: number; storeyHeight?: number; roof?: { shape: string; rise?: number; slot?: string }; interior?: { scene: string; offset?: number[] }; openings?: { id: string; storey?: number; pane?: boolean; bottom: number }[]; path: { points: number[][] } };

export async function drawBuilding(page: Page, cmd: Cmd, query: Query, trimId: string, publish: (name: string, source: string, entityId: string) => Promise<void>): Promise<DrawnBuilding> {
  await cmd('setGraph', { graph: { graphId: 'e2e-house-in-style', kind: 'architecture-style', name: 'House inside', graph: style('baseboard', 'floor') } });
  await cmd('setGraph', { graph: { graphId: 'e2e-house-out-style', kind: 'architecture-style', name: 'House facade', graph: style('crown', null) } });
  await cmd('setGraph', { graph: { graphId: 'e2e-house-in', kind: 'architecture-preset', name: 'House inside', graph: preset('e2e-house-in-style', trimId) } });
  await cmd('setGraph', { graph: { graphId: 'e2e-house-out', kind: 'architecture-preset', name: 'House facade', graph: preset('e2e-house-out-style', trimId) } });
  await cmd('setBlockType', { block: { blockId: 'e2e-house-ground', name: 'House ground', variants: [{ color: '#303030' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'House floor', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [12, 8, 12] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 1, 12], cell: { block: 'e2e-house-ground' } }] });

  // ---- The editor: the layer's Rooms tool, Building mode, on the slice's floor (row 1, the cells' top).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`).click();
  const blocks = inspector(page).getByLabel('blocks panel');
  await expect(blocks).toBeVisible();
  await page.keyboard.press('f');
  await blocks.getByRole('toolbar', { name: 'block tools' }).getByRole('button', { name: 'Rooms', exact: true }).click();
  const slice = async (n: number): Promise<void> => {
    await blocks.getByLabel('slice', { exact: true }).fill(String(n));
    await blocks.getByLabel('slice', { exact: true }).press('Enter');
  };
  await slice(1);
  const rooms = blocks.getByLabel('rooms panel');
  await expect(rooms).toBeVisible();
  await frameOn(page, [[218, 0, -45], [230, 0, -45], [218, 0, -33], [230, 0, -33], [219, 3, -34]]);
  const tool = (name: string): Promise<void> => rooms.getByRole('toolbar', { name: 'room tools' }).getByRole('button', { name, exact: true }).click();
  const roomsObject = async (): Promise<{ id: string; buildings: Building[] } | null> => {
    const ents = ((await query('queryEntities', { limit: 500, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
    const e = ents.find((x) => (x.components['architecture'] as { layer?: string } | undefined)?.layer === layer);
    return e === undefined ? null : { id: e.id, buildings: ((e.components['architecture'] as { buildings?: Building[] }).buildings ?? []) };
  };
  const house = async (): Promise<Building | undefined> => (await roomsObject())?.buildings[0];

  // The footprint: six corners clicked, the first clicked again to close; the new building wears the facade preset.
  await rooms.getByLabel('new room preset').selectOption('e2e-house-in');
  await rooms.getByLabel('new facade preset').selectOption('e2e-house-out');
  await tool('Building');
  for (const [x, z] of FOOTPRINT) {
    const s = await aimCorner(page, [x, 0, z], corner(x, z));
    await page.mouse.click(s.x, s.y);
  }
  const first = await aimCorner(page, [FOOTPRINT[0]![0], 0, FOOTPRINT[0]![1]], corner(FOOTPRINT[0]![0], FOOTPRINT[0]![1]));
  await page.mouse.click(first.x, first.y);
  await expect.poll(async () => (await house())?.outside, { timeout: 15_000 }).toBe('e2e-house-out');
  const roomsId = (await roomsObject())!.id;
  expect((await house())!).toMatchObject({ id: 'building-1', preset: 'e2e-house-in', roof: { shape: 'hip' } });
  expect((await house())!.path.points.length).toBe(6);

  // The building inspector: two 3 m storeys.
  const panel = rooms.getByLabel('building building-1 inspector');
  await expect(panel).toBeVisible();
  const setNum = async (label: string, value: string): Promise<void> => {
    await panel.getByLabel(label, { exact: true }).fill(value);
    await panel.getByLabel(label, { exact: true }).press('Enter');
  };
  await setNum('storeys', '2');
  await expect.poll(async () => (await house())?.storeys, { timeout: 15_000 }).toBe(2);
  await setNum('storey height', '3');
  await expect.poll(async () => (await house())?.storeyHeight, { timeout: 15_000 }).toBe(3);

  // A door and a window on the front wall's ground storey, a window a storey up (from the slice there).
  await tool('Door');
  const door = (await screen(page, [222.5, 0, -34]))!;
  await page.mouse.click(door.x, door.y);
  await tool('Window');
  const win = (await screen(page, [220.5, 0, -34]))!;
  await page.mouse.click(win.x, win.y);
  await slice(4);
  const up = (await screen(page, [220.5, 3, -34]))!;
  await page.mouse.click(up.x, up.y);
  await expect.poll(async () => (await house())?.openings?.map((o) => `${o.id}:${o.storey ?? 0}`), { timeout: 15_000 }).toEqual(['door-1:0', 'window-1:0', 'window-2:1']);
  await slice(1);

  // The inspector again: the windows without panes, the roof's rise and slot, a new interior scene 100 m along x.
  await expect(panel).toBeVisible();
  for (const w of ['window-1', 'window-2']) {
    // The box follows the stored value (it shows the pane until the change arrives): a click, then the store read.
    await panel.getByLabel(`${w} pane`).click();
    await expect.poll(async () => (await house())?.openings?.find((o) => o.id === w)?.pane, { timeout: 15_000 }).toBeUndefined();
  }
  await setNum('roof rise', '1.5');
  await expect.poll(async () => (await house())?.roof?.rise, { timeout: 15_000 }).toBe(1.5);
  await panel.getByLabel('roof slot', { exact: true }).fill('floor');
  await panel.getByLabel('roof slot', { exact: true }).press('Enter');
  await expect.poll(async () => (await house())?.roof?.slot, { timeout: 15_000 }).toBe('floor');
  await panel.getByRole('button', { name: 'New interior scene' }).click();
  await expect.poll(async () => (await house())?.interior?.scene, { timeout: 15_000 }).toBe('building-1-interior');
  await expect(panel.getByLabel('interior', { exact: true })).toHaveValue('building-1-interior');
  await setNum('interior offset x', String(INTERIOR_OFFSET[0]));
  await expect.poll(async () => (await house())?.interior?.offset, { timeout: 15_000 }).toEqual([...INTERIOR_OFFSET]);
  const interiorScene = (await house())!.interior!.scene;

  // The interior scene's camera, and the script that goes through the door on a key.
  await cmd('createEntity', { sceneId: interiorScene, parentId: null, kind: 'group', name: 'Interior camera', transform: { position: [...INTERIOR_CAMERA.at], rotation: [0, 1, 0, 0] }, components: { virtualCamera: { rig: 'fixed', priority: 10, blend: 'cut', fovY: INTERIOR_CAMERA.fovY, near: 0.05, far: 60 } } });
  await cmd('setInput', { input: { actions: [{ name: 'enterDoor', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: ENTER_KEY }] }] } });
  await publish('enter-door', ENTER_SCRIPT, roomsId);
  return { roomsId, interiorScene };
}

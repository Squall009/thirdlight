/**
 * The phase's picture set: one fixed list, read by the picture command (pictures-cli.ts) and by an agent who opens
 * every picture and writes what it sees (docs/pictures.md). Each entry has an id that stays the same from phase to
 * phase (a later phase's picture is put beside this one's by its id), a short title, and one line of what to look
 * for: what the picture exists to show, so a reader knows where to look first. What a picture shows is never a
 * pass or fail; a picture that could not be taken is.
 *
 * World pictures are the lighting bench's own cameras (lighting-cameras.ts) on the 8 km town of staging's
 * `voxel-slice` project, taken by `light-shots` in one of two runs (the bench data each needs differs: the lit
 * props and the L-shaped room for the day run, the many-lamps scene for the lamps run). Editor screens drive the
 * real editor against a real backend (editor-screens.ts): a fresh backend's made yard for the authoring screens,
 * staging's town for the voxel world page and Play.
 */
import { LIGHT_CHECK_NAMES, LIGHT_SHOT_NAMES, MANY_LAMP_SHOT_NAMES, type LightShotName } from './lighting-cameras';

/** The light-shots runs a world picture comes from, and the bench data each places (its options). */
export const PICTURE_RUNS = Object.freeze({
  // Two lit props (the cart at the third street lamp, the table under the room's window) and the L-shaped room
  // (built over the town, the camera's occlusion left off so the roofs are seen as they are).
  day: Object.freeze(['--props', '2', '--rooms', 'off']),
  // The many-lamps scene: 128 lights of every kind and the glowing strips.
  lamps: Object.freeze(['--lamps', '128']),
});
export type PictureRun = keyof typeof PICTURE_RUNS;

/** The editor screens (editor-screens.ts takes each). */
export const SCREEN_NAMES = ['editor', 'structure', 'water', 'spline', 'voxel-world-page', 'play-profiler', 'world-mode', 'world-fill'] as const;
export type ScreenName = (typeof SCREEN_NAMES)[number];

interface PictureBase {
  /** Stable from phase to phase. */
  readonly id: string;
  readonly title: string;
  /** One line: what the picture exists to show. */
  readonly look: string;
}
export interface WorldPicture extends PictureBase {
  readonly kind: 'world';
  readonly camera: LightShotName;
  readonly run: PictureRun;
}
export interface ScreenPicture extends PictureBase {
  readonly kind: 'screen';
  readonly screen: ScreenName;
}
export type PictureEntry = WorldPicture | ScreenPicture;

const world = (id: string, camera: LightShotName, run: PictureRun, title: string, look: string): WorldPicture => Object.freeze({ kind: 'world', id, camera, run, title, look });
const screen = (id: string, name: ScreenName, title: string, look: string): ScreenPicture => Object.freeze({ kind: 'screen', id, screen: name, title, look });

export const PICTURES: readonly PictureEntry[] = Object.freeze([
  world('L1', 'street-noon', 'day', 'Street at noon', 'house fronts, doors, windows and fences in sun and shade: light leaks at wall feet, specks, missing textures, blotchy shading'),
  world('L2', 'room-window', 'day', 'Room with a window', 'the centre house inside at noon: sun patches through the west windows, dark corners staying dark, bright lines at wall corners or floor edges'),
  world('L3', 'cave', 'day', 'Cave from inside', 'the dug tube 22 m in: walls dark without leaks, the bright mouth, no sky light inside the rock'),
  world('L4', 'night-lamps', 'day', 'Street at night', 'five warm lamps on fronts, fences and ground: pools of light, falloff, banding, lamps lighting through walls'),
  world('L5', 'far-view', 'day', 'Far view over the town', 'from 40 m up across the town to the massif: near rings to far field without seams, holes or popping mush'),
  world('L6', 'lamps-street', 'lamps', 'Many lamps: street', 'street lamps, eave spots, door panels and glowing strips at night: each light type lit, no light through walls, no flicker'),
  world('L7', 'lamps-room', 'lamps', 'Many lamps: room', 'the room by its room lamp at night: a warm falloff from the lamp, the window frames, no blotches'),
  world('L8', 'lamps-high', 'lamps', 'Many lamps: from 45 m', 'the lit town from above at night: lamps of many streets, light pools not tiled or clipped by distance'),
  world('L9', 'props-cart', 'day', 'Lit prop: cart', 'the bench cart by the third lamp at night: the cart lit by the lamp and its shade on the ground east of it'),
  world('L10', 'props-table', 'day', 'Lit prop: table', 'the table under the room window at noon: the floor under it darker than beside it, its legs grounded'),
  world('L11', 'house-60m', 'day', 'House fronts from 60 m', 'the row of fronts 60 m away from 40 m up: windows and fronts at that distance, rooms behind windows dark'),
  world('L12', 'house-above', 'day', 'House from above', 'the room camera\'s house from 18 m up: roof, ridges and eaves, shading of the roof slopes'),
  world('L13', 'lroom-above', 'day', 'L-shaped room from above', 'the floating L room and the brick hut in its notch: walls, roof edges, dark specks along edges'),
  world('L14', 'town-100m', 'day', 'Town from 100 m', 'the town\'s middle drawn by the mesh rings: houses, roofs, ground, ring seams'),
  world('L15', 'town-150m', 'day', 'Town from 150 m', 'the mesh rings at 150 m: the same houses coarser but whole, no cracks between levels'),
  world('L16', 'town-250m', 'day', 'Town from 250 m', 'far bricks start: houses as bricks, their colours and outlines kept, no mush'),
  world('L17', 'town-600m', 'day', 'Town from 600 m', 'the far field at 600 m: the town a coherent patch on the landscape, no holes'),
  world('L18', 'town-2km', 'day', 'Town from 2 km', 'the landscape from 2 km: mountains, the town small, the horizon and the sky'),
  world('L19', 'ref-30m', 'day', 'Reference house at 30 m', 'the brick house\'s west gable in sun, its ground contact and front: bricks, edges, the gable\'s blotches'),
  world('L20', 'ref-60m', 'day', 'Reference house at 60 m', 'the same house at 60 m: ridges, gable, front without white or dark specks'),
  world('L21', 'ref-100m', 'day', 'Reference house at 100 m', 'the same house at 100 m: ridges and roofs at the ring change, no sparkle'),
  world('L22', 'ref-150m', 'day', 'Reference house at 150 m', 'the same house at 150 m: its shape and colour kept as the levels coarsen'),
  screen('E1', 'editor', 'The editor with a scene', 'the default editor: Scene and Game tabs, Hierarchy, Inspector, Project dock, a house selected with its gizmo, panels not overlapping'),
  screen('E2', 'structure', 'Structure mode', 'a two-storey house with a door and a window, the Shape tool\'s corner and edge handles on it, the mode\'s panel and Done button'),
  screen('E3', 'water', 'A water body', 'a lake filling a dug hollow, selected: its level handle, the Inspector\'s water state, the water surface drawn'),
  screen('E4', 'spline', 'A spline road', 'a spline that writes a road across the yard, selected: its point grips, the road cut and its surface, the Inspector\'s voxels section'),
  screen('E5', 'voxel-world-page', 'The voxel world page', 'the town on the voxel world page: the world drawn with its far field, the page\'s own panel readable'),
  screen('E6', 'play-profiler', 'Play with the Profiler', 'Play in the editor on the town, the Profiler tab open under it: the game drawn, the timeline and the frame\'s spans readable'),
  screen('E7', 'world-mode', 'World edit mode', 'the world mode on the yard: a hill raised and smoothed by brush strokes with a patch of another material painted on its top, the Sculpt rail\'s tools and palette, the brush panel, the brush cursor on the ground'),
  screen('E8', 'world-fill', 'World mode: a fog fill and a leak', 'the world mode\'s Fill rail on the yard: two dug hollows, the nearer one filled with fog by a click and a drag of the level, the other breached by a trench so its fill is refused and its leak marked in red; the level ring, the Fill panel, the status line'),
]);

/** What is wrong with a picture list (empty: nothing): ids unique, every entry has its title and its line, every camera and screen known. */
export function pictureListProblems(list: readonly PictureEntry[]): string[] {
  const out: string[] = [];
  const cameras: readonly string[] = [...LIGHT_SHOT_NAMES, ...LIGHT_CHECK_NAMES, ...MANY_LAMP_SHOT_NAMES];
  const seen = new Set<string>();
  const shots = new Set<string>();
  for (const p of list) {
    if (!/^[A-Z][0-9]+$/.test(p.id)) out.push(`${p.id}: an id is a letter and a number`);
    if (seen.has(p.id)) out.push(`${p.id}: the id is taken twice`);
    seen.add(p.id);
    if (p.title.trim() === '') out.push(`${p.id}: no title`);
    if (p.look.trim().length < 20) out.push(`${p.id}: no line of what to look for`);
    const shot = p.kind === 'world' ? `camera ${p.camera}` : `screen ${p.screen}`;
    if (shots.has(shot)) out.push(`${p.id}: ${shot} is in the list twice`);
    shots.add(shot);
    if (p.kind === 'world') {
      if (!cameras.includes(p.camera)) out.push(`${p.id}: no camera ${p.camera}`);
      if (!(p.run in PICTURE_RUNS)) out.push(`${p.id}: no run ${p.run}`);
    } else if (!(SCREEN_NAMES as readonly string[]).includes(p.screen)) out.push(`${p.id}: no screen ${p.screen}`);
  }
  return out;
}

/** The world pictures of one run, in the list's order (the cameras its light-shots run is asked for). */
export function camerasOf(list: readonly PictureEntry[], run: PictureRun): LightShotName[] {
  return list.filter((p): p is WorldPicture => p.kind === 'world' && p.run === run).map((p) => p.camera);
}

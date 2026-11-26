/**
 * Projected decals on every kind of receiver (shared by the layered-material
 * spec, whose trim sheet, backend, Play session and export they are read
 * with).
 *
 * Behind the main camera (it never sees them), on one flat terrain tile:
 * a block layer's tops, a box floor, a prop (a grey model), a second prop in decal layer
 * 2 only, and a generated wall facing the decal camera (one swept face on
 * the trim sheet's magenta row). Green decals (an albedo image) project
 * down onto the terrain, the block tops and both props, and along −Z onto
 * the wall; the decal over the second prop marks layer 1 only, so that prop
 * stays grey. A normal-only decal (the tilted normal map, albedo opacity 0)
 * lies on the terrain: it changes the light the terrain takes there, not its
 * colour.
 *
 * In Play and the export a key loads a scene whose camera looks at them;
 * the Scene view is framed on them in the editor. Each read is a world
 * point; the Scene view's green must have Play's hue, and the bare surfaces
 * beside the marks Play's light.
 *
 * Clipped decals (the same green, in `clipped` mode): one across the block
 * layer's front edge (tilted 45°, so it marks the top and the front face
 * at once) and one on the generated wall. Their meshes are clipped from the
 * block chunk and the wall's chunk on the generator workers. In the Scene
 * view a block under the edge mark is taken away: the chunk re-meshes and
 * the mark is clipped again, gone where the block was (a stale mesh would
 * hang in the air) and still on the block beside it; Play and the export
 * draw it so too. The wall's clipped decal is then baked to a model (the
 * decal editor's "Bake to model"): a model asset of the same mark, drawn as a
 * mesh decal where the decal was.
 *
 * A shadowed point light and a shadowed spot light hang over the receivers
 * (white, so the green stays green), so a decal's receiver reads the light
 * path's textures too: its programs bind all a lit program may.
 *
 * Change while the game runs: a green decal carried by a mover goes 2.4 m
 * along the terrain once Play starts (Play shows it where it went, not
 * where it was placed), and the key's script spawns a decal from a prefab
 * (`ctx.decals.spawn`) beside it; the key again removes the spawn, which
 * fades out.
 */
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { expect, type Locator, type Page } from './pw';
import { frameOn } from './rooms-drawing';
import { armTile } from './ui';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type V3 = readonly [number, number, number];
type Rgb = readonly number[];

/** The key that loads the decal scene (its camera looks at the receivers). */
export const DECALS_KEY = 'KeyM';
/** The decal camera: its place, its pitch down (radians) and its lens. */
export const DECALS_CAMERA = { at: [250, 6, 40] as V3, pitch: (-35 * Math.PI) / 180, fovY: 50 } as const;

/** Down: a decal box's −Z (where it projects) along world −Y, its image's top toward −Z. */
const DOWN: readonly number[] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** The terrain tile's corner (one 32 m tile, flat at 0), the block layer's corner (4 × 4 cells, tops at 1), the props, the wall line. */
const TERRAIN_AT: V3 = [234, 0, 4];
const BLOCKS_AT: V3 = [248, 0, 25];
const PROP_AT: V3 = [256, 0, 27];
const MASKED_AT: V3 = [259, 0, 27];
const WALL_Z = 22;
/** A box floor on the terrain (its top at y 0.1), clear of the other receivers' decals and reads. */
const BOX_FLOOR = { at: [242, 0.05, 25] as V3, size: [3, 0.1, 2] as V3 } as const;
/** The moving decal's start and end, the spawned decal's place: a row on the terrain before the normal-only decal. */
const MOVE_FROM: V3 = [246.8, 0, 34.9];
const MOVE_TO: V3 = [249.2, 0, 34.9];
const SPAWN_AT: V3 = [251.6, 0, 34.9];
/** The prefab the key's script spawns its decal from. */
const SPAWN_PREFAB = 'e2e-pd-spawn';

/** The decals: where each is centred, its box, how it is turned, what it draws with. */
const DECALS = [
  { name: 'Decal on terrain', at: [243, 0, 29] as V3, size: [2.4, 2.4, 2], rotation: DOWN, material: 'mat-pd-green' },
  { name: 'Decal on blocks', at: [250, 1, 27] as V3, size: [2, 2, 1.2], rotation: DOWN, material: 'mat-pd-green' },
  { name: 'Decal on a prop', at: [256, 1, 27] as V3, size: [0.9, 0.9, 1], rotation: DOWN, material: 'mat-pd-green' },
  { name: 'Decal on a wall', at: [245, 1, WALL_Z] as V3, size: [1.4, 1.4, 1], rotation: [0, 0, 0, 1], material: 'mat-pd-green' },
  { name: 'Decal off layer 2', at: [259, 1, 27] as V3, size: [0.9, 0.9, 1], rotation: DOWN, material: 'mat-pd-green', layers: 1 },
  { name: 'Normal-only decal', at: [247, 0, 33] as V3, size: [2.4, 2.4, 2], rotation: DOWN, material: 'mat-pd-bump' },
  { name: 'Roughness-only decal', at: [257, 0, 33] as V3, size: [2.4, 2.4, 2], rotation: DOWN, material: 'mat-pd-wet' },
] as const;

/** The shadowed lamps over the receivers: a point light and a spot light looking straight down. */
const DECAL_LAMPS = [
  { name: 'Decal lamp', at: [250, 8, 31] as V3, light: { type: 'point', color: '#ffffff', intensity: 4, range: 14, decay: 2, castShadow: true } },
  { name: 'Decal spot', at: [246, 9, 30] as V3, light: { type: 'spot', color: '#ffffff', intensity: 4, range: 14, decay: 2, angle: 35, penumbra: 0.3, direction: [0, -1, 0], castShadow: true } },
] as const;

/** Tilted 45° down toward the camera: the box's −Z meets a block's top and its front (+Z) face alike. */
const TILTED: readonly number[] = [-Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
/** The clipped decals: across the block layer's front edge (z 29, top 1), and on the wall. */
const CLIPPED = [
  { name: 'Clipped on the block edge', at: [251.3, 1, 29] as V3, size: [1.6, 0.8, 1.2], rotation: TILTED },
  { name: 'Clipped on the wall', at: [248, 1, WALL_Z] as V3, size: [1.2, 1.2, 1], rotation: [0, 0, 0, 1] },
] as const;
/** The block taken away under the edge mark in the Scene view (its layer cell; world x 251–252, z 28–29): the chunk re-meshes. */
export const REMESH_CELL = [3, 0, 3] as const;

/** The world points read: each marked surface, a clean one beside it, the prop off the decal's layer, the bumped terrain and its reference. */
export const DECAL_READS = {
  terrain: [243.4, 0, 29.3] as V3,
  terrainClean: [239, 0, 29.3] as V3,
  blocks: [250.3, 1, 27.3] as V3,
  prop: [256.15, 1, 27.15] as V3,
  wall: [245.2, 1.2, WALL_Z + 0.01] as V3,
  wallClean: [241, 1.2, WALL_Z + 0.01] as V3,
  masked: [259.15, 1, 27.15] as V3,
  bumped: [247.3, 0, 33.3] as V3,
  bumpClean: [252, 0, 33.3] as V3,
  wet: [257.3, 0, 33.3] as V3,
} as const;

/** The clipped decals' reads: the edge's top and front over the block taken away, its front on the block beside it, the wall, a clean front. */
export const CLIPPED_READS = {
  top: [251.3, 1, 28.85] as V3,
  front: [251.3, 0.85, 29.01] as V3,
  beside: [250.75, 0.85, 29.01] as V3,
  wall: [248.2, 1.2, WALL_Z + 0.01] as V3,
  frontClean: [249.6, 0.6, 29.01] as V3,
} as const;

/** The reads of the decals that change in Play: where the moving one went and came from, the spawn. */
export const CHANGE_READS = {
  movedTo: [MOVE_TO[0], 0, MOVE_TO[2]] as V3,
  movedFrom: [MOVE_FROM[0], 0, MOVE_FROM[2]] as V3,
  spawned: [SPAWN_AT[0], 0, SPAWN_AT[2]] as V3,
  clean: [SPAWN_AT[0] + 1.2, 0, SPAWN_AT[2]] as V3,
} as const;

const DECALS_SCRIPT = (scene: string): string =>
  [
    'export default {',
    '  instantiate() { return { shown: false, mark: 0 }; },',
    '  step(state, ctx) {',
    "    if (ctx.phase !== 'intent' || !ctx.input.pressed('showDecals')) return;",
    // The second press removes the spawned mark (it fades out).
    '    if (state.shown) {',
    '      ctx.decals.remove(state.mark);',
    '      return;',
    '    }',
    `    ctx.scenes.load('${scene}');`,
    `    state.mark = ctx.decals.spawn('${SPAWN_PREFAB}', { position: ${JSON.stringify(SPAWN_AT)}, normal: [0, 1, 0] });`,
    '    state.shown = true;',
    '  },',
    '};',
  ].join('\n');

export interface ProjectedDecalSetup {
  /** The input action that loads the decal scene (the caller's input lists it with its own). */
  readonly action: { name: string; type: 'button'; map: 'gameplay'; bindings: { kind: 'key'; code: string }[] };
  /** The decal entities made in the main scene (the moving one and the clipped ones included), and of them the projected ones. */
  readonly decals: number;
  readonly projected: number;
  /** The clipped ones, the block layer the first lies on (the Scene view takes a block from under it), the one on the wall (baked to a model). */
  readonly clipped: number;
  readonly blocksId: string;
  readonly clippedWallId: string;
  /** The entity to focus the Scene view on (the terrain tile: focused, the view frames it whole). */
  readonly focusId: string;
}

/** The receivers, the decals and the decal scene with its camera, in the main scene; the wall wears `trimId`'s lower wall row. */
export async function makeProjectedDecals(cmd: Cmd, trimId: string, publish: { texture(bytes: Uint8Array, id: string): Promise<void>; model(bytes: Uint8Array, id: string): Promise<void>; script(name: string, source: string, entityId: string): Promise<void> }): Promise<ProjectedDecalSetup> {
  const create = async (name: string, position: V3, extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> =>
    String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind, name, transform: { position: [...position] }, ...extra }))['createdId']);
  // The receivers: a flat terrain tile, a block layer on it, two grey props, a swept wall.
  const ground = await create('Decal terrain', TERRAIN_AT);
  await cmd('setComponent', { entityId: ground, component: 'terrain', value: { tileSamples: 33, spacing: 1, heightRange: [-4, 4], tiles: [{ x: 0, z: 0 }] } });
  await cmd('setBlockType', { block: { blockId: 'e2e-decal-ground', name: 'Decal ground', variants: [{ color: '#909090' }], shape: 'full' } });
  const blocks = await create('Decal blocks', BLOCKS_AT);
  await cmd('setComponent', { entityId: blocks, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 1, 4] }, castShadow: false, receiveShadow: false } });
  await cmd('editBlocks', { entityId: blocks, edits: [{ kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'e2e-decal-ground' } }] });
  await publish.model(new Uint8Array(multiPieceGlb([{ name: 'crate', lods: [[1.2, 1, 1.2]], colors: [[0.55, 0.55, 0.55]], vertexColor: [1, 1, 1, 1] }], { centred: true })), 'e2e-decal-crate');
  const prop = await create('Decal prop', PROP_AT, { model: { asset: { assetId: 'e2e-decal-crate' } } }, 'model');
  const masked = await create('Decal prop, layer 2', MASKED_AT, { model: { asset: { assetId: 'e2e-decal-crate' } } }, 'model');
  await cmd('setComponent', { entityId: masked, component: 'model', value: { asset: { assetId: 'e2e-decal-crate' }, decalLayers: 2 } });
  // A box floor with no decal on it at load: the decal editor previews and places one there.
  await create('Decal box floor', BOX_FLOOR.at, { box: { size: [...BOX_FLOOR.size], material: { color: '#909090' } } }, 'box');
  const wall = await create('Decal wall', [0, 0, 0]);
  // Swept along +X, a profile drawn up faces right of travel: +Z, toward the decal camera.
  await cmd('setComponent', { entityId: wall, component: 'architecture', value: { profiles: { face: { points: [[0, 0], [0, 2]], slots: ['lower_wall'] } }, elements: [{ id: 'wall', kind: 'sweep', path: { points: [[238, 0, WALL_Z], [262, 0, WALL_Z]] }, profile: 'face' }] } });
  await cmd('setComponent', { entityId: wall, component: 'materials', value: { '*': trimId } });

  // The decal materials: a green image; the tilted normal map alone.
  await publish.texture(new Uint8Array(makePng(64, 64, () => [40, 200, 60, 255])), 'pd-green');
  await cmd('setMaterial', { material: { materialId: 'mat-pd-green', name: 'Green mark', shader: 'decal', params: {}, textures: { map: 'pd-green' } } });
  await cmd('setMaterial', { material: { materialId: 'mat-pd-bump', name: 'Bump mark', shader: 'decal', params: {}, textures: { normalMap: 'tilt' } } });
  // A wet patch: a roughness value alone (no image, no colour).
  await cmd('setMaterial', { material: { materialId: 'mat-pd-wet', name: 'Wet mark', shader: 'decal', params: { roughness: 0.05 }, textures: {} } });
  for (const d of DECALS) {
    const decal = { size: [...d.size], material: d.material, ...('layers' in d ? { layers: d.layers } : {}), ...('opacity' in d ? { opacity: d.opacity } : {}) };
    await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: d.name, transform: { position: [...d.at], rotation: [...d.rotation] }, components: { decal } });
  }
  // Shadowed local lights over them (white, faint, high, so their shadows fall under what casts them and their
  // highlights barely pale the green): the receivers' programs
  // then read the light clusters, the shadow atlas and the light tables beside the decals (and the surface cache where
  // it is read), every texture a lit program may bind.
  for (const l of DECAL_LAMPS) await create(l.name, l.at, { components: { light: l.light } });
  const clippedIds: string[] = [];
  for (const d of CLIPPED) {
    const decal = { size: [...d.size], mode: 'clipped', material: 'mat-pd-green' };
    clippedIds.push(String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: d.name, static: true, transform: { position: [...d.at], rotation: [...d.rotation] }, components: { decal } }))['createdId']));
  }
  // A decal carried along the terrain by a mover (from where it was placed, once); a prefab whose decal the key's script spawns.
  const mark = { size: [0.6, 0.6, 1], material: 'mat-pd-green' };
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Moving decal', transform: { position: [...MOVE_FROM], rotation: [...DOWN] }, components: { decal: mark, mover: { waypoints: [[MOVE_TO[0] - MOVE_FROM[0], 0, 0]], speed: 1.5, mode: 'once' } } });
  await cmd('createScene', { sceneId: 'e2e-decal-kit', name: 'Decal kit' });
  const kit = String((await cmd('createEntity', { sceneId: 'e2e-decal-kit', parentId: null, kind: 'group', name: 'Spawned mark', transform: { position: [0, 0, 0] }, components: { decal: mark } }))['createdId']);
  await cmd('createPrefab', { prefabId: SPAWN_PREFAB, displayName: 'Spawned mark', sourceEntityId: kit });

  // The decal scene: its camera (above every other) looks at them; a key loads it.
  const scene = 'e2e-decals';
  await cmd('createScene', { sceneId: scene, name: 'Decals' });
  const p = DECALS_CAMERA.pitch;
  await cmd('createEntity', { sceneId: scene, parentId: null, kind: 'group', name: 'Decals camera', transform: { position: [...DECALS_CAMERA.at], rotation: [Math.sin(p / 2), 0, 0, Math.cos(p / 2)] }, components: { virtualCamera: { rig: 'fixed', priority: 30, blend: 'cut', fovY: DECALS_CAMERA.fovY, near: 0.2, far: 80 } } });
  await publish.script('show-decals', DECALS_SCRIPT(scene), ground);
  return { action: { name: 'showDecals', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: DECALS_KEY }] }, decals: DECALS.length + 1 + CLIPPED.length, projected: DECALS.length + 1, clipped: CLIPPED.length, blocksId: blocks, clippedWallId: clippedIds[1]!, focusId: ground };
}

/** A world point on a picture (`w` × `h`) of the decal camera. */
export function onDecals(p: V3, w: number, h: number): { x: number; y: number } {
  const e = DECALS_CAMERA.at;
  const d = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
  const s = Math.sin(DECALS_CAMERA.pitch);
  const c = Math.cos(DECALS_CAMERA.pitch);
  const z = d[1]! * s - d[2]! * c;
  const t = Math.tan((DECALS_CAMERA.fovY * Math.PI) / 360);
  return { x: ((d[0]! / (z * t * (w / h)) + 1) / 2) * w, y: ((1 - (d[1]! * c + d[2]! * s) / (z * t)) / 2) * h };
}

const sum = (c: Rgb): number => c[0]! + c[1]! + c[2]!;
/** The decal's green: green clearly over red and blue. */
export const isDecalGreen = (c: Rgb): boolean => c[1]! > 40 && c[1]! > c[0]! * 1.8 && c[1]! > c[2]! * 1.4;
/** Two readings of one colour at another brightness: their channel shares within 0.05. */
const sameShares = (a: Rgb, b: Rgb): boolean => sum(a) > 0 && sum(b) > 0 && a.every((v, k) => Math.abs(v / sum(a) - b[k]! / sum(b)) < 0.05);

/**
 * A wet (glossy) patch on the terrain against the bare terrain: the
 * terrain's colour (channel shares within 0.05) at about its brightness
 * (0.8–1.25 ×). A decal without a colour that painted its white tint there
 * would wash the terrain out (brighter, the shares evened out). How much
 * the shine changes depends on the light and the view: not judged.
 */
export const wetLook = (wet: Rgb, clean: Rgb): boolean => {
  const r = sum(wet) / Math.max(1, sum(clean));
  return sameShares(wet, clean) && r >= 0.8 && r <= 1.25;
};

export interface DecalJudgement {
  readonly colours: Record<keyof typeof DECAL_READS, Rgb>;
  readonly bad: string[];
  readonly ok: boolean;
}

/**
 * Whether a picture shows the decals: green on the terrain, the block tops,
 * the prop and the wall, the clean terrain and wall beside them not green
 * (the wall its row's hue), the prop outside the decal's layer not green,
 * and the normal-only decal changing the terrain's light (brightness off by
 * 8 % or more; 15 % on this host) but not its colour. The roughness-only
 * decal paints no tint ({@link wetLook}): neither decal has a colour of its
 * own, so neither may whiten the terrain under it.
 */
export function judgeDecals(read: (p: V3) => Rgb, rowHue: (slot: string, c: Rgb) => boolean, only?: readonly (keyof typeof DECAL_READS)[]): DecalJudgement {
  const colours = Object.fromEntries(Object.entries(DECAL_READS).map(([k, p]) => [k, read(p)])) as Record<keyof typeof DECAL_READS, Rgb>;
  const checks: [keyof typeof DECAL_READS, boolean][] = [
    ['terrain', isDecalGreen(colours.terrain)],
    ['terrainClean', !isDecalGreen(colours.terrainClean) && sum(colours.terrainClean) > 30],
    ['blocks', isDecalGreen(colours.blocks)],
    ['prop', isDecalGreen(colours.prop)],
    ['wall', isDecalGreen(colours.wall)],
    ['wallClean', rowHue('lower_wall', colours.wallClean)],
    ['masked', !isDecalGreen(colours.masked) && sum(colours.masked) > 30],
    ['bumped', sameShares(colours.bumped, colours.bumpClean) && Math.abs(sum(colours.bumped) / sum(colours.bumpClean) - 1) >= 0.08],
    ['wet', wetLook(colours.wet, colours.bumpClean)],
  ];
  const bad = checks.filter(([k, ok]) => !ok && (only === undefined || only.includes(k))).map(([k]) => k);
  return { colours, bad, ok: bad.length === 0 };
}

/**
 * Whether a Play or export picture shows the decals that change: the moving
 * one green where it went and gone from where it was placed, the spawned one
 * green (gone once `removed`: the bare terrain's colour beside it).
 */
export function judgeChanges(read: (p: V3) => Rgb, removed: boolean): { colours: Record<keyof typeof CHANGE_READS, Rgb>; bad: string[]; ok: boolean } {
  const colours = Object.fromEntries(Object.entries(CHANGE_READS).map(([k, p]) => [k, read(p)])) as Record<keyof typeof CHANGE_READS, Rgb>;
  // Gone means the bare terrain's colour beside it (a fading mark is still on its way there).
  const bare = (c: Rgb): boolean => sum(colours.clean) > 30 && c.every((v, k) => Math.abs(v - colours.clean[k]!) <= 6);
  const checks: [keyof typeof CHANGE_READS, boolean][] = [
    ['movedTo', isDecalGreen(colours.movedTo)],
    ['movedFrom', bare(colours.movedFrom)],
    ['spawned', removed ? bare(colours.spawned) : isDecalGreen(colours.spawned)],
    ['clean', !isDecalGreen(colours.clean)],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { colours, bad, ok: bad.length === 0 };
}

/**
 * Whether a picture shows the clipped decals: green on the wall and on the
 * block edge (its top and front), the front beside it clean; once the block
 * under the mark is taken away (`remeshed`), none where it was and still
 * green on the block beside it.
 */
export function judgeClipped(read: (p: V3) => Rgb, remeshed: boolean): { colours: Record<keyof typeof CLIPPED_READS, Rgb>; bad: string[]; ok: boolean } {
  const colours = Object.fromEntries(Object.entries(CLIPPED_READS).map(([k, p]) => [k, read(p)])) as Record<keyof typeof CLIPPED_READS, Rgb>;
  // A sunlit top takes some white (its highlight): green well over red and blue still, grey nowhere near.
  const mark = (c: Rgb): boolean => c[1]! > 40 && c[1]! > c[0]! * 1.5 && c[1]! > c[2]! * 1.4;
  const checks: [keyof typeof CLIPPED_READS, boolean][] = [
    ['top', mark(colours.top) !== remeshed],
    ['front', mark(colours.front) !== remeshed],
    ['beside', mark(colours.beside)],
    ['wall', mark(colours.wall)],
    ['frontClean', !mark(colours.frontClean) && sum(colours.frontClean) > 30],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { colours, bad, ok: bad.length === 0 };
}

export const fmtDecals = (j: DecalJudgement): string => Object.entries(j.colours).map(([k, c]) => `${k} ${c.map((v) => v.toFixed(0)).join(',')}`).join('; ') + (j.bad.length > 0 ? ` | bad: ${j.bad.join(', ')}` : '');

/** Frame the Scene view on the receivers: focus the terrain tile (the F key), then zoom only if they do not all fit. */
export async function frameDecals(page: Page, view: Locator, focusId: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${focusId}"]`).click();
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await view.getAttribute('data-view-proj');
  await page.keyboard.press('f');
  // Moved, then still (the focus may glide).
  let last = before;
  await expect.poll(async () => {
    const now = await view.getAttribute('data-view-proj');
    const still = now !== before && now === last;
    last = now;
    return still;
  }, { timeout: 5_000, intervals: [150] }).toBe(true);
  await page.keyboard.press('Escape');
  const project = await sceneViewProjector(view);
  const corners: V3[] = [[238, 0, 22], [262, 0, 22], [238, 2, 22], [240, 0, 35], [260, 0, 35]];
  const fits = corners.every((p) => {
    const s = project(p);
    return s !== null && s.x > 40 && s.x < box.width - 40 && s.y > 40 && s.y < box.height - 40;
  });
  if (!fits) await frameOn(page, corners);
}

/** A world point on the Scene view's picture (its own pixels), through its view-projection matrix (null: behind it). */
export async function sceneViewProjector(view: Locator): Promise<(p: V3) => { x: number; y: number } | null> {
  const m = JSON.parse((await view.getAttribute('data-view-proj'))!) as number[];
  const box = (await view.boundingBox())!;
  return ([x, y, z]) => {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return null;
    const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
    const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    return { x: ((nx + 1) / 2) * box.width, y: ((1 - ny) / 2) * box.height };
  };
}

/** The green hue (green's share of the brightness) of a reading: Scene view and Play compared on it. */
export const greenShare = (c: Rgb): number => c[1]! / (sum(c) + 1);

/** Expect Play's (or the export's) green to have the Scene view's hue on the receivers both see. */
export function expectSameGreen(scene: DecalJudgement, play: DecalJudgement, what: string): void {
  for (const k of ['terrain', 'blocks', 'prop'] as const) {
    expect(Math.abs(greenShare(scene.colours[k]) - greenShare(play.colours[k])), `${what}: ${k} Scene view ${scene.colours[k].map((v) => v.toFixed(0))}, ${play.colours[k].map((v) => v.toFixed(0))}`).toBeLessThan(0.1);
  }
}

/** How far a bare surface's colour may be from the Scene view's (levels a channel): SMAA there, TAAU in Play. */
const SAME_LIGHT_LEVELS = 4;

/**
 * The bare surfaces beside the marks (the terrain under the shadowed lamps, the bump's reference, the masked prop,
 * the wall's row) are lit alike in the Scene view and in `play`: the Scene view draws the game's lighting.
 */
export function expectSameLight(scene: DecalJudgement, play: DecalJudgement, what: string): void {
  for (const k of ['terrainClean', 'bumpClean', 'masked', 'wallClean'] as const) {
    const off = Math.max(...scene.colours[k].map((v, i) => Math.abs(v - play.colours[k][i]!)));
    expect(off, `${what}: ${k} Scene view ${scene.colours[k].map((v) => v.toFixed(0))}, ${play.colours[k].map((v) => v.toFixed(0))}`).toBeLessThanOrEqual(SAME_LIGHT_LEVELS);
  }
}

/** Where the Decal tool places: a projected mark on the bare terrain, a clipped one on a clean corner of the block tops (clipped decals skip terrain). */
export const TOOL_AT: V3 = [254, 0, 32];
export const TOOL_CLIPPED_AT: V3 = [248.45, 1, 25.55];
/** Where the editor first previews and places a decal: the box floor's top; its mark is read in the middle (the selected decal's grips stand round it). */
const TOOL_BOX_AT: V3 = [242, 0.1, 25];
const TOOL_BOX_READ: V3 = TOOL_BOX_AT;
/** Where their marks are read: inside each, off its middle (the selected decal's grips stand there in the Scene view). */
export const TOOL_READS: readonly V3[] = [[254.25, 0, 32.25], [248.7, 1, 25.8]];
/** Its stamps (Shift+click), on the bare terrain beside the first. */
const TOOL_STAMPS: readonly V3[] = [[255.8, 0, 33.6], [256.4, 0, 30.8]];
/** A scatter stroke's ends, on the bare terrain west of the decals. */
const SCATTER_FROM: V3 = [236.5, 0, 31];
const SCATTER_TO: V3 = [239.5, 0, 31];

type Query = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Shot = () => Promise<{ png: Buffer; read: (p: V3) => Rgb }>;
interface ToolState {
  mode: string;
  selectTool: string;
  preview: { position: number[]; rotation: number[]; decal: { size: number[]; material: string; mode?: string } } | null;
  target: string | null;
  grips: { turn: { x: number; y: number } | null; size: { x: number; y: number } | null } | null;
  stamps: number;
  placed: number;
  clippedPreview: boolean;
  selection: string[];
  stroke: { places: number; stored: number; first?: string; last?: string } | null;
}
interface ToolEntity {
  components: { transform: { position: number[]; rotation: number[] }; decal?: { size: number[]; material: string; mode?: string; opacity?: Record<string, number> } };
}

/** A vector turned by a quaternion [x, y, z, w]. */
function turned(q: readonly number[], v: V3): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const near = (a: readonly number[], b: readonly number[], tol: number): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= tol);

/**
 * Drive the decal editor over the decal scene: open it from the toolbar's
 * decal button (the whole scene drawn, only decals pickable); its decal atlas
 * lists the decal images on the pages Play will use (hover names one, a click
 * selects its decals) and Rebuild pages composes them, the Scene view then
 * drawing the decals from them; pick the green
 * mark in the palette (it also shows the trim sheet's decal cell's material),
 * preview and place one on a box floor that had none at load (both drawn with
 * the pointer kept still; undone), see the projected preview under the
 * pointer on the terrain, click to place (one createEntity),
 * turn it with the knob and scale it with the corner (each one command, each
 * undone), Shift+click two stamps (seeded turns and sizes; undone one step
 * each), scatter a stroke with the brush (one createEntities), box-select and
 * Delete it (one deleteEntity: one undo brings it back, one more takes the
 * stroke), then
 * select: a box round the placed decal, Shift+box to add the terrain's decal,
 * Ctrl+click to take it off and Shift+click to add it again, one opacity
 * edited on both (one setComponent, one undo), then a clipped placement on
 * the block tops. Two decals stay (the projected one and the clipped one):
 * their ids. `undo` is the editor's Edit → Undo; `selectOther` selects an
 * object away from them (after Done: the Hierarchy is under the editor).
 */
export async function driveDecalTool(page: Page, view: Locator, query: Query, undo: () => Promise<void>, selectOther: () => Promise<void>, shot: Shot, what: string): Promise<{ projected: string; clipped: string }> {
  const state = async (): Promise<ToolState | null> => {
    const a = await view.getAttribute('data-decal-tool');
    return a === null ? null : (JSON.parse(a) as ToolState);
  };
  const entity = async (id: string): Promise<ToolEntity | null> => {
    const r = await query('queryEntity', { entityId: id });
    return r['ok'] === false ? null : ((r as { entity: ToolEntity }).entity ?? null);
  };
  const greenAt = async (p: V3, message: string): Promise<number> => {
    const t0 = Date.now();
    let last: Rgb = [0, 0, 0];
    await expect.poll(async () => isDecalGreen((last = (await shot()).read(p))), { timeout: 15_000, intervals: [100], message }).toBe(true).catch((e: unknown) => {
      console.log(`decal editor ${what} (failed): ${message} read ${last.map((v) => v.toFixed(0)).join(',')}`);
      throw e;
    });
    return Date.now() - t0;
  };

  // The editor from the toolbar: the whole scene drawn, only decals pickable; its palette lists the decal materials and the sheet's cell.
  await page.getByRole('button', { name: 'decal', exact: true }).click();
  const mode = page.locator('section[data-edit-mode="decals"]');
  await expect(mode).toBeVisible();
  await expect.poll(async () => JSON.parse((await view.getAttribute('data-isolation')) || '{}') as { component?: string; context?: boolean }).toMatchObject({ component: 'decal', context: true });
  await expect(mode.getByLabel('isolation')).toContainText('decals pickable');
  const column = mode.getByLabel('edit mode settings');
  // At 1920 × 1080 no mode's settings column needs a scroll in its default state: the settings are docked panels.
  for (const tab of ['Scatter', 'Select', 'Place']) {
    await mode.getByRole('tab', { name: tab, exact: true }).click();
    const fill = await column.locator('.tl-editmode__column-body').evaluate((el) => ({ content: el.scrollHeight, shown: el.clientHeight }));
    expect(fill.content, `decal ${tab}: the column fits`).toBeLessThanOrEqual(fill.shown);
  }
  const panel = (id: string): Locator => mode.locator(`[data-panel="${id}"]`);

  // The decal atlas, a panel on the view's bottom edge (collapsed: its title bar says the pages): the decal pages Play
  // will use, every decal image on them (the green mark, the normal-only mark, the trim sheet's cell); hovering one
  // names it, a click selects its decals.
  const atlasPanel = panel('atlas');
  await expect(atlasPanel).toHaveAttribute('data-open', 'false');
  await expect(atlasPanel.locator('.tl-dpanel__badge')).toContainText(/page/);
  const toggleAtlas = async (open: boolean): Promise<void> => {
    if ((await atlasPanel.getAttribute('data-open')) !== String(open)) await atlasPanel.locator('.tl-dpanel__head').click();
    await expect(atlasPanel).toHaveAttribute('data-open', String(open));
  };
  await toggleAtlas(true);
  const drawer = mode.getByLabel('decal atlas', { exact: true });
  type AtlasMark = { size: number; pages: number; images: number; materials: number; gpuBytes: number; composed: boolean; preview: boolean; drawn: boolean };
  const atlasMark = async (): Promise<AtlasMark | null> => {
    const a = await drawer.getAttribute('data-atlas');
    return a === null ? null : (JSON.parse(a) as AtlasMark);
  };
  await expect.poll(async () => (await atlasMark())?.images ?? 0, { message: 'the decal atlas lists the decal images' }).toBe(3);
  const pages = drawer.getByRole('list', { name: 'decal pages' });
  for (const name of ['Green mark', 'Bump mark', 'Stain']) await expect(pages.getByRole('button', { name: `decal image ${name}` })).toBeVisible();
  await expect(drawer.getByLabel('atlas pages')).toContainText(String((await atlasMark())!.pages));
  const greenRect = pages.getByRole('button', { name: 'decal image Green mark' });
  await greenRect.hover();
  await expect(pages.locator('.tl-atlas__caption').filter({ hasText: 'Green mark' })).toHaveCount(1);
  await greenRect.click();
  await expect.poll(async () => (await state())?.selection.length ?? 0, { message: "a click on the green mark's image selects its decals" }).toBeGreaterThanOrEqual(5);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state())?.selection).toEqual([]);
  // Collapsed (its title bar stays) while the editor places on the box floor below.
  await toggleAtlas(false);
  await expect(pages).toBeHidden();
  const palette = column.getByRole('radiogroup', { name: 'decal palette', exact: true });
  await expect(palette.getByRole('radio', { name: 'decal Green mark' })).toBeVisible();
  // The trim sheet's cell, drawn by its decal material (Stain), as its part of the sheet's picture, under the sheet's
  // name: the palette groups pictures by where they come from (own images first), so two sheets' same-named cells read apart.
  await expect(palette.getByRole('radio', { name: 'decal Stain · Trim' })).toBeVisible();
  const groups = await palette.locator('.tl-palette__group').evaluateAll((els) => els.map((e) => e.textContent));
  expect([groups[0], groups.includes('Trim')]).toEqual(['Images', true]);
  await palette.getByRole('radio', { name: 'decal Green mark' }).click();
  await panel('placement').getByLabel('decal width', { exact: true }).fill('1.2');
  await panel('placement').getByLabel('decal width', { exact: true }).press('Enter');
  // The view moved into the editor: positions are read off it from here on.
  const box = (await view.boundingBox())!;
  const at = async (p: V3): Promise<{ x: number; y: number }> => {
    const s = (await sceneViewProjector(view))(p);
    expect(s, `${p.join(',')} on the Scene view`).not.toBeNull();
    return { x: box.x + s!.x, y: box.y + s!.y };
  };

  // The editor opens with no tool (Navigate): a click on a decal selects it, Esc lets it go; B arms Place.
  await expect.poll(async () => `${(await state())?.mode} ${(await state())?.selectTool}`).toBe('select navigate');
  const onTerrainDecal = await at([243, 0, 29]);
  await page.mouse.click(onTerrainDecal.x, onTerrainDecal.y);
  await expect.poll(async () => (await state())?.selection.length ?? 0, { message: 'Navigate: a click selects the decal under it' }).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state())?.selection).toEqual([]);
  await expect(mode).toBeVisible();
  await page.keyboard.press('b');
  await expect.poll(async () => (await state())?.mode).toBe('place');

  // On a box floor that had no decal at load: the preview and then the placed decal drawn with the pointer kept still
  // (the view draws on demand: nothing else asks for a frame); the placement undone.
  const b = await at(TOOL_BOX_AT);
  await page.mouse.move(b.x, b.y);
  await greenAt(TOOL_BOX_READ, 'the preview on the box floor drawn');
  await page.mouse.click(b.x, b.y);
  await expect.poll(async () => (await state())?.target ?? null, { message: 'the decal placed on the box floor' }).not.toBeNull();
  const onBox = (await state())!.target!;
  await greenAt(TOOL_BOX_READ, 'the decal placed on the box floor drawn');
  await undo();
  await expect.poll(async () => (await entity(onBox)) === null, { message: 'the box floor placement undone' }).toBe(true);

  // Rebuild pages: composed on the backend; the Scene view then draws the decals from them, as Play does.
  await toggleAtlas(true);
  await expect(pages).toBeVisible();
  // A cold atlas: preview pages first (drawn from at once), the pages themselves swapped in once composed.
  // The editor's request for the pages themselves is held until the preview shows (these few small pages compose in
  // well under a frame's worth of polling otherwise).
  let finalAsked: (() => Promise<void>) | null = null;
  const finalRoute = /\/content\/decal-pages$/;
  await page.route(finalRoute, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    finalAsked = () => route.continue();
  });
  // The atlas is cold unless the backend's Play build made ahead (after a file check, once the project was left alone
  // a second) composed the pages already: then Rebuild answers the pages themselves at once, with no preview.
  const rebuilt = Date.now();
  await drawer.getByRole('button', { name: 'Rebuild pages' }).click();
  let rebuildAnswer = '';
  await expect.poll(async () => { const m = await atlasMark(); return (rebuildAnswer = `${m?.composed} ${m?.preview} ${m?.drawn}`); }, { timeout: 30_000, message: 'the preview pages (or the pages composed ahead) drawn from' }).toMatch(/^true (true|false) true$/);
  const atlasPreviewMs = Date.now() - rebuilt;
  if (rebuildAnswer === 'true true true') {
    await expect(drawer.getByRole('status')).toContainText('Preview in');
    await expect.poll(() => finalAsked !== null, { message: 'the pages themselves asked for behind the preview' }).toBe(true);
    await finalAsked!();
    await page.unroute(finalRoute);
    await expect.poll(async () => { const m = await atlasMark(); return `${m?.composed} ${m?.preview} ${m?.drawn}`; }, { timeout: 30_000, message: 'the pages composed and drawn from' }).toBe('true false true');
    console.log(`decal atlas ${what}: preview pages drawn from ${atlasPreviewMs} ms after Rebuild, the pages ${Date.now() - rebuilt} ms (their request held until the preview showed)`);
    // The status times the wait for the pages from Rebuild, not the last request that found them composed.
    await expect(drawer.getByRole('status')).toContainText(/Preview in \d+ ms · the pages in [\d.]+ s/);
  } else {
    // Composed ahead: no preview, and no second request to hold (the backend's own test covers the cold preview).
    await page.unroute(finalRoute);
    expect(finalAsked, 'no request for the pages behind a preview').toBeNull();
    await expect(drawer.getByRole('status')).toContainText(/Made in \d+ ms/);
    console.log(`decal atlas ${what}: the pages were composed ahead (the Play build made ahead); drawn from ${atlasPreviewMs} ms after Rebuild`);
  }
  // The pages themselves on the GPU (their bytes the report's: the preview's smaller arrays let go), every set's in one array.
  const gpuBytes = (await atlasMark())!.gpuBytes;
  await expect.poll(async () => (await view.getAttribute('data-tl-decal-pages'))?.split('|').slice(2).join('|'), { timeout: 15_000, message: 'the composed page arrays on the GPU' }).toBe(`${gpuBytes}|1`);
  console.log(`decal atlas ${what}: ${JSON.stringify(await atlasMark())}; ${await drawer.getByRole('status').textContent()}; page arrays ${await view.getAttribute('data-tl-decal-pages')}`);
  if (process.env['TL_ATLAS_SHOT'] !== undefined) await page.screenshot({ path: `${process.env['TL_ATLAS_SHOT']}-${what}.png` });
  // The atlas collapsed (its title bar stays) for the steps below; the marks drawn from the pages.
  await toggleAtlas(false);
  await expect(pages).toBeHidden();
  await greenAt(DECAL_READS.terrain, 'the terrain decal drawn from the composed pages');

  // The projected preview under the pointer: facing up out of the terrain, drawn green before anything is stored.
  const p = await at(TOOL_AT);
  await page.mouse.move(p.x, p.y);
  await expect.poll(async () => {
    const s = await state();
    return s?.preview !== null && s?.preview !== undefined && near(s.preview.position, TOOL_AT, 0.05) && near(turned(s.preview.rotation, [0, 0, 1]), [0, 1, 0], 1e-3) && s.preview.decal.size[0] === 1.2;
  }, { message: 'the preview under the pointer' }).toBe(true);
  const previewMs = await greenAt(TOOL_AT, 'the projected preview drawn');
  expect((await state())!.placed).toBe(1);

  // A click places it: one createEntity, the new decal selected (its outline and grips shown).
  await page.mouse.click(p.x, p.y);
  // (The undone placement's id may come back: the new decal is known by where it is.)
  await expect.poll(async () => { const t = (await state())?.target ?? null; const e = t === null ? null : await entity(t); return e !== null && near(e.components.transform.position, TOOL_AT, 0.05); }, { message: 'the placed decal selected' }).toBe(true);
  const projected = (await state())!.target!;
  await expect.poll(async () => (await entity(projected))?.components.decal).toEqual({ size: [1.2, 1, 0.5], material: 'mat-pd-green' });
  const placedAt = (await entity(projected))!.components.transform;
  expect(near(placedAt.position, TOOL_AT, 0.05)).toBe(true);

  // The grips where the decal is: the knob up the image (toward −Z on a floor), the corner at +X and up the image.
  const r = 0.55 * Math.hypot(1.2, 1);
  const grip = async (kind: 'turn' | 'size', world: V3): Promise<{ x: number; y: number }> => {
    const want = await at(world);
    let got: { x: number; y: number } | null = null;
    await expect.poll(async () => {
      got = (await state())?.grips?.[kind] ?? null;
      return got !== null && Math.hypot(got.x - want.x, got.y - want.y) <= 3;
    }, { message: `the ${kind} grip at ${world.join(',')} (want ${want.x.toFixed(0)},${want.y.toFixed(0)})` }).toBe(true);
    return got!;
  };
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, mods: string[] = []): Promise<void> => {
    await page.mouse.move(from.x, from.y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
  };
  // Turn: the knob dragged to the decal's +X side turns it −90° about its normal.
  await drag(await grip('turn', [TOOL_AT[0], TOOL_AT[1], TOOL_AT[2] - r]), await at([TOOL_AT[0] + r, TOOL_AT[1], TOOL_AT[2]]));
  let rot: number[] = [];
  await expect.poll(async () => near(turned((rot = (await entity(projected))!.components.transform.rotation), [0, 1, 0]), [1, 0, 0], 0.01), { message: 'the decal turned' }).toBe(true).catch(async (e: unknown) => {
    console.log(`decal editor ${what} (failed): rotation ${JSON.stringify(rot)}, its image's top along ${turned(rot, [0, 1, 0]).map((v) => v.toFixed(2))}; tool ${JSON.stringify(await state())}; notice ${await page.locator('.tl-notice').allTextContents()}`);
    throw e;
  });
  await undo();
  await expect.poll(async () => near((await entity(projected))!.components.transform.rotation, placedAt.rotation, 1e-6), { message: 'the turn undone' }).toBe(true);

  // Scale: the corner (+X, up the image) dragged twice as far from the middle doubles the width and height (give or take
  // the pixels the grip is read in), not the depth.
  await drag(await grip('size', [TOOL_AT[0] + 0.6, TOOL_AT[1], TOOL_AT[2] - 0.5]), await at([TOOL_AT[0] + 1.2, TOOL_AT[1], TOOL_AT[2] - 1]));
  let size: number[] = [];
  await expect.poll(async () => ((size = (await entity(projected))!.components.decal!.size), Math.abs(size[0]! / 1.2 - 2) < 0.2 && Math.abs(size[0]! / 1.2 - size[1]!) < 0.01 && size[2] === 0.5), { message: 'the decal scaled' }).toBe(true).catch(async (e: unknown) => {
    console.log(`decal editor ${what} (failed): size ${JSON.stringify(size)}; tool ${JSON.stringify(await state())}; notice ${await page.locator('.tl-notice').allTextContents()}`);
    throw e;
  });
  await undo();
  await expect.poll(async () => (await entity(projected))!.components.decal!.size, { message: 'the scale undone' }).toEqual([1.2, 1, 0.5]);
  // The selected decal's ring (read against the picture once Esc has cleared the selection).
  await page.mouse.move(box.x + 20, box.y + box.height - 20);
  await page.waitForTimeout(250);
  const withRing = decodePng((await shot()).png);
  const ringAt = await Promise.all(Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2).map(async (t) => (await sceneViewProjector(view))([TOOL_AT[0] + r * Math.cos(t), TOOL_AT[1], TOOL_AT[2] + r * Math.sin(t)])));

  // Stamps: Shift+click twice; each a decal of its own with a seeded turn and a size between 0.75 and 1.25 of the tool's.
  const stamps: string[] = [];
  await page.keyboard.down('Shift');
  for (const [i, q] of TOOL_STAMPS.entries()) {
    const s = await at(q);
    await page.mouse.click(s.x, s.y);
    await expect.poll(async () => (await state())?.stamps).toBe(i + 1);
    await expect.poll(async () => (await state())?.target ?? projected).not.toBe(stamps[i - 1] ?? projected);
    stamps.push((await state())!.target!);
  }
  await page.keyboard.up('Shift');
  const made = await Promise.all(stamps.map(async (id) => (await entity(id))!.components));
  for (const c of made) {
    const k = c.decal!.size[0]! / 1.2;
    expect(k).toBeGreaterThanOrEqual(0.749);
    expect(k).toBeLessThanOrEqual(1.251);
    expect(c.decal!.size[1]! / 1).toBeCloseTo(k, 2);
    expect(c.decal!.size[2]).toBe(0.5);
  }
  expect(made[0]!.decal!.size).not.toEqual(made[1]!.decal!.size);
  expect(near(made[0]!.transform.rotation, made[1]!.transform.rotation, 1e-3)).toBe(false);
  // One undo step each: the second stamp goes, then the first; the first decal stays.
  await undo();
  await expect.poll(async () => (await entity(stamps[1]!)) === null, { message: 'the second stamp undone' }).toBe(true);
  expect(await entity(stamps[0]!)).not.toBeNull();
  await undo();
  await expect.poll(async () => (await entity(stamps[0]!)) === null, { message: 'the first stamp undone' }).toBe(true);
  expect(await entity(projected)).not.toBeNull();

  // Scatter: a stroke of the shared brush over bare terrain lays decals at the density, stored as one createEntities; one undo takes them all.
  await mode.getByRole('tab', { name: 'Scatter' }).click();
  await panel('brush').getByLabel('brush size', { exact: true }).fill('2');
  await panel('brush').getByLabel('brush size', { exact: true }).press('Enter');
  await panel('scatter').getByLabel('decal scatter density', { exact: true }).fill('2');
  await panel('scatter').getByLabel('decal scatter density', { exact: true }).press('Enter');
  await drag(await at(SCATTER_FROM), await at(SCATTER_TO));
  let stroke: ToolState['stroke'] = null;
  await expect.poll(async () => ((stroke = (await state())?.stroke ?? null), stroke !== null && stroke.stored > 0 && stroke.stored === stroke.places), { message: 'the scatter stroke stored' }).toBe(true);
  const scattered = stroke as unknown as NonNullable<ToolState['stroke']>;
  expect(scattered.places).toBeGreaterThanOrEqual(4);
  const first = (await entity(scattered.first!))!.components;
  expect(first.decal!.material).toBe('mat-pd-green');
  expect(first.transform.position[0]!).toBeGreaterThan(SCATTER_FROM[0] - 1.5);
  expect(first.transform.position[0]!).toBeLessThan(SCATTER_TO[0] + 1.5);
  // Delete: the stroke's decals box-selected and deleted in one command (one undo brings them all back).
  // The box may take a decal beside the stroke too: it comes back with the undo.
  await mode.getByRole('tab', { name: 'Select' }).click();
  await armTile(column.getByRole('toolbar', { name: 'decal select tool' }).getByRole('button', { name: 'Box', exact: true }));
  // The box round the stroke's ground on the picture (the four corners' extent: the view looks at it slanted).
  const corners = await Promise.all([[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]].map(([dx, dz]) => at([(dx! < 0 ? SCATTER_FROM[0] : SCATTER_TO[0]) + dx!, 0, SCATTER_FROM[2] + dz!])));
  await drag({ x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) }, { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) });
  await expect.poll(async () => { const sel = (await state())?.selection ?? []; return sel.includes(scattered.first!) && sel.includes(scattered.last!) && sel.length >= scattered.places; }, { message: 'the box selects the stroke' }).toBe(true);
  await page.keyboard.press('Delete');
  await expect.poll(async () => `${(await entity(scattered.first!)) === null} ${(await entity(scattered.last!)) === null}`, { message: 'Delete takes the selection' }).toBe('true true');
  await undo();
  await expect.poll(async () => `${(await entity(scattered.first!)) === null} ${(await entity(scattered.last!)) === null}`, { message: 'one undo brings the deleted decals back' }).toBe('false false');
  await undo();
  await expect.poll(async () => `${(await entity(scattered.first!)) === null} ${(await entity(scattered.last!)) === null}`, { message: 'one undo takes the stroke' }).toBe('true true');

  // Select: the Box tool picks the decals whose middle is in the box (Shift adds); Ctrl+click takes one off, Shift+click adds it.
  await mode.getByRole('tab', { name: 'Select' }).click();
  await armTile(column.getByRole('toolbar', { name: 'decal select tool' }).getByRole('button', { name: 'Box', exact: true }));
  const around = async (c: V3, k = 0.4): Promise<[{ x: number; y: number }, { x: number; y: number }]> => [await at([c[0] - k, c[1], c[2] - k]), await at([c[0] + k, c[1], c[2] + k])];
  await drag(...(await around(TOOL_AT)));
  await expect.poll(async () => (await state())?.selection, { message: 'the box selects the placed decal' }).toEqual([projected]);
  const terrainAt: V3 = [243, 0, 29];
  await drag(...(await around(terrainAt)), ['Shift']);
  await expect.poll(async () => (await state())?.selection.length, { message: 'Shift+box adds the terrain decal' }).toBe(2);
  const other = (await state())!.selection.find((id) => id !== projected)!;
  // No tool (Navigate): a click picks.
  await armTile(column.getByRole('toolbar', { name: 'decal select tool' }).getByRole('button', { name: 'Navigate', exact: true }));
  const t = await at(terrainAt);
  await page.keyboard.down('Control');
  await page.mouse.click(t.x, t.y);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await state())?.selection, { message: 'Ctrl+click takes it off' }).toEqual([projected]);
  await page.keyboard.down('Shift');
  await page.mouse.click(t.x, t.y);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await state())?.selection, { message: 'Shift+click adds it again' }).toEqual([projected, other]);
  // The selection's fields are its panel's (shown while decals are selected).
  const selection = panel('selection');
  await expect(selection.getByLabel('selected decals')).toContainText('2 decals selected');
  // One field on both: one setComponent (one undo puts both back); the sizes differ, so it says "mixed" where they do.
  await expect(selection.getByLabel('selection width', { exact: true })).toHaveValue('mixed');
  await selection.getByLabel('selection opacity albedo', { exact: true }).fill('40');
  await selection.getByLabel('selection opacity albedo', { exact: true }).press('Enter');
  await expect.poll(async () => [(await entity(projected))!.components.decal!.opacity?.albedo, (await entity(other))!.components.decal!.opacity?.albedo], { message: 'the opacity set on both' }).toEqual([0.4, 0.4]);
  await undo();
  await expect.poll(async () => [(await entity(projected))!.components.decal!.opacity, (await entity(other))!.components.decal!.opacity], { message: 'one undo puts both back' }).toEqual([undefined, undefined]);
  // Esc clears the selection before it drops a tool or leaves the editor: the ring goes (read against the picture with it, the view unmoved).
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state())?.selection).toEqual([]);
  await expect(mode).toBeVisible();
  await page.mouse.move(box.x + 20, box.y + box.height - 20);
  await page.waitForTimeout(250);
  const ringSeen = ringOn(withRing, decodePng((await shot()).png), ringAt);
  expect(ringSeen, `the decal ring drawn (${what}): ${ringSeen} of ${ringAt.length} points`).toBeGreaterThanOrEqual(16);

  // Clipped: the preview is a mesh cut from the block tops under the pointer, drawn at once; a click places it.
  await mode.getByRole('tab', { name: 'Place' }).click();
  await armTile(column.getByRole('toolbar', { name: 'decal place tool' }).getByRole('button', { name: 'Place', exact: true }));
  await panel('placement').getByRole('radio', { name: 'Clipped' }).click();
  const c = await at(TOOL_CLIPPED_AT);
  const hovered = Date.now();
  await page.mouse.move(c.x, c.y);
  await expect.poll(async () => (await state())?.clippedPreview ?? false, { message: 'the clipped preview cut' }).toBe(true);
  const clippedMs = Date.now() - hovered;
  await greenAt(TOOL_CLIPPED_AT, 'the clipped preview drawn');
  await page.mouse.click(c.x, c.y);
  await expect.poll(async () => {
    const id = (await state())?.target ?? null;
    return id === null || id === projected ? null : ((await entity(id))?.components.decal?.mode ?? null);
  }, { message: 'the clipped decal placed' }).toBe('clipped');
  const clipped = (await state())!.target!;
  // Away from the decals (empty sky: no preview), the editor closed with Done and another object selected (the
  // selected decal's grips stand over its mark): both stored marks drawn.
  await page.mouse.move(box.x + 20, box.y + box.height - 20);
  await expect.poll(async () => (await state())?.preview ?? null).toBeNull();
  await panel('placement').getByRole('radio', { name: 'Projected' }).click();
  await mode.getByRole('button', { name: /Done/ }).click();
  await expect(mode).toBeHidden();
  await expect.poll(async () => view.getAttribute('data-decal-tool')).toBeNull();
  await selectOther();
  await greenAt(TOOL_READS[0]!, 'the placed projected decal');
  await greenAt(TOOL_READS[1]!, 'the placed clipped decal');
  console.log(`decal editor ${what}: projected preview drawn ${previewMs} ms after the pointer came; clipped preview cut ${clippedMs} ms after; a scatter stroke laid ${scattered.places} decals`);
  return { projected, clipped };
}

/** How many of the ring's points show its blue (changed from the picture without it) within 3 px. */
function ringOn(withRing: Image, without: Image, points: readonly ({ x: number; y: number } | null)[]): number {
  let seen = 0;
  for (const p of points) {
    if (p === null) continue;
    let hit = false;
    for (let y = Math.round(p.y) - 3; y <= Math.round(p.y) + 3 && !hit; y++)
      for (let x = Math.round(p.x) - 3; x <= Math.round(p.x) + 3 && !hit; x++) {
        if (x < 0 || y < 0 || x >= withRing.width || y >= withRing.height) continue;
        const [r1, g1, b1] = withRing.pixel(x, y);
        const [r0, g0, b0] = without.pixel(x, y);
        hit = Math.abs(r1 - r0) + Math.abs(g1 - g0) + Math.abs(b1 - b0) > 60 && b1 > r1 + 60;
      }
    if (hit) seen += 1;
  }
  return seen;
}

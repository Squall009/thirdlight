/**
 * Projected decals on every kind of receiver (shared by the layered-material
 * spec, whose trim sheet, backend, Play session and export they are read
 * with).
 *
 * Behind the main camera (it never sees them), on one flat terrain tile:
 * a block layer's tops, a prop (a grey model), a second prop in decal layer
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
 * point; the Scene view's green must have Play's hue.
 *
 * Clipped decals (the same green, in `clipped` mode): one across the block
 * layer's front edge (tilted 45°, so it marks the top and the front face
 * at once) and one on the generated wall. Their meshes are clipped from the
 * block chunk and the wall's chunk on the generator workers. In the Scene
 * view a block under the edge mark is taken away: the chunk re-meshes and
 * the mark is clipped again, gone where the block was (a stale mesh would
 * hang in the air) and still on the block beside it; Play and the export
 * draw it so too. The wall's clipped decal is then baked to a model (the
 * Inspector's "Bake to model"): a model asset of the same mark, drawn as a
 * mesh decal where the decal was.
 *
 * Change while the game runs: a green decal carried by a mover goes 2.4 m
 * along the terrain once Play starts (Play shows it where it went, not
 * where it was placed), and the key's script spawns a decal from a prefab
 * (`ctx.decals.spawn`) beside it; the key again removes the spawn, which
 * fades out.
 */
import { multiPieceGlb } from './multi-piece-glb';
import { makePng } from './png-make';
import { expect, type Locator, type Page } from './pw';
import { frameOn } from './rooms-drawing';

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
  { name: 'Normal-only decal', at: [247, 0, 33] as V3, size: [2.4, 2.4, 2], rotation: DOWN, material: 'mat-pd-bump', opacity: { albedo: 0 } },
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
  const wall = await create('Decal wall', [0, 0, 0]);
  // Swept along +X, a profile drawn up faces right of travel: +Z, toward the decal camera.
  await cmd('setComponent', { entityId: wall, component: 'architecture', value: { profiles: { face: { points: [[0, 0], [0, 2]], slots: ['lower_wall'] } }, elements: [{ id: 'wall', kind: 'sweep', path: { points: [[238, 0, WALL_Z], [262, 0, WALL_Z]] }, profile: 'face' }] } });
  await cmd('setComponent', { entityId: wall, component: 'materials', value: { '*': trimId } });

  // The decal materials: a green image; the tilted normal map alone.
  await publish.texture(new Uint8Array(makePng(64, 64, () => [40, 200, 60, 255])), 'pd-green');
  await cmd('setMaterial', { material: { materialId: 'mat-pd-green', name: 'Green mark', shader: 'decal', params: {}, textures: { map: 'pd-green' } } });
  await cmd('setMaterial', { material: { materialId: 'mat-pd-bump', name: 'Bump mark', shader: 'decal', params: {}, textures: { normalMap: 'tilt' } } });
  for (const d of DECALS) {
    const decal = { size: [...d.size], material: d.material, ...('layers' in d ? { layers: d.layers } : {}), ...('opacity' in d ? { opacity: d.opacity } : {}) };
    await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: d.name, transform: { position: [...d.at], rotation: [...d.rotation] }, components: { decal } });
  }
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
 * 8 % or more; 15 % on this host) but not its colour.
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

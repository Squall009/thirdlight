/**
 * The 3D starter template: 3D physics, the starter's character with the
 * controller on a spawn point, a follow / orbit camera, a sun and a gradient
 * sky, a ground block layer on the Basic Kit, and a small terrain beside it
 * wearing a layered ground material (grass, soil, rock by slope). No game
 * rules.
 *
 * What a new project gets comes from three places, so nothing is copied:
 * - `captured/project.json` (a v3 project, authored through the real
 *   editing path, `templates/tools/author.mts`): the 3D settings, the
 *   character (its file and publish command taken from the 2D starter), the
 *   player, its spawn and the lights;
 * - `template.json` `packs: ["basic-kit"]`: the engine's Basic Kit, added
 *   from `packs/basic-kit/pack.json` when the project is made, so the
 *   template always has the kit as the engine ships it;
 * - `setup/pack.json` (a pack: its ground textures and ordinary commands,
 *   run after the kit): the scene's look, the block layer and its blocks,
 *   the terrain, its material and sculpting, and the camera.
 *
 * The script (1) encodes the ground textures to KTX2 from the Texture
 * Designer's PNGs when a folder of them is given (`--textures <dir>`, holding
 * `starter3d_{grass,soil,rock}_{albedo_height,normal,orm}.png`; the KTX2
 * files are kept in the repository, the PNGs are not), (2) captures the base
 * project and (3) writes the setup pack. Re-running it gives the same bytes.
 *
 * Run (from the repository root):
 *   npx esbuild templates/starter-3d/tools/build-template.mts --bundle --platform=node \
 *     --format=esm --external:ktx2-encoder --outfile=node_modules/.cache/tl-starter-3d.mjs \
 *     && node node_modules/.cache/tl-starter-3d.mjs [--textures <dir>]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import * as ktx2 from 'ktx2-encoder';
import { LAYERED_TEXTURES, layeredMaterial, type MaterialDef } from '@thirdlight/project-model';
import { decodePngRgba } from '@thirdlight/project-model/png';

import { capture, newAuthor, run } from '../../tools/author.mts';

// Bundled elsewhere, so the folders come from the working directory (the repo root).
const ROOT = resolve('templates', 'starter-3d');
const STARTER = resolve('templates', 'starter');
const PROJECT_ID = 'starter-3d';
const IMPORTED_AT = '2026-10-13T00:00:00Z';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* ---------------------------------------------------------- textures --- */

/** The ground's layers in the material's order: 0 what the rules leave, 1 patches, 2 the slopes. */
const LAYERS = [
  { key: 'grass', name: 'Grass', graph: 'shared/mat_ground_grass', tiling: 3 },
  { key: 'soil', name: 'Soil', graph: 'shared/mat_ground_soil', tiling: 3 },
  { key: 'rock', name: 'Rock', graph: 'shared/mat_stone_cliff', tiling: 6 },
] as const;

const MAPS = [
  // Albedo in sRGB with the height in A, and ORM: ETC1S keeps them small (the engine's colour encoding).
  { suffix: 'albedo_height', id: 'albedo', key: LAYERED_TEXTURES.albedo, label: 'albedo + height', mode: 'color' },
  // A normal map needs UASTC's precision.
  { suffix: 'normal', id: 'normal', key: LAYERED_TEXTURES.normals, label: 'normal', mode: 'normal' },
  { suffix: 'orm', id: 'orm', key: LAYERED_TEXTURES.orm, label: 'occlusion, roughness, metalness', mode: 'data' },
] as const;

const textureId = (layer: string, map: string): string => `ground-${layer}-${map}`;
const textureFile = (layer: string, map: string): string => `textures/ground-${layer}-${map}.ktx2`;

async function encodeTextures(dir: string): Promise<void> {
  mkdirSync(join(ROOT, 'setup', 'assets', 'textures'), { recursive: true });
  for (const l of LAYERS) {
    for (const m of MAPS) {
      const png = `starter3d_${l.key}_${m.suffix}.png`;
      const r = decodePngRgba(new Uint8Array(readFileSync(join(dir, png))), { maxPixels: 4096 * 4096, inflate: (d, max) => new Uint8Array(inflateSync(d, { maxOutputLength: max })) });
      if (!r.ok) throw new Error(`${png}: ${r.message}`);
      const { width, height, rgba } = r.png;
      const colour = m.mode === 'color';
      const uastc = m.mode === 'normal';
      const out = await ktx2.encodeToKTX2(new Uint8Array(0), {
        imageDecoder: async () => ({ width, height, data: rgba }),
        isUASTC: uastc,
        generateMipmap: true,
        isKTX2File: true,
        isNormalMap: uastc,
        isPerceptual: colour,
        isSetKTX2SRGBTransferFunc: colour,
        ...(uastc ? { needSupercompression: true, enableRDO: true, rdoQualityLevel: 4 } : { qualityLevel: colour ? 128 : 255 }),
        enableDebug: false,
      });
      writeFileSync(join(ROOT, 'setup', 'assets', textureFile(l.key, m.id)), out);
      console.log(`  ${textureFile(l.key, m.id)}: ${width}×${height}, ${out.byteLength} B`);
    }
  }
}

/** The ground material: the layered surface template with the three layers' textures in its arrays, named and tiled. */
function groundMaterial(): MaterialDef {
  const m = layeredMaterial('starter-ground', 'Ground');
  const parameters = (m.parameters ?? []).map((p) => {
    const map = MAPS.find((x) => x.key === p.key);
    if (map !== undefined && p.type === 'texture') return { ...p, default: [...LAYERS.map((l) => textureId(l.key, map.id)), ''] };
    if (p.key === 'layerTiling') return { ...p, default: [...LAYERS.map((l) => l.tiling), 1] };
    return p;
  });
  return { ...m, parameters, layerNames: LAYERS.map((l) => l.name) };
}

/* ------------------------------------------------------------- scene --- */

const T = (x: number, y: number, z: number): Record<string, unknown> => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** The block layer: 24 × 24 cells of a metre, its ground row's tops at y = 0, centred on the origin. */
const LAYER = { size: 24, height: 6 } as const;
/** The terrain: one tile of 65 samples a metre apart (64 m square), east of the block ground, flat at 0 where they meet. */
const TERRAIN = { samples: 65, x: LAYER.size / 2, z: -32 } as const;

function captureBase(): string {
  // The character: the 2D starter's file and publish command (one character for both starters).
  const recipe = JSON.parse(readFileSync(join(STARTER, 'recipe', 'commands.json'), 'utf8')) as { commands: { op: string; args: Record<string, unknown> }[] };
  const publish = recipe.commands.find((c) => c.op === 'publishAsset' && c.args['assetId'] === 'starter-character');
  if (publish === undefined) throw new Error('the starter recipe publishes no starter-character');
  mkdirSync(join(ROOT, 'assets', 'model'), { recursive: true });
  copyFileSync(join(STARTER, 'assets', 'model', 'character.glb'), join(ROOT, 'assets', 'model', 'character.glb'));

  const author = newAuthor(PROJECT_ID, [0, 6, 12], { physics_dimension: 3 });
  run(author, 'publishAsset', publish.args);
  // The controller's capsule centre stands 0.91 m up (the character's origin): its feet on the ground blocks' tops.
  const player = run(author, 'createEntity', {
    kind: 'model',
    name: 'Player',
    transform: T(0, 0.91, 0),
    model: { asset: { assetId: 'starter-character' } },
    components: {
      controller: {},
      modelAnimation: {
        assetId: 'starter-character',
        version: 1,
        roles: { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Airborne' } },
      },
    },
  });
  run(author, 'createEntity', { kind: 'group', name: 'Spawn', transform: T(0, 0.91, 0), components: { playerSpawn: {} } });
  // The sun: the gradient sky's light, low enough for long shadows across the blocks.
  run(author, 'createEntity', { kind: 'group', name: 'Sun', transform: T(0, 20, 0), components: { light: { type: 'directional', color: '#fff1dc', intensity: 2.2, direction: [-0.45, -0.75, -0.5], castShadow: true } } });
  run(author, 'createEntity', { kind: 'group', name: 'Sky fill', transform: T(0, 0, 0), components: { light: { type: 'ambient', color: '#9fb4d8', intensity: 0.35 } } });
  capture(author, ROOT, 'templates/starter-3d/tools/build-template.mts', IMPORTED_AT);
  const id = (player as { createdId?: string }).createdId;
  if (id === undefined) throw new Error('the player was not made');
  return id;
}

/** The setup's commands (run after the Basic Kit is added; `$ref:<name>` is the object made under `ref`). */
function setupCommands(playerId: string): { op: string; args: Record<string, unknown>; ref?: string }[] {
  const n = LAYER.size;
  const half = n / 2;
  const cell = (block: string): Record<string, unknown> => ({ block });
  return [
    // A day sky: blue overhead, pale at the horizon, the ground's colour below it.
    {
      op: 'setEnvironment',
      args: {
        sceneId: 'scene-main',
        environment: {
          sky: { mode: 'gradient', topColor: '#2f63b0', horizonColor: '#bfd3e8', bottomColor: '#6d7563', environmentIntensity: 0.6 },
          fog: { mode: 'exp2', color: '#bfd3e8', density: 0.0015 },
        },
      },
    },
    // The ground: a block layer on the Basic Kit, its first row of cells under y = 0.
    { op: 'createEntity', ref: 'blocks', args: { sceneId: 'scene-main', kind: 'group', name: 'Ground blocks', transform: T(-half, -1, -half), components: { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [n, LAYER.height, n] }, kitId: 'basic-kit' } } } },
    {
      op: 'editBlocks',
      args: {
        entityId: '$ref:blocks',
        edits: [
          { kind: 'fill', box: [0, 0, 0, n, 1, n], cell: cell('basic-ground') },
          // A few of the kit's blocks to walk on and around: a wall, a raised half step, stairs and a ramp up to a slab.
          { kind: 'fill', box: [4, 1, 17, 11, 4, 18], cell: cell('basic-wall') },
          { kind: 'fill', box: [15, 1, 5, 18, 2, 8], cell: cell('basic-half') },
          { kind: 'fill', box: [15, 1, 12, 18, 2, 13], cell: cell('basic-stairs') },
          { kind: 'fill', box: [15, 1, 13, 18, 2, 16], cell: cell('basic-slab') },
        ],
      },
    },
    // The terrain: one 64 m tile east of the blocks.
    { op: 'createEntity', ref: 'terrain', args: { sceneId: 'scene-main', kind: 'group', name: 'Terrain', transform: T(TERRAIN.x, 0, TERRAIN.z), components: { terrain: { tileSamples: TERRAIN.samples, spacing: 1, heightRange: [-16, 48], tiles: [{ x: 0, z: 0 }] } } } },
    { op: 'setMaterial', args: { material: groundMaterial(), assign: { entityId: '$ref:terrain' } } },
    // Hills ahead and to the right of the camera's start, a soft bump nearer, small noise over all of it; flat where it meets the blocks.
    { op: 'editTerrain', args: { entityId: '$ref:terrain', kind: 'raise', dabs: [[36, -22], [46, -6], [34, 12]], radius: 12, strength: 7, falloff: 'smooth' } },
    { op: 'editTerrain', args: { entityId: '$ref:terrain', kind: 'raise', dabs: [[23, -12]], radius: 6, strength: 2, falloff: 'smooth' } },
    { op: 'editTerrain', args: { entityId: '$ref:terrain', kind: 'noise', dabs: [[44, 0]], radius: 40, strength: 0.6, scale: 9, seed: 3, falloff: 'smooth' } },
    // Rock on the slopes, soil in patches; grass where neither applies.
    {
      op: 'editTerrain',
      args: {
        entityId: '$ref:terrain',
        kind: 'bake',
        rules: [
          { name: 'Soil in patches', layer: 1, noise: { min: 0.62, fade: 0.08, scale: 14, seed: 7 } },
          { name: 'Rock on slopes', layer: 2, slope: { min: 24, fade: 6 } },
        ],
      },
    },
    // The camera: follows and orbits the player.
    { op: 'createEntity', args: { sceneId: 'scene-main', kind: 'group', name: 'Follow camera', transform: T(0, 4, 9), components: { virtualCamera: { rig: 'follow', target: playerId, targetOffset: [0, 1.2, 0], distance: 8, pitch: 18, damping: 0.15, priority: 10 } } } },
  ];
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--textures');
  if (at >= 0) await encodeTextures(resolve(process.argv[at + 1] ?? '.'));
  const playerId = captureBase();
  const assets = LAYERS.flatMap((l) =>
    MAPS.map((m) => {
      const bytes = new Uint8Array(readFileSync(join(ROOT, 'setup', 'assets', textureFile(l.key, m.id))));
      return { assetId: textureId(l.key, m.id), kind: 'texture', displayName: `Ground ${l.name.toLowerCase()}: ${m.label}`, file: textureFile(l.key, m.id), sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    }),
  );
  const pack = {
    format: 1,
    packId: PROJECT_ID,
    name: '3D starter setup',
    description: 'What the 3D starter makes by commands once a project exists: the scene’s sky, the block ground, the terrain and its material, the camera.',
    source: { designer: 'art-factory Texture Designer', graphs: LAYERS.map((l) => l.graph), size: 512, packing: 'albedo + height in A, normal, ORM (a shared packing of the designer)', note: 'Original content rendered from the shared library graphs (no downloaded or third-party textures).' },
    folder: 'assets/ground',
    assets,
    commands: setupCommands(playerId),
  };
  writeFileSync(join(ROOT, 'setup', 'pack.json'), `${JSON.stringify(pack, null, 1)}\n`);
  console.log(`setup: ${assets.length} textures (${assets.reduce((s, a) => s + a.bytes, 0)} B), ${pack.commands.length} commands`);
}

void main();

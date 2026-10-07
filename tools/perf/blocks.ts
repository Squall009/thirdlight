/**
 * The blocks perf class: a block-heavy level — what meshing costs and where it
 * hitches. Deterministic (generated files, no game content).
 *
 * - One block layer of 128 × 128 columns (64 chunks), 1 m × 0.5 m cells,
 *   rolling sloped ground (every top cell's four corners set by `surface`
 *   edits), smoothed tops (crease 40°) cut 2 × 2: the most expensive chunks
 *   to mesh.
 * - Two stand-in block types (soil with two colour variants, rock) and a kit
 *   block type drawing a model piece with `_LOD` levels (a scatter kit file):
 *   the layer meshes again when the model arrives.
 * - A script that, with `stream` on, writes a cell every other step (a hole
 *   dug and filled again along a diagonal, crossing chunk edges): a game's
 *   runtime grid writes.
 * - A shadowed sun, a camera over the ground; 3D physics (the layer collides).
 *
 * `buildBlocks` applies it through the real command API, like the village.
 */
import { publishBehaviorVia, publishFileVia } from './build';
import type { PerfBackend } from './backend';
import type { BehaviorPlan } from './generate';
import { scatterKitGlb } from './village-assets';

/** Bump when the generated content changes. */
export const BLOCKS_VERSION = 1;
export const BLOCKS_SEED = 51;
/** Columns per side (64 chunks of 16 × 16). */
const SIDE = 128;
const CELL_HEIGHT = 0.5;
const KIT_ASSET = 'blocks-kit';
/** A second kit file, used by no block until the kit type switches to it (a model arriving while the level is open). */
const KIT_ASSET_LATER = 'blocks-kit-later';
const STREAM_BEHAVIOR = 'blocks-grid-stream';
const STARTER_REMOVED = ['model-0001', 'spawn-0001', 'box-0001', 'box-0002', 'box-0003', 'box-0004', 'model-0002'];

/** Writes a cell every other step while `stream` is on: the top of a column dug out, then put back, walking a diagonal. */
const STREAM: BehaviorPlan = {
  behaviorId: STREAM_BEHAVIOR,
  displayName: 'Grid write stream',
  ownedTransforms: [],
  declaration: { properties: [{ key: 'stream', label: 'Write cells', type: 'boolean', default: false }] },
  source: [
    'export default {',
    '  instantiate() { return {}; },',
    '  step(state: unknown, ctx: any) {',
    "    if (ctx.phase !== 'intent' || ctx.properties.stream !== true || ctx.stepIndex % 2 !== 0) return;",
    '    const layer = ctx.grid.layers()[0];',
    '    if (layer === undefined) return;',
    '    const i = ctx.stepIndex / 2;',
    '    // Two writes per column (out, back in): the next column every fourth step, 1 to 2 chunks touched per write.',
    `    const k = Math.floor(i / 2) % ${SIDE - 16};`,
    '    const x = 8 + k;',
    `    const z = 8 + ((k * 7) % ${SIDE - 16});`,
    '    const top = ctx.grid.columnTop(layer, x, z);',
    '    if (top === null) return;',
    "    if (i % 2 === 0) ctx.grid.clear(layer, x, top, z);",
    "    // Rock and soil by turns on each pass, so a column dug out and filled in one frame still changes.",
    `    else ctx.grid.set(layer, x, top + 1, z, { block: Math.floor(i / 2 / ${SIDE - 16}) % 2 === 0 ? 'rock' : 'soil' });`,
    '  },',
    '};',
    '',
  ].join('\n'),
};

/** Ground height (rows) at a column corner: two octaves of waves, quantised to 1/16 row (as an editor brush leaves it). */
const heightAt = (x: number, z: number): number => Math.round((10 + 4 * Math.sin(x / 9) * Math.cos(z / 11) + 2 * Math.sin(x / 4.3 + z / 5.1)) * 16) / 16;

/** The `surface` edits: every column's four corners (rows), in edits of at most `perEdit` columns (a command is at most 64 KiB). */
export function blocksSurfaceEdits(perEdit = 4096): Record<string, unknown>[] {
  const edits: Record<string, unknown>[] = [];
  let cols: number[] = [];
  for (let x = 0; x < SIDE; x++) {
    for (let z = 0; z < SIDE; z++) {
      cols.push(x, z, heightAt(x, z), heightAt(x + 1, z), heightAt(x + 1, z + 1), heightAt(x, z + 1));
      if (cols.length / 6 >= perEdit) {
        edits.push({ kind: 'surface', columns: cols, cell: { block: 'soil' } });
        cols = [];
      }
    }
  }
  if (cols.length > 0) edits.push({ kind: 'surface', columns: cols, cell: { block: 'soil' } });
  return edits;
}

export interface BlocksBuild {
  projectId: string;
  layerId: string;
  streamEntity: string;
  ms: number;
}

/** The blocks layer's component as built (a rules change keeps the rest). */
const GROUND_LAYER = { cellSize: [1, CELL_HEIGHT, 1], bounds: { min: [0, 0, 0], max: [SIDE, 32, SIDE] }, maxSlope: 60, smoothAngle: 40, topSubdivision: 2 };

/** Build the blocks class into a new project through the backend's command API. */
export async function buildBlocks(be: PerfBackend, projectId: string, log: (s: string) => void = () => undefined): Promise<BlocksBuild> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: 'Perf blocks' });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  const cmd = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => p.command(op, args);
  for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await publishFileVia(be, projectId, cmd, { assetId: KIT_ASSET, kind: 'model', displayName: 'Blocks kit', bytes: scatterKitGlb(BLOCKS_SEED, ['stone', 'shrub']) });
  await publishFileVia(be, projectId, cmd, { assetId: KIT_ASSET_LATER, kind: 'model', displayName: 'Blocks kit (later)', bytes: scatterKitGlb(BLOCKS_SEED + 1, ['stone', 'shrub']) });
  await publishBehaviorVia(be, p, cmd, STREAM);
  await cmd('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: '#6f8a4a' }, { color: '#7a9050' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'rock', name: 'Rock', variants: [{ color: '#8a8580' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'kit', name: 'Kit stone', variants: [{ model: { assetId: KIT_ASSET, piece: 'stone' } }], shape: 'full' } });
  await cmd('pasteEntities', {
    sceneId: 'scene-main',
    entities: [
      { id: 'ground', name: 'Ground', components: { transform: { position: [-SIDE / 2, 0, -SIDE / 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { ...GROUND_LAYER } } },
      { id: 'stream', name: 'Grid stream', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, behavior: { behaviorId: STREAM_BEHAVIOR, values: { stream: false } } } },
    ],
  });
  // Pasted objects get fresh ids: found by what they hold.
  const listed = (await p.query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const layerId = listed.find((e) => e.components['blockLayer'] !== undefined)?.id;
  const streamEntity = listed.find((e) => (e.components['behavior'] as { behaviorId?: string } | undefined)?.behaviorId === STREAM_BEHAVIOR)?.id;
  if (layerId === undefined || streamEntity === undefined) throw new Error('blocks: the layer or the stream script was not created');
  for (const edit of blocksSurfaceEdits(1500)) await cmd('editBlocks', { entityId: layerId, edits: [edit] });
  // Kit blocks on the ground: one in every 9 × 9 columns.
  const at: number[] = [];
  for (let x = 4; x < SIDE; x += 9) for (let z = 4; z < SIDE; z += 9) at.push(x, Math.ceil(heightAt(x + 0.5, z + 0.5)) + 1, z);
  await cmd('editBlocks', { entityId: layerId, edits: [{ kind: 'cells', at, cell: { block: 'kit' } }] });
  log(`blocks: ${SIDE}×${SIDE} columns, ${at.length / 3} kit blocks`);
  // Over the ground's middle, looking down across it: most of it in view.
  const pitch = -0.5;
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 30, 60], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffe8c8', intensity: 2, direction: [0.5, -0.6, -0.6], castShadow: true } });
  return { projectId, layerId, streamEntity, ms: Math.round(performance.now() - t0) };
}

/** Turn the grid write stream on or off (exported again afterwards). */
export async function setBlocksStream(be: PerfBackend, b: BlocksBuild, on: boolean): Promise<void> {
  await be.project(b.projectId).command('setBehaviorProperties', { entityId: b.streamEntity, behaviorId: STREAM_BEHAVIOR, values: { stream: on } });
}

/** A block type change the whole layer meshes again for (the soil's colours). */
export async function changeBlocksType(be: PerfBackend, b: BlocksBuild, n: number): Promise<void> {
  const shade = (40 + ((n * 37) % 60)).toString(16).padStart(2, '0');
  await be.project(b.projectId).command('setBlockType', { block: { blockId: 'soil', name: 'Soil', variants: [{ color: `#6f${shade}4a` }, { color: '#7a9050' }], shape: 'full' } });
}

/**
 * Material rules set on the layer (every chunk painted again where it is meshed: in the mesh workers): rock on
 * slopes past a threshold that differs with `n`, a second layer in hollows, a noise patch.
 */
export async function changeBlocksRules(be: PerfBackend, b: BlocksBuild, n: number): Promise<void> {
  const rules = [
    { layer: 2, slope: { min: 20 + (n % 20), fade: 8 } },
    { layer: 1, cavity: { min: 0.2, fade: 0.2, radius: 2 }, face: 'top' },
    { layer: 3, noise: { scale: 6, seed: n, min: 0.6, fade: 0.1 } },
  ];
  await be.project(b.projectId).command('setComponent', { entityId: b.layerId, component: 'blockLayer', value: { ...GROUND_LAYER, rules } });
}

/** Switch the kit blocks to the other kit file: the layer meshes without it, then again when it has loaded. */
export async function switchBlocksKit(be: PerfBackend, b: BlocksBuild, later: boolean): Promise<void> {
  await be.project(b.projectId).command('setBlockType', { block: { blockId: 'kit', name: 'Kit stone', variants: [{ model: { assetId: later ? KIT_ASSET_LATER : KIT_ASSET, piece: 'stone' } }], shape: 'full' } });
}

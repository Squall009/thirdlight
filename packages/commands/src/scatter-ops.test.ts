/**
 * Rule scatter through the commands: a terrain's bake writes each tile's
 * copies, a sculpt bakes again only around what it moved (the same copies a
 * whole bake gives), a scatter stroke's hand edits survive the next bake;
 * a block layer's edits bake its chunks' copies, a stroke paints and erases,
 * and undo takes the copies back with the cells.
 */
import { describe, expect, it } from 'vitest';
import { decodeChunkScatter, flatTerrainTile, sameScatterCell, scatterCellCopies, terrainFlatStep, type BlockLayerData, type ScatterCell, type ScatterRule, type SceneV4, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { applyMutation, createCommandState, planTerrainEdit, type CommandState, type EditTerrainArgs } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const MODEL = (BEFORE.content as unknown as { assets: { assetId: string; kind: string }[] }).assets.find((a) => a.kind === 'model')?.assetId ?? 'model-1';
const TREES: ScatterRule = { id: 'trees', asset: { assetId: MODEL }, density: 0.5, spacing: 1, slope: { max: 20 } };
const TILE = '1'.repeat(64);

/** A 2 × 1 terrain of 33-sample tiles at 1 m: a hill on tile [0, 0], tile [1, 0] flat. */
function terrainState(scatter?: ScatterRule[]): { scene: SceneV4; comp: TerrainComponent } {
  const comp: TerrainComponent = { tileSamples: 33, spacing: 1, heightRange: [-20, 100], tiles: [{ x: 0, z: 0, data: TILE }, { x: 1, z: 0 }], ...(scatter !== undefined ? { scatter } : {}) };
  const ground = { id: 'group-0902', name: 'Ground', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: comp } };
  return { scene: { ...BEFORE.scene, entities: [...BEFORE.scene.entities, ground] } as SceneV4, comp };
}
function hill(): TerrainTile {
  const flat = terrainFlatStep([-20, 100]);
  const t = flatTerrainTile(33, flat);
  for (let z = 0; z < 33; z++) for (let x = 0; x < 33; x++) t.heights[z * 33 + x] = flat + Math.round(Math.max(0, 200 - ((x - 10) ** 2 + (z - 16) ** 2) * 2) * 30);
  return t;
}
const read = (digest: string) => (digest === TILE ? { ok: true as const, tile: hill() } : { ok: false as const, error: { code: 'blob_missing', cls: 'not_found', message: 'no blob' } as never });

/** A scene whose terrain holds the plan's tiles and scatter (stored under made-up digests the readers know). */
function stored(scene: SceneV4, comp: TerrainComponent, tiles: ReadonlyMap<string, TerrainTile>, scatter: ReadonlyMap<string, ScatterCell | null>, prev?: { tiles: Map<string, TerrainTile>; cells: Map<string, ScatterCell> }) {
  const blobs = { tiles: new Map(prev?.tiles ?? []), cells: new Map(prev?.cells ?? []) };
  let n = blobs.tiles.size + blobs.cells.size;
  const refs = comp.tiles.map((t) => {
    const key = `${t.x},${t.z}`;
    const out = { ...t };
    const tile = tiles.get(key);
    if (tile !== undefined) {
      out.data = (++n).toString(16).padStart(64, 'a');
      blobs.tiles.set(out.data, tile);
    }
    if (scatter.has(key)) {
      const cell = scatter.get(key)!;
      if (cell === null) delete out.scatter;
      else {
        out.scatter = (++n).toString(16).padStart(64, 'b');
        blobs.cells.set(out.scatter, cell);
      }
    }
    return out;
  });
  const next = { ...comp, tiles: refs };
  const s = { ...scene, entities: scene.entities.map((e) => (e.id === 'group-0902' ? { ...e, components: { ...e.components, terrain: next } } : e)) } as SceneV4;
  const readTile = (d: string) => (blobs.tiles.has(d) ? { ok: true as const, tile: blobs.tiles.get(d)! } : read(d));
  const readCell = (d: string) => ({ ok: true as const, cell: blobs.cells.get(d)! });
  return { scene: s, comp: next, blobs, readTile, readCell };
}

describe('terrain scatter', () => {
  it('a bake places copies off the hill\'s steep flanks; a raise bakes again only around itself, as a whole bake would', () => {
    const { scene, comp } = terrainState();
    const bake = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'bake', scatter: [TREES] }, read);
    expect(bake.ok === false ? bake.error : null).toBeNull();
    if (!bake.ok) return;
    expect(bake.plan.scatterRules).toEqual([TREES]);
    expect(bake.plan.rules).toBeUndefined();
    const a = bake.plan.scatter.get('0,0')!;
    const b = bake.plan.scatter.get('1,0')!;
    expect(scatterCellCopies(b)).toBeGreaterThan(scatterCellCopies(a));
    let st = stored(scene, { ...comp, scatter: [TREES] }, new Map(), bake.plan.scatter);
    // A raise on the flat tile: its bump's flanks lose their trees; tile [0, 0] is not baked again.
    const raise: EditTerrainArgs = { entityId: 'group-0902', kind: 'raise', dabs: [[50, 16]], radius: 5, strength: 8 };
    const r = planTerrainEdit(st.scene, BEFORE.content, raise, st.readTile, undefined, st.readCell);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.plan.scatter.keys()]).toEqual(['1,0']);
    expect(scatterCellCopies(r.plan.scatter.get('1,0')!)).toBeLessThan(scatterCellCopies(b));
    st = stored(st.scene, st.comp, r.plan.tiles, r.plan.scatter, st.blobs);
    const whole = planTerrainEdit(st.scene, BEFORE.content, { entityId: 'group-0902', kind: 'bake', scatter: [TREES] }, st.readTile, undefined, st.readCell);
    // The same copies everywhere: nothing to change.
    expect(whole.ok === false && whole.error.code).toBe('no_change');
  });

  it('a stroke paints copies where the rule says none, erases others; a bake keeps both', () => {
    const { scene, comp } = terrainState();
    const bake = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'bake', scatter: [TREES] }, read);
    if (!bake.ok) throw new Error('bake');
    let st = stored(scene, { ...comp, scatter: [TREES] }, new Map(), bake.plan.scatter);
    const count = (cells: ReadonlyMap<string, ScatterCell | null>, key: string, at: [number, number], r: number): number => {
      const c = cells.get(key)?.get('trees');
      let n = 0;
      for (let i = 0; i < (c?.copies.length ?? 0); i += 10) if (Math.hypot(c!.copies[i]! - at[0], c!.copies[i + 2]! - at[1]) <= r) n += 1;
      return n;
    };
    // The hill's steep flank at x ≈ 3: no trees by the rule.
    expect(count(bake.plan.scatter, '0,0', [3, 16], 1.5)).toBe(0);
    const paint = planTerrainEdit(st.scene, BEFORE.content, { entityId: 'group-0902', kind: 'scatter', rule: 'trees', dabs: [[3, 16]], radius: 1.5 }, st.readTile, undefined, st.readCell);
    if (!paint.ok) throw new Error(paint.error.message);
    expect(count(paint.plan.scatter, '0,0', [3, 16], 1.5)).toBeGreaterThan(0);
    st = stored(st.scene, st.comp, paint.plan.tiles, paint.plan.scatter, st.blobs);
    const erase = planTerrainEdit(st.scene, BEFORE.content, { entityId: 'group-0902', kind: 'scatter', rule: 'trees', dabs: [[48, 10]], radius: 4, erase: true }, st.readTile, undefined, st.readCell);
    if (!erase.ok) throw new Error(erase.error.message);
    expect(count(erase.plan.scatter, '1,0', [48, 10], 4)).toBe(0);
    st = stored(st.scene, st.comp, erase.plan.tiles, erase.plan.scatter, st.blobs);
    const again = planTerrainEdit(st.scene, BEFORE.content, { entityId: 'group-0902', kind: 'bake', scatter: [TREES] }, st.readTile, undefined, st.readCell);
    expect(again.ok === false && again.error.code).toBe('no_change');
    // A stroke naming a rule the terrain lacks is refused.
    const none = planTerrainEdit(st.scene, BEFORE.content, { entityId: 'group-0902', kind: 'scatter', rule: 'rocks', dabs: [[3, 16]], radius: 1 }, st.readTile, undefined, st.readCell);
    expect(none.ok === false && none.error.path).toBe('/args/rule');
  });
});

describe('block layer scatter', () => {
  type State = CommandState<SceneV4>;
  let counter = 0;
  const run = (state: State, op: string, args: Record<string, unknown>) => {
    counter += 1;
    const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x53500 + counter).toString(16).padStart(32, '0')}`, args });
    expect(out.ok, JSON.stringify(out.result).slice(0, 400)).toBe(true);
    return (out as { state: State }).state;
  };
  const scatterOf = (s: State): Map<string, ScatterCell> => {
    const d = s.scene.blocks?.find((b) => b.entityId === 'layer-sc') as BlockLayerData | undefined;
    return new Map((d?.chunks ?? []).flatMap((c) => (c.scatter !== undefined ? [[`${c.cx},${c.cz}`, decodeChunkScatter(c.scatter)!] as const] : [])));
  };
  const copies = (m: Map<string, ScatterCell>): number => [...m.values()].reduce((n, c) => n + scatterCellCopies(c), 0);

  it('edits bake the chunks\' copies; a wall on the lawn takes them off; a stroke and undo', () => {
    let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
    s = run(s, 'setBlockType', { block: { blockId: 'grass', name: 'Grass', variants: [{ color: '#33aa33' }], shape: 'full' } });
    s = run(s, 'setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' } });
    s.scene = { ...s.scene, entities: [...s.scene.entities, { id: 'layer-sc', name: 'Lawn', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] }, scatter: [{ ...TREES, blocks: ['grass'] }] } } }] } as SceneV4;
    s = run(s, 'editBlocks', { entityId: 'layer-sc', edits: [{ kind: 'fill', box: [0, 0, 0, 32, 1, 32], cell: { block: 'grass' } }] });
    const lawn = scatterOf(s);
    expect(copies(lawn)).toBeGreaterThan(200);
    // Copies stand on the tops (y = 1).
    const any = [...lawn.values()][0]!.get('trees')!;
    expect(any.copies[1]).toBeCloseTo(1, 5);
    // A stone wall row: no trees on stone (the rule names grass), the rest as they were.
    s = run(s, 'editBlocks', { entityId: 'layer-sc', edits: [{ kind: 'fill', box: [0, 1, 10, 32, 2, 12], cell: { block: 'stone' } }] });
    const walled = scatterOf(s);
    expect(copies(walled)).toBeLessThan(copies(lawn));
    for (const c of walled.values()) {
      const t = c.get('trees')!;
      for (let i = 0; i < t.copies.length; i += 10) expect(t.copies[i + 2]! < 10 || t.copies[i + 2]! >= 12).toBe(true);
    }
    // Erase a patch by hand, then bake every chunk again: the patch stays clear.
    s = run(s, 'editBlocks', { entityId: 'layer-sc', edits: [{ kind: 'scatter', rule: 'trees', at: [5, 5], radius: 3, erase: true }] });
    const again = applyMutation(s, { op: 'editBlocks', projectId: BEFORE.projectId, expectedRevision: s.scene.revision, requestId: `req-${'9'.repeat(32)}`, args: { entityId: 'layer-sc', edits: [{ kind: 'bakeScatter' }] } });
    expect(again.ok === false && (again.result as unknown as { error: { code: string } }).error.code).toBe('no_change');
    const erased = scatterOf(s);
    for (const c of erased.values()) {
      const t = c.get('trees')!;
      for (let i = 0; i < t.copies.length; i += 10) expect(Math.hypot(t.copies[i]! - 5, t.copies[i + 2]! - 5)).toBeGreaterThan(3);
    }
    // Undo the erase: the copies are back.
    s = run(s, 'undo', {});
    expect([...scatterOf(s).entries()].every(([k, c]) => sameScatterCell(c, walled.get(k) ?? null))).toBe(true);
  });
});

/**
 * `editTerrain` in the command layer: the args are checked per kind, the
 * planner runs each kind against the tiles the host reads (each sculpt kind
 * gives the same tiles from the same stroke, in the terrain's own place), and
 * the op stores only what the host prepared as one change — one undo points
 * back at the old tile digests. The largest stroke fits one request.
 */
import { describe, expect, it } from 'vitest';
import { TERRAIN_BRUSH_LIMITS, encodeTerrainTile, flatTerrainTile, terrainFlatStep, terrainHeightOf, terrainTileKey, type SceneV4, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { applyMutation, createCommandState, MAX_REQUEST_BYTES, planTerrainEdit, terrainTilesAfter, type EditTerrainArgs } from './index';
import type { CommandState } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const STORED = '1'.repeat(64);
const NEW_A = '2'.repeat(64);
const NEW_B = '3'.repeat(64);
const TERRAIN: TerrainComponent = { tileSamples: 33, spacing: 0.5, heightRange: [-20, 100], tiles: [{ x: 0, z: 0, data: STORED }, { x: 1, z: 0 }] };

function state(position: [number, number, number] = [0, 0, 0], terrain: TerrainComponent = TERRAIN): CommandState<SceneV4> {
  const ground = { id: 'group-0902', name: 'Ground', components: { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain } };
  return createCommandState({ ...BEFORE.scene, entities: [...BEFORE.scene.entities, ground] } as SceneV4, BEFORE.content);
}

let seq = 0;
function request(op: string, args: Record<string, unknown>, revision: number): Record<string, unknown> {
  seq += 1;
  return { op, projectId: BEFORE.projectId, expectedRevision: revision, requestId: `req-${String(0x7b00 + seq).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'test' }, args };
}

/** The stored tile of the first digest: a ridge along z, flat on its edges (as its flat neighbour [1, 0] is). */
function tileOne(): TerrainTile {
  const flat = terrainFlatStep(TERRAIN.heightRange);
  const t = flatTerrainTile(33, flat);
  for (let z = 0; z < 33; z++) for (let x = 0; x < 33; x++) t.heights[z * 33 + x] = flat + x * (32 - x) * 10;
  return t;
}
const read = (digest: string) => (digest === STORED ? { ok: true as const, tile: tileOne() } : { ok: false as const, error: { code: 'blob_missing', cls: 'not_found', message: 'no blob' } as never });
const hex = (t: TerrainTile): string => Array.from(encodeTerrainTile(t).payload, (b) => b.toString(16).padStart(2, '0')).join('');

describe('editTerrain', () => {
  it('checks the args for their kind', () => {
    const s = state();
    const good = { entityId: 'group-0902', kind: 'raise', dabs: [[4, 4]], radius: 2, strength: 1 };
    for (const bad of [
      { ...good, kind: 'melt' },
      { ...good, dabs: [] },
      { ...good, dabs: [[1, 2, 3]] },
      { ...good, radius: 0 },
      { ...good, strength: 0 },
      { ...good, kind: 'smooth', strength: 2 },
      { ...good, kind: 'flatten' },
      { ...good, layer: 1 },
      { ...good, kind: 'paint', layer: 256 },
      { entityId: 'group-0902', kind: 'ramp', from: [0, 0], to: [1, 1, 1], radius: 2, strength: 1 },
      { entityId: 'group-0902', kind: 'import', format: 'png16' },
      { entityId: 'group-0902', kind: 'import', stageId: 'stage-1', format: 'tiff' },
      { entityId: 'group-0902', kind: 'import', stageId: 'stage-1', format: 'png16', size: [4, 4] },
      { entityId: 'group-0902', kind: 'fromBlocks' },
      { ...good, entityId: 7 },
    ]) {
      const r = applyMutation(s, request('editTerrain', bad as Record<string, unknown>, s.scene.revision));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses an edit the host did not prepare', () => {
    const s = state();
    const r = applyMutation(s, request('editTerrain', { entityId: 'group-0902', kind: 'raise', dabs: [[4, 4]], radius: 2, strength: 1 }, s.scene.revision));
    expect(r.ok).toBe(false);
  });

  for (const kind of ['raise', 'lower', 'smooth', 'flatten', 'noise'] as const) {
    it(`${kind}: one stroke gives the same tiles every time, in the terrain's own place`, () => {
      const args: EditTerrainArgs = { entityId: 'group-0902', kind, dabs: [[100 + 15.5, 50 + 4], [100 + 16, 50 + 5], [100 + 16.5, 50 + 6]], radius: 3, strength: kind === 'raise' || kind === 'lower' || kind === 'noise' ? 1.5 : 0.7, height: 9, scale: 3, seed: 11 };
      if (kind !== 'flatten') delete args.height;
      if (kind !== 'noise') {
        delete args.scale;
        delete args.seed;
      }
      const a = planTerrainEdit(state([100, 2, 50]).scene, BEFORE.content, args, read);
      const b = planTerrainEdit(state([100, 2, 50]).scene, BEFORE.content, args, read);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      // The stroke sits on the edge between tile [0, 0] (data) and [1, 0] (flat): both written, alike.
      expect([...a.plan.tiles.keys()].sort()).toEqual(['0,0', '1,0']);
      expect([...a.plan.tiles.values()].map(hex)).toEqual([...b.plan.tiles.values()].map(hex));
      expect(a.plan.changed).toBeGreaterThan(0);
      const left = a.plan.tiles.get('0,0')!;
      const right = a.plan.tiles.get('1,0')!;
      for (let z = 0; z < 33; z++) expect(left.heights[z * 33 + 32]).toBe(right.heights[z * 33]);
      // Flatten moved the ground toward 9 m world (7 m above the object at y 2).
      if (kind === 'flatten') expect(Math.abs(terrainHeightOf(TERRAIN.heightRange, left.heights[10 * 33 + 31]!) - 7)).toBeLessThan(Math.abs(terrainHeightOf(TERRAIN.heightRange, tileOne().heights[10 * 33 + 31]!) - 7));
    });
  }

  it('plans a ramp, paint and holes; no change is refused', () => {
    const scene = state().scene;
    const ramp = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'ramp', from: [2, 0, 8], to: [30, 10, 8], radius: 2, strength: 1 }, read);
    expect(ramp.ok).toBe(true);
    const paint = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'paint', dabs: [[3, 3]], radius: 1, strength: 1, layer: 4 }, read);
    expect(paint.ok && paint.plan.tiles.get('0,0')!.paint).not.toBeNull();
    const holes = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'holes', dabs: [[3, 3]], radius: 1 }, read);
    // Cells 0.5 m wide whose centres are within 1 m of the dab: three in each quarter.
    expect(holes.ok && holes.plan.changed).toBe(12);
    const none = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'raise', dabs: [[500, 500]], radius: 1, strength: 1 }, read);
    expect(none.ok === false && none.error.code).toBe('no_change');
    const tooFar = planTerrainEdit(scene, BEFORE.content, { entityId: 'group-0902', kind: 'raise', dabs: Array.from({ length: 300 }, () => [0, 0] as [number, number]), radius: TERRAIN_BRUSH_LIMITS.radiusMax, strength: 1 }, read);
    expect(tooFar.ok === false && tooFar.error.message).toMatch(/split it/);
    const notTerrain = planTerrainEdit(scene, BEFORE.content, { entityId: BEFORE.scene.entities[0]!.id, kind: 'raise', dabs: [[0, 0]], radius: 1, strength: 1 }, read);
    expect(notTerrain.ok).toBe(false);
  });

  it('bake: sets the rules and paints every tile; a sculpt bakes again where it moved the ground', () => {
    const rules = [{ layer: 6, slope: { min: 30 } }];
    const bake = planTerrainEdit(state().scene, BEFORE.content, { entityId: 'group-0902', kind: 'bake', rules }, read);
    expect(bake.ok).toBe(true);
    if (!bake.ok) return;
    expect(bake.plan.rules).toEqual(rules);
    // The ridge's flanks are steep (up to about 50°): layer 6 there; the flat neighbour stays as it was.
    const t = bake.plan.tiles.get('0,0')!;
    expect(t.weights).not.toBeNull();
    expect([...bake.plan.tiles.keys()]).toEqual(['0,0']);
    // Stored: the rules with the tiles in one change; a bake of the same rules again changes nothing.
    const s = state();
    s.preparedTerrainEdit = { entityId: 'group-0902', value: { ...TERRAIN, tiles: [{ x: 0, z: 0, data: NEW_A }, { x: 1, z: 0 }], rules }, touched: [[0, 0]], added: [], changed: bake.plan.changed };
    const r = applyMutation(s, request('editTerrain', { entityId: 'group-0902', kind: 'bake', rules }, s.scene.revision));
    expect(r.ok === false ? r.result : null).toBeNull();
    if (!r.ok) return;
    const terrain = (r.state.scene.entities.find((e) => e.id === 'group-0902')!.components as { terrain: TerrainComponent }).terrain;
    expect(terrain.rules).toEqual(rules);
    const readBaked = (digest: string) => (digest === NEW_A ? { ok: true as const, tile: t } : read(digest));
    const again = planTerrainEdit(r.state.scene, BEFORE.content, { entityId: 'group-0902', kind: 'bake' }, readBaked);
    expect(again.ok === false && again.error.code).toBe('no_change');
    // A raise on the flat tile: its slope rule paints the new bump's flanks there.
    const raise = planTerrainEdit(r.state.scene, BEFORE.content, { entityId: 'group-0902', kind: 'raise', dabs: [[24, 8]], radius: 2, strength: 3 }, readBaked);
    expect(raise.ok).toBe(true);
    if (!raise.ok) return;
    expect(raise.plan.rules).toBeUndefined();
    expect(raise.plan.tiles.get('1,0')!.weights).not.toBeNull();
    // Paint moves no ground: nothing baked.
    const paint = planTerrainEdit(r.state.scene, BEFORE.content, { entityId: 'group-0902', kind: 'paint', dabs: [[24, 8]], radius: 1, strength: 1, layer: 2 }, readBaked);
    expect(paint.ok && paint.plan.tiles.get('1,0')!.weights).toBeNull();
    expect(applyMutation(state(), request('editTerrain', { entityId: 'group-0902', kind: 'bake', rules: [{ layer: 1, blocks: ['x'] }] }, 1)).ok).toBe(false);
  });

  it('names new tiles in order, drops data from tiles flat and bare again', () => {
    const digests = new Map<string, string | null>([[terrainTileKey(0, 0), null], [terrainTileKey(1, 0), NEW_A], [terrainTileKey(-1, 3), NEW_B]]);
    expect(terrainTilesAfter(TERRAIN, digests)).toEqual([{ x: 0, z: 0 }, { x: 1, z: 0, data: NEW_A }, { x: -1, z: 3, data: NEW_B }]);
  });

  it('stores the prepared tiles in one change; undo points back at the old digests', () => {
    const s = state();
    const value: TerrainComponent = { ...TERRAIN, tiles: [{ x: 0, z: 0, data: NEW_A }, { x: 1, z: 0, data: NEW_B }] };
    s.preparedTerrainEdit = { entityId: 'group-0902', value, touched: [[0, 0], [1, 0]], added: [], changed: 12 };
    const r = applyMutation(s, request('editTerrain', { entityId: 'group-0902', kind: 'raise', dabs: [[4, 4]], radius: 2, strength: 1 }, s.scene.revision));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.change.type).toBe('setComponent');
    const terrain = (st: CommandState<SceneV4>) => (st.scene.entities.find((e) => e.id === 'group-0902')!.components as { terrain: TerrainComponent }).terrain;
    expect(terrain(r.state).tiles).toEqual(value.tiles);
    const u = applyMutation(r.state, request('undo', {}, r.state.scene.revision));
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(terrain(u.state).tiles).toEqual(TERRAIN.tiles);
    const re = applyMutation(u.state, request('redo', {}, u.state.scene.revision));
    expect(re.ok && terrain(re.state).tiles).toEqual(value.tiles);
  });

  it('a terrain is made with setComponent: tiles without data are flat', () => {
    const s = state();
    const r = applyMutation(s, request('setComponent', { entityId: BEFORE.scene.entities.find((e) => e.components['transform'] !== undefined && e.components['model'] === undefined && e.components['box'] === undefined && e.components['collider'] === undefined)!.id, component: 'terrain', value: { tileSamples: 257, spacing: 1, heightRange: [-64, 192], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } }, s.scene.revision));
    expect(r.ok === false ? r.result : null).toBeNull();
    const bad = applyMutation(s, request('setComponent', { entityId: 'group-0902', component: 'terrain', value: { tileSamples: 100 } }, s.scene.revision));
    expect(bad.ok).toBe(false);
  });

  it('the largest stroke (every dab, far-out numbers) fits one request', () => {
    const far = -99_999.999;
    const args = { entityId: 'group-0902', kind: 'noise', dabs: Array.from({ length: TERRAIN_BRUSH_LIMITS.dabs }, () => [far, far]), radius: 12.345, strength: 1.234, falloff: 'linear', scale: 12.345, seed: 2_147_483_647 };
    const bytes = new TextEncoder().encode(JSON.stringify(request('editTerrain', args, 1))).byteLength;
    expect(bytes).toBeLessThan(MAX_REQUEST_BYTES);
  });
});

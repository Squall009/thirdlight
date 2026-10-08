/**
 * Ground cover near the camera: squares within a rule's reach are made (on
 * the page here, the worker's generator), drawn one set per rule, dropped
 * once the camera leaves them, and made again where the ground changed (the
 * old copies drawn until the new ones are built);
 * nothing is made where the rule says none.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type BlockChunk, type BlockLayerComponent, type BlockType, type ScatterRule } from '@thirdlight/runtime';

import { CoverGenerator } from './cover-worker';
import { COVER_CELL_METRES, CoverView } from './cover-view';
import { CullView } from './view-cull';
import type { ModelInstance } from './visual';

const GRASS: ScatterRule = { id: 'grass', asset: { assetId: 'tuft' }, density: 2, cover: true, coverDistance: 40, blocks: ['soil'] };
const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#556b2f' }], shape: 'full' } as BlockType, { blockId: 'rock', name: 'Rock', variants: [{ color: '#777777' }], shape: 'full' } as BlockType];

/** A 128 × 128 m layer of 1 m cells, one row of soil (rock from x = 64 on). */
function layer(): { component: BlockLayerComponent; chunks: BlockChunk[] } {
  const chunks: BlockChunk[] = [];
  for (let cz = 0; cz < 8; cz++)
    for (let cx = 0; cx < 8; cx++) {
      const columns: number[][] = [];
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) columns.push([x, z, 0, 1, cx < 4 ? 0 : 1]);
      chunks.push({ cx, cz, palette: [{ block: 'soil' }, { block: 'rock' }], columns });
    }
  return { component: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [128, 4, 128] }, scatter: [GRASS] } as BlockLayerComponent, chunks };
}

function view(x: number, z: number): CullView {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.position.set(x, 2, z);
  cam.lookAt(x, 0, z + 10);
  cam.updateMatrixWorld();
  const v = new CullView();
  v.set(cam);
  return v;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ground cover', () => {
  it('makes the squares near the camera on the soil only, drops them when it leaves, makes them again after an edit', async () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5), new THREE.MeshBasicMaterial()));
    const template = { glbRoot: root } as unknown as ModelInstance;
    const listed = new Set<THREE.Object3D>();
    const cover = new CoverView({ template: () => template, place: (r, on) => void (on ? listed.add(r) : listed.delete(r)), tile: () => undefined });
    cover.setTypes(TYPES);
    const { component, chunks } = layer();
    cover.setBlockLayer('layer', component, [0, 0, 0], chunks);
    // On the soil, 20 m in: the squares within 40 m are asked (two at a time) and built as they come.
    for (let i = 0; i < 40; i++) {
      cover.update(view(20, 20));
      await flush();
    }
    const d = cover.diagnostics();
    expect(d.cells).toBe(4);
    expect(d.making).toBe(0);
    expect(d.copies).toBeGreaterThan(1000);
    // Every copy stands on soil (x < 64), on its top (y = 1), within the reach of a square near the camera.
    for (const m of cover.meshes()) {
      m.updateWorldMatrix(true, false);
      const p = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
      expect(p.x).toBeLessThan(64);
    }
    // Far away (still on the layer): the old squares go.
    for (let i = 0; i < 40; i++) {
      cover.update(view(110, 110));
      await flush();
    }
    // Rock there: no cover is made at all.
    expect(cover.diagnostics().copies).toBe(0);
    for (const r of listed) expect(r.name.startsWith('cover:layer:')).toBe(true);
    // Back on the soil, then the soil under the camera turns to rock: its squares are made again, bare.
    for (let i = 0; i < 40; i++) {
      cover.update(view(20, 20));
      await flush();
    }
    const before = cover.diagnostics().copies;
    const rocky = chunks.filter((c) => c.cx < 2 && c.cz < 2).map((c) => ({ cx: c.cx, cz: c.cz, chunk: { ...c, palette: [{ block: 'rock' }, { block: 'rock' }] } }));
    cover.replaceBlockChunks('layer', rocky);
    // The old copies stay drawn until the squares' new ones are built (an edit never blinks the cover away).
    expect(cover.diagnostics().copies).toBe(before);
    expect([...listed].length).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) {
      cover.update(view(20, 20));
      await flush();
    }
    expect(cover.diagnostics().copies).toBeLessThan(before);
    cover.remove('layer');
    expect(listed.size).toBe(0);
  });

  it('the generator gives the same copies for the same square every time', () => {
    const { component, chunks } = layer();
    const gen = new CoverGenerator();
    gen.apply({ t: 'coverTypes', types: TYPES });
    gen.apply({ t: 'coverSource', id: 'l', source: { kind: 'blocks', component, origin: [0, 0, 0], rules: [GRASS], data: { entityId: 'l', chunks } } });
    const S = COVER_CELL_METRES;
    const a = gen.make('l', [0, 0, S, S]);
    const b = gen.make('l', [0, 0, S, S]);
    expect(a.length).toBe(1);
    expect(Array.from(a[0]!.copies)).toEqual(Array.from(b[0]!.copies));
  });
});

/**
 * Cell-unit UVs for a layered material made while block layers' UVs counted
 * cells: on a 2 m × 0.5 m layer the mesher's metre UVs, divided back, run one
 * unit per cell on tops (across the 2 m width) and on walls (across the width
 * and up the 0.5 m height) — one texture repeat per cell × the old `tiling`,
 * as before, whichever projection a triangle used (smoothed slopes either
 * side of 45° included). A mesh keeps its metre UVs and swaps between the two
 * as its material changes.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlockGrid, meshBlockChunk, shapeSource, type BlockLookResolver, type BlockType } from '@thirdlight/runtime';

import { cellUnitUvs, keepMetreUv, syncCellUv } from './block-cell-uv';
import { CELL_UV_KEY, readsCellUv, type MaterialGraphLike } from './material-graph';

const TYPES = new Map<string, BlockType>([['ground', { blockId: 'ground', name: 'Ground', variants: [{ color: '#808080' }], shape: 'full' }]]);
/** Stand-ins with a mapped material: world UVs and tangents. */
const world: BlockLookResolver = { source: (t, v, fm) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes), uv: 'world', tangents: true }) };

describe('cell-unit UVs on block layers', () => {
  it('turn metre UVs back into one unit per cell on tops and walls (2 m × 0.5 m cells)', () => {
    const cell: [number, number, number] = [2, 0.5, 2];
    const g = new BlockGrid({ cellSize: cell, bounds: { min: [0, 0, 0], max: [8, 8, 8] } });
    // A step: a 3 × 2-cell floor, one column two cells higher (walls on all its sides).
    for (let x = 0; x < 3; x++) for (let z = 0; z < 2; z++) g.set(x, 0, z, { block: 'ground' });
    for (let y = 1; y < 3; y++) g.set(1, y, 0, { block: 'ground' });
    const parts = meshBlockChunk(g, 0, 0, TYPES, world, {});
    let tops = 0;
    let walls = 0;
    for (const p of parts) {
      const cells = cellUnitUvs(p.uvs, p.positions, p.indices, cell);
      for (let i = 0; i < p.indices.length; i += 3) {
        const [a, b, c] = [p.indices[i]!, p.indices[i + 1]!, p.indices[i + 2]!];
        const pos = (j: number): number[] => [p.positions[j * 3]!, p.positions[j * 3 + 1]!, p.positions[j * 3 + 2]!];
        const uv = (j: number): number[] => [cells[j * 2]!, cells[j * 2 + 1]!];
        const top = Math.abs(p.normals[a * 3 + 1]!) > 0.9;
        // UV change per cell along each edge: |Δu| and |Δv| over the edge's extent in cells of its axes.
        for (const [j, k] of [[a, b], [b, c], [c, a]] as [number, number][]) {
          const d = pos(k).map((x, n) => (x - pos(j)[n]!) / cell[n]!);
          const du = uv(k)[0]! - uv(j)[0]!;
          const dv = uv(k)[1]! - uv(j)[1]!;
          // Cells crossed along the edge: on a top, x and z; on a wall, the horizontal axis and y.
          const across = top ? Math.hypot(d[0]!, d[2]!) : Math.hypot(d[0]! + d[2]!, d[1]!);
          expect(Math.abs(Math.hypot(du, dv) - across)).toBeLessThan(1e-5);
        }
        if (top) tops++;
        else walls++;
      }
    }
    expect(tops).toBeGreaterThan(0);
    expect(walls).toBeGreaterThan(0);
  });

  it('divides by the size along the projection a triangle used, not its vertex normal (smoothed slopes either side of 45°)', () => {
    // Tall cells (0.5 m wide, 2 m rows): a sloped top rises up to 8 m over its 0.5 m, so slopes run from flat to steep.
    const cell: [number, number, number] = [0.5, 2, 0.5];
    const g = new BlockGrid({ cellSize: cell, bounds: { min: [0, 0, 0], max: [16, 40, 16] } });
    const q = (v: number): number => Math.round(v * 8) / 8;
    const h = (x: number, z: number): number => q(8 + 2 * Math.sin(x / 2.5) * Math.cos(z / 3));
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const c = [h(x, z), h(x + 1, z), h(x + 1, z + 1), h(x, z + 1)];
      const row = Math.floor(Math.min(...c) - 1e-9);
      for (let y = 0; y < row; y++) g.set(x, y, z, { block: 'ground' });
      const corners = c.map((v) => Math.min(4, v - row)) as [number, number, number, number];
      g.set(x, row, z, { block: 'ground', ...(corners.every((v) => v === 1) ? {} : { corners }) });
    }
    let leaning = 0;
    let checked = 0;
    for (const p of meshBlockChunk(g, 0, 0, TYPES, world, { smoothAngle: 80 })) {
      const cells = cellUnitUvs(p.uvs, p.positions, p.indices, cell);
      for (let i = 0; i < p.indices.length; i += 3) {
        const t = [p.indices[i]!, p.indices[i + 1]!, p.indices[i + 2]!];
        const pos = (j: number): number[] => [p.positions[j * 3]!, p.positions[j * 3 + 1]!, p.positions[j * 3 + 2]!];
        const [a, b, c] = t.map(pos) as [number[], number[], number[]];
        const e = a.map((x, k) => b[k]! - x);
        const f = a.map((x, k) => c[k]! - x);
        const n = [e[1]! * f[2]! - e[2]! * f[1]!, e[2]! * f[0]! - e[0]! * f[2]!, e[0]! * f[1]! - e[1]! * f[0]!].map(Math.abs);
        // The mesher's projection: a top's while the face's up is its largest component (45° stays a top).
        const top = n[1]! * (1 + 1e-5) >= Math.max(n[0]!, n[2]!);
        for (const j of t) {
          const nv = [p.normals[j * 3]!, p.normals[j * 3 + 1]!, p.normals[j * 3 + 2]!].map(Math.abs);
          if (nv[1]! >= nv[0]! && nv[1]! >= nv[2]! ? !top : top) leaning++;
          expect(cells[j * 2]!).toBeCloseTo(p.uvs[j * 2]! / cell[0], 5);
          expect(cells[j * 2 + 1]!).toBeCloseTo(p.uvs[j * 2 + 1]! / (top ? cell[0] : cell[1]), 5);
          checked++;
        }
      }
    }
    // Vertices whose smoothed normal points the other way from their triangle's projection (the case the vertex normal got wrong).
    expect(leaning).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(1000);
  });

  it('a mesh keeps its metre UVs and wears cells only under a material that reads them', () => {
    const geometry = new THREE.BufferGeometry();
    // A top (uv = x, z) and a wall facing +Z (uv = x, −y), one triangle each.
    const metres = new Float32Array([0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 0.5]);
    geometry.setAttribute('uv', new THREE.BufferAttribute(metres, 2));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 2, 1, 0, 0, 1, 2, 0, 0, 0, 2, 0, 0, 0, -0.5, 0]), 3));
    geometry.setIndex([0, 2, 1, 3, 4, 5]);
    const plain = new THREE.MeshStandardMaterial();
    const legacy = new THREE.MeshStandardMaterial();
    legacy.userData[CELL_UV_KEY] = true;
    const mesh = new THREE.Mesh(geometry, legacy);
    keepMetreUv(mesh, [2, 0.5, 2]);
    syncCellUv(mesh);
    expect([...(geometry.getAttribute('uv').array as Float32Array)]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    mesh.material = plain;
    syncCellUv(mesh);
    expect(geometry.getAttribute('uv').array).toBe(metres);
    // 1 m cells: metres are cells; nothing is kept.
    const one = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('uv', new THREE.BufferAttribute(metres, 2)), legacy);
    keepMetreUv(one, [1, 1, 1]);
    syncCellUv(one);
    expect(one.geometry.getAttribute('uv').array).toBe(metres);
  });

  it('only the layered template as made before per-layer tilings reads cells', () => {
    const old: MaterialGraphLike = {
      nodes: [
        { id: 'uv', type: 'uv' },
        { id: 'tiling', type: 'parameter', data: { key: 'tiling' } },
        { id: 'uvTiled', type: 'multiply' },
        { id: 'heightBlend', type: 'heightBlend' },
      ],
      edges: [
        { id: 'e1', from: { node: 'uv', port: 'uv' }, to: { node: 'uvTiled', port: 'a' } },
        { id: 'e2', from: { node: 'tiling', port: 'value' }, to: { node: 'uvTiled', port: 'b' } },
      ],
    };
    expect(readsCellUv(old)).toBe(true);
    // UVs built some other way (from the world position), no height blend, or the second UV set: metres as they come.
    expect(readsCellUv({ ...old, edges: old.edges.filter((e) => e.id !== 'e1') })).toBe(false);
    expect(readsCellUv({ ...old, nodes: old.nodes.filter((n) => n.type !== 'heightBlend') })).toBe(false);
    expect(readsCellUv({ ...old, nodes: old.nodes.map((n) => (n.id === 'uv' ? { ...n, data: { set: 'uv1' } } : n)) })).toBe(false);
  });
});

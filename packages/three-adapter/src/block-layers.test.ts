/**
 * Block-layer chunk levels of detail and lightmap UVs in the block view: a
 * model look with a coarser level makes each chunk of model blocks one
 * `THREE.LOD` (the detailed level near, the coarse one past the model's
 * switch distance plus the chunk's radius), stand-in blocks stay at full
 * detail, counts and bakes read the detailed meshes, and lightmapped chunks
 * carry UV1 on every level.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, type BlockType } from '@thirdlight/runtime';

import { BlockLayerView, blockLookFromObject } from './block-layers';

const LAYER = { cellSize: [1, 1, 1] as [number, number, number], bounds: { min: [0, 0, 0] as [number, number, number], max: [32, 4, 16] as [number, number, number] } };
const TYPES: BlockType[] = [
  { blockId: 'crate', name: 'Crate', variants: [{ model: { assetId: 'kit' } }], shape: 'full' },
  { blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' },
];

/** A model with two levels: a full cube, then a flat slab, switching at 20 m. */
function kitRoot(): THREE.Object3D {
  const material = new THREE.MeshLambertMaterial();
  const lod = new THREE.LOD();
  const detailed = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material);
  const coarse = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1).translate(0, 0.1, 0), material);
  lod.addLevel(detailed, 0);
  lod.addLevel(coarse, 20);
  const root = new THREE.Group();
  root.add(lod);
  return root;
}

function view(lightmapped = false): BlockLayerView {
  const look = blockLookFromObject(kitRoot());
  return new BlockLayerView({ modelLook: () => look, lightmapped: () => lightmapped });
}

function layerData(): { entityId: string; chunks: ReturnType<BlockGrid['encodeChunk']>[] } {
  const g = new BlockGrid(LAYER);
  const types = new Map(TYPES.map((t) => [t.blockId, t]));
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 32, 1, 16], cell: { block: 'soil' } }, { kind: 'fill', box: [0, 1, 0, 32, 2, 16], cell: { block: 'crate' } }], { types, stamps: new Map() });
  return { entityId: 'ground', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)) };
}

describe('block view: chunk levels of detail', () => {
  it('a model look keeps its coarser levels and their switch distances', () => {
    const look = blockLookFromObject(kitRoot())!;
    expect(look.levels).toHaveLength(1);
    expect(look.levels![0]!.distance).toBe(20);
    expect(look.levels![0]!.source.indices.length).toBe(look.source.indices.length);
  });

  it('each chunk of model blocks is one LOD: detailed near, coarse past the model distance plus the chunk radius; stand-ins stay', () => {
    const v = view();
    v.setTypes(TYPES);
    v.setLayer('ground', LAYER, [0, 0, 0], layerData() as never);
    v.update();
    const d = v.diagnostics();
    expect(d.chunks).toBe(2);
    expect(d.lods?.chunks).toBe(2);
    const lod = v.root.getObjectByName('block-chunk-lod:ground:0,0') as THREE.LOD;
    expect(lod.levels).toHaveLength(2);
    // 20 m plus the radius of the chunk's crates (16 × 1 × 16 m): about 31.3 m.
    expect(lod.levels[1]!.distance).toBeCloseTo(20 + Math.hypot(8, 0.5, 8), 5);
    const camera = new THREE.PerspectiveCamera();
    v.root.updateMatrixWorld(true);
    camera.position.set(8, 5, 8);
    camera.updateMatrixWorld();
    lod.update(camera);
    expect(lod.getCurrentLevel()).toBe(0);
    camera.position.set(8, 5, 60);
    camera.updateMatrixWorld();
    lod.update(camera);
    expect(lod.getCurrentLevel()).toBe(1);
    // The flat level draws the crates 0.2 m tall.
    const coarse = lod.levels[1]!.object.children[0] as THREE.Mesh;
    coarse.geometry.computeBoundingBox();
    expect(coarse.geometry.boundingBox!.max.y - coarse.geometry.boundingBox!.min.y).toBeCloseTo(0.2, 5);
    // Counts and ray targets are the detailed meshes: the stand-in floor and the detailed crates.
    expect(v.layerMeshes('ground').every((m) => m.userData['tlBlockLodLevel'] === undefined)).toBe(true);
    expect(v.layerMeshes('ground')).toHaveLength(4);
  });

  it('lightmapped chunks: UV1 on the detailed and the coarse meshes, one layout', () => {
    const v = view(true);
    v.setTypes(TYPES);
    v.setLayer('ground', LAYER, [0, 0, 0], layerData() as never);
    v.update();
    const targets = v.lightmapTargets('ground');
    expect(targets).toHaveLength(2);
    for (const t of targets) {
      expect(t.layout).toMatch(/^[0-9a-f]{16}$/);
      expect(t.meshes.length).toBeGreaterThan(0);
      expect(t.coarse.length).toBeGreaterThan(0);
      for (const m of [...t.meshes, ...t.coarse]) expect(m.geometry.getAttribute('uv1')).toBeDefined();
    }
  });
});

describe('block view: paint and stand-in materials (phase 25.21)', () => {
  const soil: BlockType = { blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full', materials: { '*': 'mat-terrain' } };
  const ground = (paint: boolean): { entityId: string; chunks: ReturnType<BlockGrid['encodeChunk']>[] } => {
    const g = new BlockGrid(LAYER);
    const types = new Map([[soil.blockId, soil]]);
    applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 32, 1, 16], cell: { block: 'soil' } }, ...(paint ? [{ kind: 'paint' as const, at: [4, 4], radius: 1, strength: 1, channel: 2, falloff: 'constant' as const }] : [])], { types, stamps: new Map() });
    return { entityId: 'ground', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)) };
  };
  const meshesOf = (v: BlockLayerView): THREE.Mesh[] => v.layerMeshes('ground');

  it('an unpainted layer carries no paint colours; once one chunk is painted every chunk does (COLOR_0 weights, COLOR_1 wetness)', () => {
    const v = new BlockLayerView({});
    v.setTypes([soil]);
    v.setLayer('ground', LAYER, [0, 0, 0], ground(false) as never);
    v.update();
    expect(meshesOf(v).some((m) => m.geometry.getAttribute('color') !== undefined)).toBe(false);
    const painted = ground(true);
    v.replaceChunks('ground', painted.chunks.map((c) => ({ cx: c!.cx, cz: c!.cz, chunk: c })));
    v.update();
    const meshes = meshesOf(v);
    expect(meshes).toHaveLength(2);
    for (const m of meshes) {
      const c = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      expect(c.itemSize).toBe(4);
      expect(c.normalized).toBe(true);
      expect(m.geometry.getAttribute('color_1')).toBeDefined();
    }
    // The painted vertex (4, 4) (top corner at y = 1) is all layer 3; the unpainted chunk is all layer 1.
    const first = meshes.find((m) => m.name.length > 0 && (m.geometry.getAttribute('position') as THREE.BufferAttribute).getX(0) < 16)!;
    const pos = first.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = first.geometry.getAttribute('color') as THREE.BufferAttribute;
    let found = false;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getX(i) === 4 && pos.getY(i) === 1 && pos.getZ(i) === 4) {
        found = true;
        expect([col.getX(i), col.getY(i), col.getZ(i), col.getW(i)]).toEqual([0, 0, 1, 0]);
      }
    }
    expect(found).toBe(true);
  });

  it('a stand-in takes the block type\'s "*" material (the host applies it); a tinting material keeps no paint colours', () => {
    const applied: (string | null)[] = [];
    const tint = new THREE.MeshLambertMaterial({ vertexColors: true });
    const v = new BlockLayerView({
      applyMaterials: (mesh, _type, assetId) => {
        applied.push(assetId);
        mesh.material = tint;
      },
    });
    v.setTypes([soil]);
    v.setLayer('ground', LAYER, [0, 0, 0], ground(true) as never);
    v.update();
    expect(applied).toEqual([null, null]);
    expect(meshesOf(v).some((m) => m.geometry.getAttribute('color') !== undefined)).toBe(false);
  });
});

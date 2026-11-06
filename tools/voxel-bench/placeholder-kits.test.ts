/**
 * The committed placeholder kits (log, stone; `kits/make_placeholder_kits.py`
 * through Blender), made for the edge catalogue's slots: pieces only on
 * edges, corners, roof edges and the faces toward a damage hole, one mesh filling several slots with
 * a rotation, one texture set (one material) a kit. Their records name the
 * GLBs beside them by the bytes' digest, every piece's node reads with the
 * project model's GLB reader and with the renderer's loader port (three's
 * GLTFLoader) to the same triangles, the kit check finds no error (the
 * draft trim layout's conformance rows T1–T7 all passing), every piece keeps
 * the game-ready budgets, and the roof-edge pieces that follow a slope lie
 * on the roof planes of their case. Prints each kit's asset table.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalVoxelKit, validateVoxelKit, voxelKitMeshes as meshesOf, voxelKitMeshFacts, voxelKitMeshKey, worldVoxelKitCheck, type VoxelKit, type VoxelKitMesh, type VoxelKitMeshFacts } from '@thirdlight/project-model';
import { VoxelKitMeshes } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { WORLD_RULES } from '@thirdlight/voxel';
import { ROOF_EDGE_NEAR_M, roofCaseOffset } from './roof-edge-surface';

const DIR = join(import.meta.dirname, 'kits');
const KITS = ['log', 'stone'] as const;

/** The names of a GLB's mesh nodes (the pieces it holds). */
function glbNodeNames(glb: Uint8Array): string[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true)))) as { nodes?: { name?: string; mesh?: number }[] };
  return (json.nodes ?? []).filter((n) => n.mesh !== undefined).map((n) => n.name ?? '');
}

function load(id: (typeof KITS)[number]): { kit: VoxelKit; glb: Uint8Array; file: string } {
  const kit = JSON.parse(readFileSync(join(DIR, `${id}.voxelkit.json`), 'utf8')) as VoxelKit;
  const file = join(DIR, `voxel-kit-${id}.glb`);
  return { kit, glb: new Uint8Array(readFileSync(file)), file };
}

describe.each(KITS)('placeholder kit %s', (id) => {
  const { kit, glb, file } = load(id);
  const digest = createHash('sha256').update(glb).digest('hex');

  it('is a valid kit record naming the committed GLB by its digest, two materials, the draft trim layout', () => {
    const errors: unknown[] = [];
    validateVoxelKit(kit, '/kit', errors as never);
    expect(errors).toEqual([]);
    expect(canonicalVoxelKit(kit).voxelKitId).toBe(id);
    expect(kit.materials).toHaveLength(2);
    expect(kit.trimLayout).toBe('detail-trim');
    for (const m of meshesOf(kit)) expect([m.assetId, m.digest]).toEqual([`voxel-kit-${id}`, digest]);
  });

  it('passes the kit check with no error (trim T1–T7 ok, every slot the catalogue knows, one texture set) with every piece read from the GLB (one mesh a piece), each within its budget', () => {
    const facts = new Map<string, VoxelKitMeshFacts>();
    const factsOf = (m: VoxelKitMesh): VoxelKitMeshFacts => {
      const k = voxelKitMeshKey(m);
      let f = facts.get(k);
      if (f === undefined) facts.set(k, (f = voxelKitMeshFacts(glb, m.node)));
      return f;
    };
    const report = worldVoxelKitCheck(kit, new Map([[`voxel-kit-${id}`, { kind: 'model', digests: [digest] }]]), factsOf);
    const errors = report.rows.filter((r) => r.state === 'err');
    expect(errors, JSON.stringify(errors, null, 1)).toEqual([]);
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
      const row = report.rows.find((r) => r.id === `trim:${t}`)!;
      expect(row.state, `${t}: ${row.detail}`).toBe('ok');
    }
    for (const r of ['catalogue', 'assets', 'pivot', 'fit', 'texture-set']) expect(report.rows.find((x) => x.id === r)?.state, r).toBe('ok');
    expect(report.rows.some((x) => x.id === 'digests')).toBe(false);
    // No warning at all: an empty slot (the inner corners) is no warning.
    expect(report.rows.filter((r) => r.state === 'warn').map((r) => r.id)).toEqual([]);
    // Every slot named is the catalogue's: no piece for a flat face, every slot an edge, corner, roof edge or damage case.
    const cat = new Set(WORLD_RULES.catalogue!.cases.map((c) => c.id));
    for (const cid of Object.keys(kit.slots)) {
      expect(cat.has(cid), cid).toBe(true);
      expect(cid, cid).toMatch(/^(edge-|corner-|roof-|damage-stage-)/);
    }
    // Game-ready budgets (triangles a piece; drawn in the near ring only, so no lower-detail mesh). A damage piece is
    // one fragment drawn several times a face toward a hole: 32.
    const budget = (cid: string): number => (cid.startsWith('edge-') ? 48 : cid.startsWith('corner-') || cid.startsWith('roof-') ? 64 : cid.startsWith('damage-') ? 32 : 64);
    for (const p of report.pieces) expect(p.triangles!, p.caseId).toBeLessThanOrEqual(budget(p.caseId));
    // No mesh in the file is left over from a lower level (every node a record names, and only those).
    expect(new Set(meshesOf(kit).map((m) => m.node)).size).toBe(glbNodeNames(glb).length);
    for (const m of meshesOf(kit)) {
      const f = factsOf(m);
      expect(f.found && f.unreadable === null && f.triangles > 0, m.node).toBe(true);
      expect(f.textures.count).toBe(0);
    }
    // One mesh filling more than one slot (a rotation turns it there): fewer distinct meshes than slot meshes.
    const nodes = new Set(meshesOf(kit).map((m) => m.node));
    expect(nodes.size).toBeLessThan(meshesOf(kit).length);
    const turned = Object.entries(kit.slots).flatMap(([cid, c]) => c.meshes.filter((m) => (m.rotation ?? 0) !== 0).map((m) => `${cid} = ${m.mesh.node} turned (${m.rotation})`));
    const lines = report.pieces.map((p) => `  ${p.caseId.padEnd(18)} mesh ${p.mesh}  ${String(p.triangles).padStart(3)} tris`);
    console.log(`[placeholder kit] ${id}: ${statSync(file).size} B GLB, record ${readFileSync(join(DIR, `${id}.voxelkit.json`)).length} B, ${nodes.size} meshes in ${Object.keys(kit.slots).length} slots, triangles ${[...nodes].reduce((n, node) => n + factsOf({ assetId: `voxel-kit-${id}`, digest, node: node! }).triangles, 0)}, textures ${report.totals.textures}\n${lines.join('\n')}\n  turned: ${turned.join('; ')}\n  warn/info: ${report.rows.filter((r) => r.state === 'warn' || r.state === 'info').map((r) => `${r.id} (${r.state}) ${r.title}`).join('; ')}`);
  });

  it('draws its slope-following roof pieces on the roof planes: the ridge, the verge (rising toward +x; the other side mirrored), the hip and the valley', () => {
    for (const cid of ['roof-ridge', 'roof-gable', 'roof-hip', 'roof-valley'] as const) {
      for (const m of kit.slots[cid]!.meshes) {
        expect(m.rotation ?? 0, cid).toBe(0);
        expect(roofCaseOffset(cid, voxelKitMeshFacts(glb, m.mesh.node).positions), `${cid} ${m.mesh.node}`).toBeLessThan(ROOF_EDGE_NEAR_M);
      }
    }
  });

  it("loads through the renderer's GLB loader port: every node ready, the same triangles as the project model reads", async () => {
    const meshes = new VoxelKitMeshes();
    try {
      const loaded = await meshes.load([kit], async () => ({ bytes: glb, version: 1 }), createGltfLoaderPort());
      expect(loaded.failed).toEqual([]);
      for (const m of meshesOf(kit)) {
        const g = meshes.mesh(m, false);
        if (g === 'pending' || g === null) throw new Error(`${m.node}: ${String(g)}`);
        const tris = g.index === null ? g.getAttribute('position').count / 3 : g.index.count / 3;
        expect(tris, m.node).toBe(voxelKitMeshFacts(glb, m.node).triangles);
        expect(g.getAttribute('uv'), m.node).toBeDefined();
      }
    } finally {
      meshes.dispose();
    }
  });
});

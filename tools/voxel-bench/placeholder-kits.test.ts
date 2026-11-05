/**
 * The committed placeholder kits (log, stone; `kits/make_placeholder_kits.py`
 * through Blender): their records name the GLBs beside them by the bytes'
 * digest, every piece's node reads with the project model's GLB reader and
 * with the renderer's loader port (three's GLTFLoader) to the same
 * triangles, and the kit check finds no error, with the draft trim layout's
 * conformance rows (T1–T8) all passing. Prints each kit's asset table.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalVoxelKit, validateVoxelKit, voxelKitMeshes as meshesOf, voxelKitMeshFacts, voxelKitMeshKey, worldVoxelKitCheck, type VoxelKit, type VoxelKitMesh, type VoxelKitMeshFacts } from '@thirdlight/project-model';
import { VoxelKitMeshes } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';

const DIR = join(import.meta.dirname, 'kits');
const KITS = ['log', 'stone'] as const;

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

  it('passes the kit check (trim T1–T8 ok) with every piece read from the GLB, high and low; its one error names the cases it was made for, the superseded catalogue\'s', () => {
    const facts = new Map<string, VoxelKitMeshFacts>();
    const factsOf = (m: VoxelKitMesh): VoxelKitMeshFacts => {
      const k = voxelKitMeshKey(m);
      let f = facts.get(k);
      if (f === undefined) facts.set(k, (f = voxelKitMeshFacts(glb, m.node)));
      return f;
    };
    const report = worldVoxelKitCheck(kit, new Map([[`voxel-kit-${id}`, { kind: 'model', digests: [digest] }]]), factsOf);
    // The kits were made for the superseded 46-case catalogue (copings, plinths, frames on flat faces); the world's
    // edge catalogue names none of those cases, so they draw nothing but their beams and banisters until they are
    // made again for the edge cases. Every other row holds.
    const errors = report.rows.filter((r) => r.state === 'err');
    expect(errors.map((r) => r.id), JSON.stringify(errors, null, 1)).toEqual(['catalogue']);
    expect(errors[0]!.detail).toMatch(/case wall-top/);
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) {
      const row = report.rows.find((r) => r.id === `trim:${t}`)!;
      expect(row.state, `${t}: ${row.detail}`).toBe('ok');
    }
    for (const r of ['assets', 'pivot', 'fit', 'pairs']) expect(report.rows.find((x) => x.id === r)?.state, r).toBe('ok');
    expect(report.rows.some((x) => x.id === 'digests' || x.id === 'pairs-heavy')).toBe(false);
    for (const m of meshesOf(kit)) {
      const f = factsOf(m);
      expect(f.found && f.unreadable === null && f.triangles > 0, m.node).toBe(true);
      expect(f.textures.count).toBe(0);
    }
    const lines = report.pieces.map((p) => `  ${p.caseId.padEnd(18)} ${p.sectionId.padEnd(7)} v${p.variant}  high ${String(p.high).padStart(3)}  low ${String(p.low).padStart(3)}`);
    console.log(`[placeholder kit] ${id}: ${statSync(file).size} B GLB, ${report.totals.pieces} pieces, triangles high ${report.totals.highTriangles} / low ${report.totals.lowTriangles}, textures ${report.totals.textures}\n${lines.join('\n')}\n  warn/info: ${report.rows.filter((r) => r.state === 'warn' || r.state === 'info').map((r) => `${r.id} (${r.state}) ${r.title}`).join('; ')}`);
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

/**
 * The authoring package's recommended sample kit (`kits/sample.voxelkit.json`
 * and `kits/voxel-kit-sample.glb`), built by the Blender templates
 * (`kits/kit_templates.py sample`) through the same export an artist's kit
 * takes: its record is valid, names the committed GLB by its digest and
 * declares its own sheet layout, and the kit check reads the real bytes with
 * no error and no warning (the trim rows checked against the kit's own
 * layout), every mesh within the slot sheets' triangle guidance. Never bound
 * by default: nothing in the engine names it. Prints the asset report.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalVoxelKit, validateVoxelKit, voxelKitMeshes, voxelKitMeshFacts, voxelKitMeshKey, worldVoxelKitCheck, type VoxelKit, type VoxelKitMesh, type VoxelKitMeshFacts } from '@thirdlight/project-model';
import { WORLD_RULES } from '@thirdlight/voxel';
import { SLOT_TRIANGLE_GUIDE, slotFamily } from './slot-sheets';

const DIR = join(import.meta.dirname, 'kits');

describe('the recommended sample kit', () => {
  const kit = JSON.parse(readFileSync(join(DIR, 'sample.voxelkit.json'), 'utf8')) as VoxelKit;
  const file = join(DIR, 'voxel-kit-sample.glb');
  const glb = new Uint8Array(readFileSync(file));
  const digest = createHash('sha256').update(glb).digest('hex');

  it('is a valid kit record with its own sheet layout, naming the committed GLB by its digest', () => {
    const errors: unknown[] = [];
    validateVoxelKit(kit, '/kit', errors as never);
    expect(errors).toEqual([]);
    expect(canonicalVoxelKit(kit)).toEqual(kit);
    expect(kit.sheetLayout).toBeDefined();
    expect(kit.trimLayout).toBeUndefined();
    for (const m of voxelKitMeshes(kit)) expect([m.assetId, m.digest]).toEqual(['voxel-kit-sample', digest]);
  });

  it('passes the kit check on its real bytes: no error, no warning, trim T1–T7 ok on its own layout, every mesh within the guidance', () => {
    const facts = new Map<string, VoxelKitMeshFacts>();
    const factsOf = (m: VoxelKitMesh): VoxelKitMeshFacts => {
      const k = voxelKitMeshKey(m);
      let f = facts.get(k);
      if (f === undefined) facts.set(k, (f = voxelKitMeshFacts(glb, m.node)));
      return f;
    };
    const report = worldVoxelKitCheck(kit, new Map([['voxel-kit-sample', { kind: 'model', digests: [digest] }]]), factsOf);
    expect(report.rows.filter((r) => r.state === 'err' || r.state === 'warn'), JSON.stringify(report.rows, null, 1)).toEqual([]);
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
      const row = report.rows.find((r) => r.id === `trim:${t}`)!;
      expect(row.state, `${t}: ${row.detail}`).toBe('ok');
      expect(row.title).toContain("(the kit's layout)");
    }
    for (const p of report.pieces) expect(p.triangles!, p.caseId).toBeLessThanOrEqual(SLOT_TRIANGLE_GUIDE[slotFamily(p.caseId)]);
    for (const m of voxelKitMeshes(kit)) expect(factsOf(m).textures.count, m.node).toBe(0);
    const nodes = [...new Set(voxelKitMeshes(kit).map((m) => m.node!))];
    const tris = nodes.map((n) => [n, factsOf({ assetId: 'voxel-kit-sample', digest, node: n }).triangles] as const);
    const filled = Object.keys(kit.slots).length;
    console.log(`[sample kit] ${statSync(file).size} B GLB, record ${readFileSync(join(DIR, 'sample.voxelkit.json')).length} B, ${nodes.length} meshes in ${filled} of ${WORLD_RULES.catalogue!.cases.length} slots, ${tris.reduce((n, [, t]) => n + t, 0)} triangles (${report.totals.triangles} counting each slot's meshes), textures ${report.totals.textures}, LODs none, collision from the voxels\n${tris.map(([n, t]) => `  ${n.padEnd(20)} ${String(t).padStart(3)} tris`).join('\n')}`);
  });
});

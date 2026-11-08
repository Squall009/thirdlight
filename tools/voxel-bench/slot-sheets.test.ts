/**
 * The kit authoring package's generated files against what generates them
 * (slot-sheets.ts): the committed slot contract the Blender templates read
 * and one manual page a slot are exactly what the engine's catalogue, the
 * kit check's envelope and the committed kits give today, every catalogue
 * case has its page, and the rotations the sheets tell an artist to share a
 * mesh with are the ones the committed kits were built with.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOXEL_KIT_ENVELOPE, type VoxelKit } from '@thirdlight/project-model';
import { applyCubeRotation, PIECE_STAGGER_FRAMES, VOXEL_SIZE_M, WORLD_RULES } from '@thirdlight/voxel';
import { REFERENCE_KITS, REPO, SLOT_CONTRACT_FILE, SLOT_PAGES_DIR, slotContract, slotSheetFiles } from './slot-sheets';

describe('kit authoring slot sheets', () => {
  const files = slotSheetFiles();

  it('are committed exactly as generated (regenerate: node tools/voxel-bench/gen-slot-sheets.mjs)', () => {
    const stale = [...files].filter(([rel, text]) => readFileSync(join(REPO, rel), 'utf8') !== text).map(([rel]) => rel);
    expect(stale).toEqual([]);
  });

  it('give every catalogue case a page and a contract entry, and the index links each page', () => {
    const ids = WORLD_RULES.catalogue!.cases.map((c) => c.id);
    const contract = JSON.parse(files.get(SLOT_CONTRACT_FILE)!) as ReturnType<typeof slotContract>;
    expect(contract.slots.map((s) => s.id)).toEqual(ids);
    const index = files.get(`${SLOT_PAGES_DIR}/index.md`)!;
    for (const id of ids) {
      expect(files.has(`${SLOT_PAGES_DIR}/${id}.md`), id).toBe(true);
      expect(index).toContain(`](${id}.md)`);
    }
  });

  it("state the kit check's envelope, in glTF axes and turned into Blender's (x, −z, y)", () => {
    const E = VOXEL_KIT_ENVELOPE;
    for (const s of slotContract().slots) {
      const top = s.family === 'roof-edge' ? E.roofTop : E.half;
      expect(s.touch, s.id).toEqual({ min: [-E.half, -E.half, -E.half], max: [E.half, top, E.half] });
      expect(s.fit.max[1], s.id).toBe(top + E.reach);
      expect(s.blender.anchor, s.id).toEqual([s.anchor[0], -s.anchor[2] + 0, s.anchor[1]]);
      expect(s.blender.touch.max[2], s.id).toBe(top);
      // The anchor is the stagger frame's point, cells to metres.
      expect(s.anchor.map((v) => v / VOXEL_SIZE_M)).toEqual(PIECE_STAGGER_FRAMES[s.id]!.anchor.map((v) => Math.round(v * 1e4) / 1e4 + 0));
    }
  });

  it('list a share only where the rotation turns the source slot onto this one (frame and open side)', () => {
    for (const s of slotContract().slots) {
      for (const sh of s.shares) {
        const f = PIECE_STAGGER_FRAMES[sh.from]!;
        const t = PIECE_STAGGER_FRAMES[s.id]!;
        applyCubeRotation(sh.rotation, f.anchor).forEach((v, i) => expect(v, `${s.id} from ${sh.from}`).toBeCloseTo(t.anchor[i]!, 6));
        applyCubeRotation(sh.rotation, f.out).forEach((v, i) => expect(v, `${s.id} from ${sh.from}`).toBeCloseTo(t.out[i]!, 6));
      }
    }
  });

  it('match the committed kits: every slot filled with another slot\'s mesh uses a rotation the sheets list', () => {
    const shares = new Map(slotContract().slots.map((s) => [s.id, s.shares]));
    const used: string[] = [];
    for (const id of REFERENCE_KITS) {
      const kit = JSON.parse(readFileSync(join(REPO, 'tools', 'voxel-bench', 'kits', `${id}.voxelkit.json`), 'utf8')) as VoxelKit;
      for (const [cid, slot] of Object.entries(kit.slots)) {
        for (const m of slot.meshes) {
          const from = (m.mesh.node ?? '').replace(/_v\d+$/, '');
          if (from === cid) continue;
          expect(shares.get(cid)!.some((x) => x.from === from && x.rotation === (m.rotation ?? 0)), `${id} ${cid} = ${from} r${m.rotation ?? 0}`).toBe(true);
          used.push(`${id} ${cid}`);
        }
      }
    }
    expect(used.length).toBeGreaterThan(10);
  });
});

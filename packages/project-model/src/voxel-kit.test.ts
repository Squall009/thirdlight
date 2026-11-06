/**
 * The voxel kit record (slots): its canonical form keeps every field (a
 * field the canonicalizer forgot would be dropped silently), in one order
 * however it was built; a newer format, unknown fields and bad values are
 * refused; the
 * content block holds kits as a list of records, and a build's catalog block
 * takes them as they are, game data untouched.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_ID_MAX } from '@thirdlight/voxel';

import type { ModelErrorV2 } from './errors';
import { collectAssetRefsV3 } from './capture';
import { catalogBlockProblem } from './manifest-v5';
import { canonicalVoxelKit, canonicalVoxelKits, validateVoxelKit, validateVoxelKits, VOXEL_KIT_FORMAT, VOXEL_KIT_LIMITS, type VoxelKit } from './voxel-kit';

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);

/** Every field set, maps and lists out of order, a weight of 1 and a rotation of 0 (the defaults), a weight of 3. */
function full(): VoxelKit {
  return {
    gameData: { sound: { step: 'wood-step' }, break: { hits: 3, debris: ['splinter', 'plank'] }, physics: null },
    trimLayout: 'detail-pieces-draft',
    // Its own damage stages (fields out of order): cracks as the engine's, a wider stage 2, no stage 3, its own crack texture.
    damage: { crackTexture: { digest: D2, assetId: 'cracks' }, stage3: null, stage2: { pieces: 4, max: 10, min: 4 }, stage1: { max: 14, min: 11 } },
    jitter: 1.5,
    slots: {
      'edge-out-top': {
        gameData: { break: { hits: 1 } },
        meshes: [
          { weight: 3, mesh: { node: 'Edge_A', digest: D1, assetId: 'log-kit' } },
          { rotation: 0, weight: 1, mesh: { assetId: 'log-kit', digest: D1, node: 'Edge_B' } },
        ],
      },
      // One mesh filling another slot, turned (fields given out of order).
      'edge-out-bottom': { meshes: [{ rotation: 5, mesh: { digest: D1, assetId: 'log-kit', node: 'Edge_A' } }] },
      'corner-out-top': { meshes: [{ mesh: { assetId: 'log-kit', digest: D2 } }] },
    },
    materials: [12, 3, 4095],
    materialType: 'wood',
    version: 7,
    name: 'Log kit',
    voxelKitId: 'log',
    kitFormat: VOXEL_KIT_FORMAT,
  };
}

const problems = (v: unknown): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateVoxelKit(v, '', errors);
  return errors;
};

/** Every leaf path of a JSON value (`/a/b/0`), so a dropped field shows up by name. */
function leaves(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${at}/${i}`));
  if (typeof v === 'object' && v !== null) return Object.entries(v).flatMap(([k, x]) => leaves(x, `${at}/${k}`));
  return [at];
}

describe('voxel kit record', () => {
  it('keeps every field through the canonical form (the default weight and rotation aside), in one order however it was built, and is idempotent', () => {
    const kit = full();
    expect(problems(kit)).toEqual([]);
    const canon = canonicalVoxelKit(kit);
    const dropped = leaves(kit).filter((p) => !leaves(canon).includes(p));
    // The only leaves left out are the defaults; materials are sorted, so their values move but stay.
    expect(dropped).toEqual(['/slots/edge-out-top/meshes/1/rotation', '/slots/edge-out-top/meshes/1/weight']);
    expect(leaves(canon).length).toBe(leaves(kit).length - 2);
    expect(JSON.stringify(canon)).toBe(
      JSON.stringify({
        kitFormat: 1,
        voxelKitId: 'log',
        name: 'Log kit',
        version: 7,
        materialType: 'wood',
        materials: [3, 12, 4095],
        slots: {
          'corner-out-top': { meshes: [{ mesh: { assetId: 'log-kit', digest: D2 } }] },
          'edge-out-bottom': { meshes: [{ mesh: { assetId: 'log-kit', digest: D1, node: 'Edge_A' }, rotation: 5 }] },
          'edge-out-top': {
            meshes: [{ mesh: { assetId: 'log-kit', digest: D1, node: 'Edge_A' }, weight: 3 }, { mesh: { assetId: 'log-kit', digest: D1, node: 'Edge_B' } }],
            gameData: { break: { hits: 1 } },
          },
        },
        jitter: 1.5,
        trimLayout: 'detail-pieces-draft',
        damage: { stage1: { min: 11, max: 14 }, stage2: { min: 4, max: 10, pieces: 4 }, stage3: null, crackTexture: { assetId: 'cracks', digest: D2 } },
        gameData: { break: { debris: ['splinter', 'plank'], hits: 3 }, physics: null, sound: { step: 'wood-step' } },
      }),
    );
    expect(JSON.stringify(canonicalVoxelKit(canon))).toBe(JSON.stringify(canon));
    expect(problems(canon)).toEqual([]);
    // A jitter of 1 is the default: left out.
    expect(canonicalVoxelKit({ ...kit, jitter: 1 }).jitter).toBeUndefined();
    // The canonical form is a copy: changing it leaves the kit it came from as it was.
    (canon.slots['edge-out-top']!.gameData as { break: { hits: number } }).break.hits = 9;
    expect((kit.slots['edge-out-top']!.gameData as { break: { hits: number } }).break.hits).toBe(1);
  });

  it('an empty kit (no slot filled) is valid: every edge stays a plain voxel edge', () => {
    const { slots: _, ...rest } = full();
    expect(problems({ ...rest, slots: {} })).toEqual([]);
  });

  it('game data passes through as given: values, list order and nesting kept, only object keys sorted', () => {
    const data = { z: [3, 1, 2, { b: true, a: 'x' }], a: -0.5, m: { deep: { er: [null, 'é', 1e21] } } };
    const kit = { ...full(), gameData: data, slots: { c: { meshes: [{ mesh: { assetId: 'log-kit', digest: D1 } }], gameData: [data, 'two'] } } };
    const canon = canonicalVoxelKit(kit);
    expect(canon.gameData).toEqual(data);
    expect(Object.keys(canon.gameData as object)).toEqual(['a', 'm', 'z']);
    expect(canon.slots['c']!.gameData).toEqual([data, 'two']);
  });

  it('refuses a newer format whole, and a missing or wrong one', () => {
    const newer = problems({ ...full(), kitFormat: VOXEL_KIT_FORMAT + 1, someFutureField: 1 });
    // Only the format is reported: a newer kit is never read in part.
    expect(newer).toHaveLength(1);
    expect(newer[0]).toMatchObject({ code: 'kit_format_unsupported', path: '/kitFormat' });
    const { kitFormat: _, ...missing } = full();
    expect(problems(missing)[0]).toMatchObject({ code: 'field_missing', path: '/kitFormat' });
    for (const f of [0, '1', 1.5, null]) expect(problems({ ...full(), kitFormat: f })[0], String(f)).toMatchObject({ code: 'field_value', path: '/kitFormat' });
  });

  it('refuses unknown fields at every level, the draft fields slots replaced among them', () => {
    const at = (mutate: (k: Record<string, any>) => void): string[] => {
      const k = JSON.parse(JSON.stringify(full())) as Record<string, any>;
      mutate(k);
      return problems(k).map((e) => `${e.code} ${e.path}`);
    };
    expect(at((k) => (k['pieces'] = {}))).toEqual(['field_unexpected /pieces']);
    // Cases with run sections and join profiles were the slots' draft: no field of the format now.
    expect(at((k) => (k['cases'] = {}))).toEqual(['field_unexpected /cases']);
    expect(at((k) => (k['joinProfiles'] = {}))).toEqual(['field_unexpected /joinProfiles']);
    expect(at((k) => (k['slots']['corner-out-top']['sections'] = {}))).toEqual(['field_unexpected /slots/corner-out-top/sections']);
    expect(at((k) => (k['slots']['corner-out-top']['alias'] = { case: 'edge-out-top', rotation: 1 }))).toEqual(['field_unexpected /slots/corner-out-top/alias']);
    expect(at((k) => (k['slots']['corner-out-top']['meshes'][0]['mirror'] = true))).toEqual(['field_unexpected /slots/corner-out-top/meshes/0/mirror']);
    // One mesh a piece (pieces are drawn in the near ring only): a lower-detail mesh is no field of the format.
    expect(at((k) => (k['slots']['corner-out-top']['meshes'][0]['low'] = { assetId: 'log-kit', digest: D1 }))).toEqual(['field_unexpected /slots/corner-out-top/meshes/0/low']);
    expect(at((k) => (k['slots']['corner-out-top']['meshes'][0]['high'] = { assetId: 'log-kit', digest: D1 }))).toEqual(['field_unexpected /slots/corner-out-top/meshes/0/high']);
    expect(at((k) => (k['slots']['corner-out-top']['meshes'][0]['mesh']['url'] = 'x'))).toEqual(['field_unexpected /slots/corner-out-top/meshes/0/mesh/url']);
  });

  it('refuses bad values with the path of each', () => {
    const at = (mutate: (k: Record<string, any>) => void): string[] => {
      const k = JSON.parse(JSON.stringify(full())) as Record<string, any>;
      mutate(k);
      return problems(k).map((e) => `${e.code} ${e.path}`);
    };
    const m0 = (k: Record<string, any>): Record<string, any> => k['slots']['corner-out-top']['meshes'][0];
    expect(at((k) => (k['voxelKitId'] = 'Log Kit'))).toEqual(['id_invalid /voxelKitId']);
    expect(at((k) => (k['name'] = ''))).toEqual(['field_value /name']);
    for (const v of [0, 1.5, '2']) expect(at((k) => (k['version'] = v))).toEqual(['field_value /version']);
    expect(at((k) => delete k['materialType'])).toEqual(['id_invalid /materialType']);
    expect(at((k) => (k['materials'] = [0, MATERIAL_ID_MAX + 1, 2.5, 3, 3]))).toEqual(['field_value /materials/0', 'field_value /materials/1', 'field_value /materials/2', 'id_duplicate /materials/4']);
    expect(at((k) => delete k['slots'])).toEqual(['field_missing /slots']);
    expect(at((k) => (k['slots'] = []))).toEqual(['field_type /slots']);
    expect(at((k) => (k['slots']['Bad Case'] = { meshes: [{ mesh: { assetId: 'log-kit', digest: D1 } }] }))).toEqual(['id_invalid /slots/Bad Case']);
    // An empty slot is not stored: it is left out.
    expect(at((k) => (k['slots']['corner-out-top']['meshes'] = []))).toEqual(['field_value /slots/corner-out-top/meshes']);
    expect(at((k) => delete m0(k)['mesh'])).toEqual(['field_type /slots/corner-out-top/meshes/0/mesh']);
    expect(at((k) => (m0(k)['mesh']['digest'] = 'A'.repeat(64)))).toEqual(['digest_invalid /slots/corner-out-top/meshes/0/mesh/digest']);
    for (const w of [0, -1, VOXEL_KIT_LIMITS.weightMax + 1, Number.NaN]) expect(at((k) => (m0(k)['weight'] = w))).toEqual(['field_value /slots/corner-out-top/meshes/0/weight']);
    for (const r of [24, -1, 1.5, '3']) expect(at((k) => (m0(k)['rotation'] = r)), String(r)).toEqual(['field_value /slots/corner-out-top/meshes/0/rotation']);
    expect(at((k) => (m0(k)['rotation'] = 23))).toEqual([]);
    for (const j of [-0.1, VOXEL_KIT_LIMITS.jitterMax + 0.5, Number.NaN, '1']) expect(at((k) => (k['jitter'] = j)), String(j)).toEqual(['field_value /jitter']);
    for (const j of [0, VOXEL_KIT_LIMITS.jitterMax]) expect(at((k) => (k['jitter'] = j))).toEqual([]);
    expect(at((k) => (k['trimLayout'] = 'Draft 1'))).toEqual(['id_invalid /trimLayout']);
    // Damage stages: ranges within 1-14 and in order, no two stages sharing an integrity, pieces only for stages 2-3.
    expect(at((k) => (k['damage']['stage1'] = { min: 12, max: 15 }))).toEqual(['field_value /damage']);
    expect(at((k) => (k['damage']['stage1'] = { min: 13, max: 12 }))).toEqual(['field_value /damage']);
    expect(at((k) => (k['damage']['stage1'] = { min: 9, max: 14 }))).toEqual(['field_value /damage']);
    expect(at((k) => (k['damage']['stage1'] = { min: 11, max: 14, pieces: 2 }))).toEqual(['field_value /damage']);
    for (const p of [0, 17, 2.5]) expect(at((k) => (k['damage']['stage2']['pieces'] = p)), String(p)).toEqual(['field_value /damage']);
    expect(at((k) => (k['damage']['stage3'] = { min: 1, max: 3 }))).toEqual([]);
    expect(at((k) => (k['damage']['stage2']['count'] = 2))).toEqual(['field_unexpected /damage/stage2/count']);
    expect(at((k) => (k['damage']['stage4'] = null))).toEqual(['field_unexpected /damage/stage4']);
    expect(at((k) => (k['damage']['stage2'] = 6))).toEqual(['field_type /damage/stage2']);
    expect(at((k) => (k['damage']['crackTexture']['digest'] = 'x'))).toEqual(['digest_invalid /damage/crackTexture/digest']);
    expect(at((k) => (k['damage'] = {}))).toEqual([]);
    // An empty damage object is the engine's stages: left out of the canonical form.
    expect(canonicalVoxelKit({ ...full(), damage: {} }).damage).toBeUndefined();
  });

  it('refuses game data that is not JSON or nests past the bound', () => {
    let deep: unknown = 1;
    for (let i = 0; i < VOXEL_KIT_LIMITS.gameDataDepth + 1; i++) deep = [deep];
    let edge: unknown = 1;
    for (let i = 0; i < VOXEL_KIT_LIMITS.gameDataDepth; i++) edge = [edge];
    expect(problems({ ...full(), gameData: edge })).toEqual([]);
    for (const bad of [deep, Number.POSITIVE_INFINITY, { f: () => 1 }, new Date(0), { u: undefined }]) {
      expect(problems({ ...full(), gameData: bad }).map((e) => e.path)).toEqual(['/gameData']);
      expect(problems({ ...full(), slots: { c: { meshes: [{ mesh: { assetId: 'log-kit', digest: D1 } }], gameData: bad } } }).map((e) => e.path)).toEqual(['/slots/c/gameData']);
    }
  });

  it('a list of kits: ids once, sorted by id in canonical form', () => {
    const a = { ...full(), voxelKitId: 'stone', materialType: 'stone' };
    const b = full();
    const errors: ModelErrorV2[] = [];
    validateVoxelKits([a, b, b], '/voxelKits', errors);
    expect(errors.map((e) => `${e.code} ${e.path}`)).toEqual(['id_duplicate /voxelKits/2/voxelKitId']);
    expect(canonicalVoxelKits([a, b]).map((k) => k.voxelKitId)).toEqual(['log', 'stone']);
  });

  it("a build's catalog block takes kits that validate and names the first problem of one that does not", () => {
    expect(catalogBlockProblem('voxelKits', canonicalVoxelKits([full()]))).toBeNull();
    expect(catalogBlockProblem('voxelKits', [{ ...full(), kitFormat: 2 }])).toMatch(/voxelKits: kit format 2 is newer/);
    expect(catalogBlockProblem('voxelKits', {})).toMatch(/voxelKits is a list/);
  });
});

describe('the models a build ships for kit meshes', () => {
  const D = (n: number): string => n.toString(16).padStart(64, '0');
  const kit = (id: string, digest: string): VoxelKit => ({ kitFormat: VOXEL_KIT_FORMAT, voxelKitId: id, name: id, version: 1, materialType: 'wood', slots: { 'edge-out-top': { meshes: [{ mesh: { assetId: 'crate', digest } }] } } });
  // Two versions kept (a reimport keeps an older one only while something names it): v1 the mesh's, v2 current.
  const crate = { assetId: 'crate', kind: 'model', currentVersion: 2, versions: [{ version: 1, sourceDigest: D(1) }, { version: 2, sourceDigest: D(2) }] };
  const refs = (entities: unknown[], kits: VoxelKit[]): ReturnType<typeof collectAssetRefsV3> => collectAssetRefsV3({ schemaVersion: 3, sceneId: 'main', revision: 1, entities } as never, { assets: [crate], behaviors: [], prefabs: [], voxelKits: kits } as never, []);

  it("pins the version a mesh's digest names only for a model nothing else uses, and never moves another reference off its version", () => {
    expect(refs([], [kit('log', D(1))])).toEqual([{ assetId: 'crate', version: 1 }]);
    // A scene places the model: its current version ships, and the kit draws it too (one version an asset).
    expect(refs([{ id: 'e-1', components: { model: { asset: { assetId: 'crate' } } } }], [kit('log', D(1))])).toEqual([{ assetId: 'crate', version: null }]);
    // Two meshes naming two versions: the first decides.
    expect(refs([], [kit('a', D(2)), kit('b', D(1))])).toEqual([{ assetId: 'crate', version: 2 }]);
    // A digest no version has: the current one.
    expect(refs([], [kit('log', D(9))])).toEqual([{ assetId: 'crate', version: null }]);
  });

  it('ships a kit\'s crack texture the same way (the version its digest names)', () => {
    const cracks = { assetId: 'cracks', kind: 'texture', currentVersion: 2, versions: [{ version: 1, sourceDigest: D(5) }, { version: 2, sourceDigest: D(6) }] };
    const withCracks: VoxelKit = { ...kit('log', D(1)), damage: { crackTexture: { assetId: 'cracks', digest: D(5) } } };
    const got = collectAssetRefsV3({ schemaVersion: 3, sceneId: 'main', revision: 1, entities: [] } as never, { assets: [crate, cracks], behaviors: [], prefabs: [], voxelKits: [withCracks] } as never, []);
    expect(got).toEqual([{ assetId: 'cracks', version: 1 }, { assetId: 'crate', version: 1 }]);
  });
});

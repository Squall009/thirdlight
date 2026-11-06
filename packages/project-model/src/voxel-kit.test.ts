/**
 * The voxel kit record: its canonical form keeps every field (a field the
 * canonicalizer forgot would be dropped silently), in one order however it
 * was built; a newer format, unknown fields and bad values are refused; the
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

/** Every field set, maps and lists out of order, a weight of 1 (the default) and of 3. */
function full(): VoxelKit {
  return {
    gameData: { sound: { step: 'wood-step' }, break: { hits: 3, debris: ['splinter', 'plank'] }, physics: null },
    trimLayout: 'detail-pieces-draft',
    joinProfiles: { round: { outline: [[8, 0], [16, 8], [8, 16], [0, 8]] }, beam: { outline: [[4, 4], [12, 4], [12, 12], [4, 12]] } },
    cases: {
      'wall-banister': {
        gameData: { break: { hits: 1 } },
        sections: {
          termination: { variants: [{ high: { assetId: 'log-kit', digest: D1, node: 'Rail_End' } }] },
          body: {
            ends: { end: 'round', start: 'round' },
            variants: [
              { weight: 3, high: { node: 'Rail_Body_A', digest: D1, assetId: 'log-kit' } },
              { weight: 1, high: { assetId: 'log-kit', digest: D1, node: 'Rail_Body_B' } },
            ],
          },
        },
      },
      'beam-corner': { sections: { corner: { variants: [{ high: { assetId: 'log-kit', digest: D2 } }], ends: { start: 'beam' } } } },
      // Drawn by another case's meshes turned (fields given out of order).
      'beam-end': { gameData: { break: { hits: 2 } }, alias: { rotation: 5, case: 'beam-corner' } },
      // Data only: no pieces of its own (the fallback kit draws the case).
      'floor-edge': { gameData: 'creaky' },
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
  it('keeps every field through the canonical form (the weight of 1 aside), in one order however it was built, and is idempotent', () => {
    const kit = full();
    expect(problems(kit)).toEqual([]);
    const canon = canonicalVoxelKit(kit);
    const dropped = leaves(kit).filter((p) => !leaves(canon).includes(p));
    // The only leaf left out is the default weight; materials are sorted, so their values move but stay.
    expect(dropped).toEqual(['/cases/wall-banister/sections/body/variants/1/weight']);
    expect(leaves(canon).length).toBe(leaves(kit).length - 1);
    expect(JSON.stringify(canon)).toBe(
      JSON.stringify({
        kitFormat: 1,
        voxelKitId: 'log',
        name: 'Log kit',
        version: 7,
        materialType: 'wood',
        materials: [3, 12, 4095],
        cases: {
          'beam-corner': { sections: { corner: { variants: [{ high: { assetId: 'log-kit', digest: D2 } }], ends: { start: 'beam' } } } },
          'beam-end': { alias: { case: 'beam-corner', rotation: 5 }, gameData: { break: { hits: 2 } } },
          'floor-edge': { gameData: 'creaky' },
          'wall-banister': {
            sections: {
              body: {
                variants: [
                  { high: { assetId: 'log-kit', digest: D1, node: 'Rail_Body_A' }, weight: 3 },
                  { high: { assetId: 'log-kit', digest: D1, node: 'Rail_Body_B' } },
                ],
                ends: { start: 'round', end: 'round' },
              },
              termination: { variants: [{ high: { assetId: 'log-kit', digest: D1, node: 'Rail_End' } }] },
            },
            gameData: { break: { hits: 1 } },
          },
        },
        joinProfiles: { beam: { outline: [[4, 4], [12, 4], [12, 12], [4, 12]] }, round: { outline: [[8, 0], [16, 8], [8, 16], [0, 8]] } },
        trimLayout: 'detail-pieces-draft',
        gameData: { break: { debris: ['splinter', 'plank'], hits: 3 }, physics: null, sound: { step: 'wood-step' } },
      }),
    );
    expect(JSON.stringify(canonicalVoxelKit(canon))).toBe(JSON.stringify(canon));
    expect(problems(canon)).toEqual([]);
    // The canonical form is a copy: changing it leaves the kit it came from as it was.
    (canon.cases['wall-banister']!.gameData as { break: { hits: number } }).break.hits = 9;
    expect((kit.cases['wall-banister']!.gameData as { break: { hits: number } }).break.hits).toBe(1);
  });

  it('game data passes through as given: values, list order and nesting kept, only object keys sorted', () => {
    const data = { z: [3, 1, 2, { b: true, a: 'x' }], a: -0.5, m: { deep: { er: [null, 'é', 1e21] } } };
    const kit = { ...full(), gameData: data, cases: { c: { gameData: [data, 'two'] } } };
    const canon = canonicalVoxelKit(kit);
    expect(canon.gameData).toEqual(data);
    expect(Object.keys(canon.gameData as object)).toEqual(['a', 'm', 'z']);
    expect(canon.cases['c']!.gameData).toEqual([data, 'two']);
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

  it('refuses unknown fields at every level', () => {
    const at = (mutate: (k: Record<string, any>) => void): string[] => {
      const k = JSON.parse(JSON.stringify(full())) as Record<string, any>;
      mutate(k);
      return problems(k).map((e) => `${e.code} ${e.path}`);
    };
    expect(at((k) => (k['pieces'] = {}))).toEqual(['field_unexpected /pieces']);
    expect(at((k) => (k['cases']['beam-corner']['collision'] = 'box'))).toEqual(['field_unexpected /cases/beam-corner/collision']);
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['mirror'] = true))).toEqual(['field_unexpected /cases/beam-corner/sections/corner/mirror']);
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['variants'][0]['mid'] = {}))).toEqual(['field_unexpected /cases/beam-corner/sections/corner/variants/0/mid']);
    // One mesh a piece (pieces are drawn in the near ring only): a lower-detail mesh is no field of the format.
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['variants'][0]['low'] = { assetId: 'log-kit', digest: D1 }))).toEqual(['field_unexpected /cases/beam-corner/sections/corner/variants/0/low']);
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['variants'][0]['high']['url'] = 'x'))).toEqual(['field_unexpected /cases/beam-corner/sections/corner/variants/0/high/url']);
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['ends']['middle'] = 'beam'))).toEqual(['field_unexpected /cases/beam-corner/sections/corner/ends/middle']);
    expect(at((k) => (k['joinProfiles']['beam']['holes'] = []))).toEqual(['field_unexpected /joinProfiles/beam/holes']);
  });

  it('refuses bad values with the path of each', () => {
    const at = (mutate: (k: Record<string, any>) => void): string[] => {
      const k = JSON.parse(JSON.stringify(full())) as Record<string, any>;
      mutate(k);
      return problems(k).map((e) => `${e.code} ${e.path}`);
    };
    expect(at((k) => (k['voxelKitId'] = 'Log Kit'))).toEqual(['id_invalid /voxelKitId']);
    expect(at((k) => (k['name'] = ''))).toEqual(['field_value /name']);
    for (const v of [0, 1.5, '2']) expect(at((k) => (k['version'] = v))).toEqual(['field_value /version']);
    expect(at((k) => delete k['materialType'])).toEqual(['id_invalid /materialType']);
    expect(at((k) => (k['materials'] = [0, MATERIAL_ID_MAX + 1, 2.5, 3, 3]))).toEqual(['field_value /materials/0', 'field_value /materials/1', 'field_value /materials/2', 'id_duplicate /materials/4']);
    expect(at((k) => delete k['cases'])).toEqual(['field_type /cases']);
    expect(at((k) => (k['cases']['Bad Case'] = {}))).toEqual(['id_invalid /cases/Bad Case']);
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['variants'] = []))).toEqual(['field_value /cases/beam-corner/sections/corner/variants']);
    expect(at((k) => delete k['cases']['beam-corner']['sections']['corner']['variants'][0]['high'])).toEqual(['field_type /cases/beam-corner/sections/corner/variants/0/high']);
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['variants'][0]['high']['digest'] = 'A'.repeat(64)))).toEqual(['digest_invalid /cases/beam-corner/sections/corner/variants/0/high/digest']);
    for (const w of [0, -1, VOXEL_KIT_LIMITS.weightMax + 1, Number.NaN]) expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['variants'][0]['weight'] = w))).toEqual(['field_value /cases/beam-corner/sections/corner/variants/0/weight']);
    // A section end names a profile the kit has.
    expect(at((k) => (k['cases']['beam-corner']['sections']['corner']['ends']['end'] = 'square'))).toEqual(['reference_missing /cases/beam-corner/sections/corner/ends/end']);
    expect(at((k) => (k['joinProfiles']['beam']['outline'] = [[0, 0], [16, 16]]))).toEqual(['field_value /joinProfiles/beam/outline']);
    expect(at((k) => (k['joinProfiles']['beam']['outline'][1] = [17, 4]))).toEqual(['field_value /joinProfiles/beam/outline/1']);
    expect(at((k) => (k['joinProfiles']['beam']['outline'][1] = [4.5, 4]))).toEqual(['field_value /joinProfiles/beam/outline/1']);
    expect(at((k) => (k['trimLayout'] = 'Draft 1'))).toEqual(['id_invalid /trimLayout']);
  });

  it('refuses an alias that is not one: sections beside it, a rotation off the 24, a missing, self or chained target, unknown fields', () => {
    const withCase = (c: unknown): VoxelKit => {
      const k = full();
      (k.cases as Record<string, unknown>)['beam-end'] = c;
      return k;
    };
    const codes = (c: unknown): string[] => problems(withCase(c)).map((e) => `${e.code} ${e.path}`);
    const section = { body: { variants: [{ high: { assetId: 'log-kit', digest: D1 } }] } };
    expect(codes({ alias: { case: 'beam-corner', rotation: 23 } })).toEqual([]);
    expect(codes({ alias: { case: 'beam-corner', rotation: 0 }, sections: section })).toEqual(['field_value /cases/beam-end/alias']);
    for (const r of [24, -1, 1.5, '3']) expect(codes({ alias: { case: 'beam-corner', rotation: r } }), String(r)).toEqual(['field_value /cases/beam-end/alias/rotation']);
    expect(codes({ alias: { case: 'no-such-case', rotation: 0 } })).toEqual(['reference_missing /cases/beam-end/alias/case']);
    expect(codes({ alias: { case: 'beam-end', rotation: 0 } })).toEqual(['field_value /cases/beam-end/alias/case']);
    // A case with data only, or itself an alias, has no meshes to lend.
    expect(codes({ alias: { case: 'floor-edge', rotation: 0 } })).toEqual(['reference_missing /cases/beam-end/alias/case']);
    expect(codes({ alias: { case: 'Bad Id', rotation: 0 } })[0]).toBe('id_invalid /cases/beam-end/alias/case');
    expect(codes({ alias: { case: 'beam-corner', rotation: 0, mirror: true } })).toEqual(['field_unexpected /cases/beam-end/alias/mirror']);
    expect(codes({ alias: 'beam-corner' })).toEqual(['field_type /cases/beam-end/alias']);
    const chained = withCase({ alias: { case: 'beam-corner', rotation: 1 } });
    (chained.cases as Record<string, unknown>)['beam-tip'] = { alias: { case: 'beam-end', rotation: 2 } };
    expect(problems(chained).map((e) => `${e.code} ${e.path}`)).toEqual(['reference_missing /cases/beam-tip/alias/case']);
  });

  it('refuses game data that is not JSON or nests past the bound', () => {
    let deep: unknown = 1;
    for (let i = 0; i < VOXEL_KIT_LIMITS.gameDataDepth + 1; i++) deep = [deep];
    let edge: unknown = 1;
    for (let i = 0; i < VOXEL_KIT_LIMITS.gameDataDepth; i++) edge = [edge];
    expect(problems({ ...full(), gameData: edge })).toEqual([]);
    for (const bad of [deep, Number.POSITIVE_INFINITY, { f: () => 1 }, new Date(0), { u: undefined }]) {
      expect(problems({ ...full(), gameData: bad }).map((e) => e.path)).toEqual(['/gameData']);
      expect(problems({ ...full(), cases: { c: { gameData: bad } } }).map((e) => e.path)).toEqual(['/cases/c/gameData']);
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
  const kit = (id: string, digest: string): VoxelKit => ({ kitFormat: VOXEL_KIT_FORMAT, voxelKitId: id, name: id, version: 1, materialType: 'wood', cases: { beam: { sections: { body: { variants: [{ high: { assetId: 'crate', digest } }] } } } } });
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
});
